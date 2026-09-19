/**
 * The production operation runtime: where the contracts stop being paperwork.
 *
 * op-registry / op-transaction / op-semantics / op-resolution were standalone
 * primitives with contract tests. Nothing called them, so a real proposal apply
 * still had no durable manifest, no recovery and no resolution path. This module
 * is the seam that wires them into every mutating path:
 *
 *   - one durable manifest per operation, advanced tmp->rename->fsync
 *   - an append-only `.ops/<opId>/events.jsonl` beside it (the audit record;
 *     the manifest itself is a monotonic snapshot, plan 0I.5)
 *   - central per-resource locks taken in a fixed order (plan 0J.6)
 *   - semantic + cross-manifest validation INSIDE the claim, not only offline
 *     (plan A95(4): an offline-only validator protects nobody at runtime)
 *   - commit markers published together with the asset, so recovery decides
 *     from op ownership rather than from a content hash a human may have edited
 *   - CONFLICT/PARTIAL is not a dead end: resolve() is the operator's exit
 *
 * Nothing here auto-continues an interrupted operation on its own initiative.
 * reconcile() classifies and reports; only provably-orphaned locks are released.
 */

import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fsyncDir, fsyncFile, FSYNC_NOT_WRITABLE } from './fsync.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { OpRegistry } from './op-registry.js';
import { ClaimRegistry, Wal } from './op-transaction.js';
import { validateSemantics, TERMINALS, isObj } from './op-semantics.js';
import {
  validateResolutionAgainstTarget, checkResolutionCas, canonicalConflictHash,
  resolvedPhaseFor, authorizationAfterResolution, RESOLVABLE_PHASES,
} from './op-resolution.js';

/** Published inside a committed asset so recovery can prove who wrote it. */
export const MARKER_NAME = '.evolve-op-commit.json';
export const OP_SCHEMA_VERSION = 1;

const nowIso = () => new Date().toISOString();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Short, lowercase, NAME_RE-safe hash (base36 of FNV-1a). */
export function shortOpHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).slice(0, 6).padEnd(6, '0');
}

export { fsyncDir, fsyncFile };

/**
 * fsync an entire tree: every regular file first, then every directory from the
 * leaves up. Writing the marker LAST is what makes "the marker exists" imply "the
 * tree is complete" (plan 0K.6) -- that ordering, not the success of every
 * individual fsync, is the property recovery depends on.
 *
 * Returns { unsynced, unsupported }:
 *
 *   unsynced     files whose flush failed because the FILE is not writable
 *                (0444 / attrib +R). Reported so a caller can name them.
 *   unsupported  files the platform declined to flush at all.
 *
 * There is deliberately NO `ok` field. v0.6.3 returned one that was always true --
 * a field named `ok` invites `if (!result.ok) abort`, which would then never fire.
 * Real failures (ENOSPC, EIO) are thrown by fsync.js and never reach a return value,
 * so a caller deciding whether to abort must look at the two lists by name.
 *
 * v0.6.0 had no return value and swallowed every refusal, so on Windows this
 * flushed NOTHING while callers published markers claiming otherwise. v0.6.2
 * over-corrected: it folded both refusal kinds into one `ok:false` and made a
 * single read-only file abort the entire publish. Both facts are now reportable
 * separately, and the abort decision belongs to the caller.
 */
export function fsyncTree(root) {
  const unsynced = [];
  const unsupported = [];
  // Every outcome fsync.js actually produced, so the publish layer can decide policy
  // by outcome name instead of re-deriving it from which list a path landed in. An
  // outcome fsync.js grows later shows up here unclassified rather than silently
  // folded into `unsupported` (plan v0.7.0 step 0).
  const outcomes = new Set();
  if (!existsSync(root)) return { unsynced, unsupported, outcomes: [] };
  const dirs = [];
  const walk = (dir) => {
    dirs.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      const r = fsyncFile(full);
      outcomes.add(r.outcome);
      if (r.ok) continue;
      if (r.outcome === FSYNC_NOT_WRITABLE) unsynced.push(full);
      else unsupported.push(full);
    }
  };
  walk(root);
  for (const dir of dirs.reverse()) outcomes.add(fsyncDir(dir).outcome);
  return { unsynced, unsupported, outcomes: [...outcomes] };
}

/**
 * Content hash of a skill tree: relative paths + bytes, sorted, with the commit
 * marker permanently excluded.
 *
 * The exclusion is load-bearing, not cosmetic: publishing a marker must not
 * change the hash, or every legal archive/restore would look like third-party
 * tampering (plan 0L.2). scripts/schema/test_tree_hash_regression.py is the
 * cross-language proof of exactly this property.
 */
export function treeHash(root, { excludeMarker = true } = {}) {
  const h = createHash('sha256');
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        if (excludeMarker && entry.name === MARKER_NAME) continue;
        entries.push([relative(root, full).split(sep).join('/'), full]);
      }
    }
  };
  walk(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [rel, full] of entries) {
    h.update(rel, 'utf8');
    h.update('\0');
    h.update(readFileSync(full));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Write the commit marker LAST, then fsync both it and its directory entry. */
export function writeMarker(dir, marker) {
  const file = join(dir, MARKER_NAME);
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, `${JSON.stringify(marker, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // The bytes being durable is not enough: without the directory entry a crash
  // can leave the marker "absent", so recovery must see it or not see it as a
  // whole (plan 0L.8).
  fsyncDir(dir);
}

export function readMarker(dir) {
  const file = join(dir, MARKER_NAME);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { corrupt: true }; }
}
/**
 * Surface a degraded publish in the reconcile verdict.
 *
 * publish-protocols stamps `durability: 'partial' | 'platform-limited'` on the marker
 * when some file could not be flushed. v0.6.3 wrote that field and nothing ever read
 * it, which makes it the kind of note that gets deleted by the next person tidying up
 * "unused fields" -- and it is the only durable trace that a tree was published
 * without a full flush.
 *
 * Carrying it into the verdict is only half a consumer, and until v0.7.0 the other
 * half was missing: reconcile()'s report.pending.push kept just `verdict` and
 * `reason`, so these fields were rebuilt and dropped on every pass. The comment used
 * to claim the link was finished, which is worse than silence -- it tells the next
 * maintainer there is nothing to fix. reconcile() now forwards both fields, and
 * scripts/schema/fsync-platform.test.mjs asserts that it does.
 */
function degraded(marker) {
  if (!marker?.durability) return {};
  return {
    durability: marker.durability,
    ...(marker.unflushed ? { unflushed: marker.unflushed } : {}),
  };
}


export function removeMarker(dir) {
  const file = join(dir, MARKER_NAME);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  fsyncDir(dir);
  return true;
}

/**
 * Archive directory name.
 *
 * A `<name>.2` collision suffix is illegal under the skill NAME_RE, so anything
 * archived under one could never be restored (plan 0K.1). A timestamped id is
 * legal, unique, and lets the archive keep every generation instead of the old
 * behaviour of silently deleting the previous archive of the same name.
 */
export function makeArchiveId(logicalSkillName, opId, now = Date.now()) {
  const ts = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${logicalSkillName}-${ts}-${shortOpHash(opId)}`;
}

// ── tarball inspection (rollback artifacts) ──────────────────────────────────

/**
 * List a tarball's members, refusing anything that could escape extraction.
 *
 * Absolute paths, `..` traversal, symlinks and hardlinks are rejected before a
 * single byte is written, and extraction always targets a staging directory so
 * a malicious member cannot reach the live skills root (plan 0I.3).
 */
export function inspectTarball(file, { expectRoot = null } = {}) {
  const out = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' });
  const members = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const kind = line[0];
    // `tar -tvf` renders the path last, and link members as "path -> target".
    const path = line.slice(line.indexOf(' ', line.lastIndexOf(':') + 1) + 1).trim() || line.split(/\s+/).pop();
    const name = String(path).split(' -> ')[0].trim();
    if (kind === 'l' || kind === 'h') {
      return { ok: false, reason: `tar member "${name}" is a link; refusing (extraction escape)` };
    }
    if (name.startsWith('/') || name.startsWith('~')) {
      return { ok: false, reason: `tar member "${name}" is absolute; refusing` };
    }
    if (name.split('/').includes('..')) {
      return { ok: false, reason: `tar member "${name}" traverses upward; refusing` };
    }
    if (kind !== 'd' && kind !== '-') {
      return { ok: false, reason: `tar member "${name}" has unsupported type "${kind}"` };
    }
    members.push({ path: name.replace(/\/$/, ''), type: kind === 'd' ? 'directory' : 'file' });
  }
  const roots = new Set(members.map((m) => m.path.split('/')[0]).filter(Boolean));
  if (roots.size !== 1) {
    return { ok: false, reason: `tar must contain exactly one root directory, found ${[...roots].join(', ') || 'none'}` };
  }
  if (expectRoot && !roots.has(expectRoot)) {
    return { ok: false, reason: `tar root is ${[...roots][0]}, expected ${expectRoot}` };
  }
  return { ok: true, members, root: [...roots][0] };
}

/** Describe an extracted tree the way a manifest memberManifest requires. */
export function memberManifestOf(root, prefix) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = `${prefix}/${relative(root, full).split(sep).join('/')}`;
      if (entry.isDirectory()) {
        out.push({ path: rel, type: 'directory', size: 0, mode: statSync(full).mode & 0o7777, contentHash: sha256('') });
        walk(full);
      } else if (entry.isFile()) {
        const body = readFileSync(full);
        out.push({
          path: rel, type: 'file', size: body.length,
          mode: statSync(full).mode & 0o7777, contentHash: sha256(body),
        });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Copy a backup into proposal-owned storage, hashing the bytes we actually
 * copied.
 *
 * "hash the path, then copy the path" is a TOCTOU: the file can change in
 * between and the sealed copy would not be the thing that was verified. Reading
 * once and hashing what was read closes that (plan 0K.5b/0M.6). The final link
 * is no-replace, so the same content-addressed id can never be overwritten with
 * different bytes.
 */
export function sealArtifact(sourceFile, artifactsDir, { tmpName = null } = {}) {
  mkdirSync(artifactsDir, { recursive: true });
  const body = readFileSync(sourceFile); // one read; the hash describes THESE bytes
  const artifactId = sha256(body);
  const finalPath = join(artifactsDir, `${artifactId}.tgz`);
  if (existsSync(finalPath)) {
    const existing = sha256(readFileSync(finalPath));
    if (existing !== artifactId) {
      throw new Error(`content-addressed artifact ${artifactId} already exists with different bytes; `
        + 'refusing (this indicates corruption, not a retry)');
    }
    return { artifactId, artifactPath: finalPath, reused: true };
  }
  const tmp = join(artifactsDir, tmpName ?? `.seal-${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, finalPath);
  } catch (e) {
    if (e?.code !== 'EEXIST') {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    const existing = sha256(readFileSync(finalPath));
    if (existing !== artifactId) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error(`artifact ${artifactId} exists with different bytes; refusing`);
    }
  }
  unlinkSync(tmp);
  // Deleting the temp file changed the directory entry too, so the directory
  // needs a second fsync (plan 0M.6).
  fsyncDir(artifactsDir);
  const sealed = sha256(readFileSync(finalPath));
  if (sealed !== artifactId) {
    throw new Error('sealed artifact failed re-verification after fsync');
  }
  return { artifactId, artifactPath: finalPath, reused: false };
}

// ── instance lock + boot epoch ───────────────────────────────────────────────

function processStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 22 is starttime; comm may contain spaces, so parse after ')'.
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return tail[19] ?? null; // 22nd overall field
  } catch { return null; }
}

function bootId() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return 'unknown'; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * Whole-installation lock.
 *
 * Two processes sharing one memory store would each hand out generations and
 * each believe its own view of a tombstone. Rather than pretend to support that,
 * the second instance keeps working read-only and refuses the two mutating
 * automatic paths (plan 0A.1/0K.5a).
 *
 * PID alone cannot decide "the owner died": PIDs are reused. The owner is dead
 * only if the machine rebooted, or the lock expired AND the pid is gone or now
 * belongs to a different process (plan 0L.7/0M.7).
 */
export class InstanceLock {
  constructor({ workspaceDir, ttlMs = 60 * 60 * 1000, now = () => Date.now() }) {
    this.workspaceDir = workspaceDir;
    this.ttlMs = ttlMs;
    this.now = now;
    this.instanceId = `inst_${randomUUID()}`;
    this.held = false;
  }

  get dir() { return join(this.workspaceDir, '.locks'); }

  get path() { return join(this.dir, 'instance.lock'); }

  read() {
    if (!existsSync(this.path)) return null;
    try { return JSON.parse(readFileSync(this.path, 'utf8')); } catch { return { corrupt: true }; }
  }

  ownerIsDead(owner) {
    if (!isObj(owner) || owner.corrupt) return true;
    if (owner.bootId && owner.bootId !== bootId()) return true; // rebooted; no TTL wait
    // A dead process is dead regardless of the TTL. Waiting out the TTL first
    // meant a crashed instance kept the workspace locked for the full hour, so
    // every automatic maintenance path stayed disabled until someone deleted the
    // file by hand -- and the failure is invisible, because "nothing to tidy" and
    // "not allowed to tidy" look the same from outside.
    const pid = Number(owner.pid ?? 0);
    if (!pid) return true;
    if (!pidAlive(pid)) return true;
    // The PID exists, but PIDs are recycled: if the process that holds this PID
    // started after the lock was written, it is a different process and the real
    // owner is gone. Only trust this when both tokens are readable.
    const token = processStartToken(pid);
    if (owner.processStartToken && token && owner.processStartToken !== token) return true;
    // Alive and provably the same process. The TTL alone must never take it: a
    // long-running instance that is merely busy would lose its lock to a
    // concurrent one, and then both would mutate.
    return false;
  }

  /** Returns {acquired, reason, owner}. Never steals a live lock. */
  acquire() {
    mkdirSync(this.dir, { recursive: true });
    const payload = {
      instanceId: this.instanceId, pid: process.pid,
      processStartToken: processStartToken(process.pid), bootId: bootId(),
      acquiredAt: nowIso(), acquiredAtMs: this.now(), ttlMs: this.ttlMs,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd;
      try {
        fd = openSync(this.path, 'wx');
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        const owner = this.read();
        if (owner?.instanceId === this.instanceId) { this.held = true; return { acquired: true, reason: 'reentrant' }; }
        if (!this.ownerIsDead(owner)) {
          return { acquired: false, reason: 'another live instance holds the workspace', owner };
        }
        try { unlinkSync(this.path); fsyncDir(this.dir); } catch { /* raced */ }
        continue;
      }
      try {
        writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      fsyncDir(this.dir);
      this.held = true;
      return { acquired: true, reason: 'acquired' };
    }
    return { acquired: false, reason: 'lock contended' };
  }

  release() {
    if (!this.held) return false;
    const owner = this.read();
    if (owner?.instanceId !== this.instanceId) return false;
    try { unlinkSync(this.path); fsyncDir(this.dir); } catch { /* already gone */ }
    this.held = false;
    return true;
  }
}

/**
 * Monotonic boot epoch, so a usage signal from before a restart can never be
 * mistaken for a fresh one.
 *
 * The dangerous case is a MISSING file, not a corrupt one: treating "no file" as
 * epoch 0 while tombstones already reference epoch 50 recreates the exact ABA
 * confusion the epoch exists to prevent, so it fails closed unless the store
 * genuinely has no generation stamps yet (plan 0M.5).
 */
export class BootEpoch {
  constructor({ workspaceDir, hasExistingGenerations = () => false }) {
    this.workspaceDir = workspaceDir;
    this.hasExistingGenerations = hasExistingGenerations;
    this.epoch = null;
    this.sequence = 0;
    this.status = 'uninitialized';
    this.reason = '';
  }

  get path() { return join(this.workspaceDir, '.boot-epoch'); }

  #write(epoch) {
    const body = `${JSON.stringify({ schemaVersion: 1, epoch, checksum: sha256(String(epoch)) })}\n`;
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    fsyncDir(this.workspaceDir);
  }

  /** Returns {ok, epoch, reason}. ok=false means generations stay unavailable. */
  initialize() {
    mkdirSync(this.workspaceDir, { recursive: true });
    if (!existsSync(this.path)) {
      if (this.hasExistingGenerations()) {
        this.status = 'fail-closed';
        this.reason = 'boot epoch file is missing but the store already carries generation stamps; '
          + 'rebuild it explicitly (max(bootEpoch)+1) instead of restarting at 0';
        return { ok: false, epoch: null, reason: this.reason };
      }
      this.#write(1);
      this.epoch = 1;
      this.status = 'ok';
      return { ok: true, epoch: 1, reason: 'initialized' };
    }
    let parsed;
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')); } catch {
      this.status = 'fail-closed';
      this.reason = 'boot epoch file is unreadable';
      return { ok: false, epoch: null, reason: this.reason };
    }
    const epoch = parsed?.epoch;
    const problems = [];
    if (parsed?.schemaVersion !== 1) problems.push('unknown schemaVersion');
    if (!Number.isInteger(epoch) || epoch < 1) problems.push('epoch is not a positive integer');
    if (Number.isInteger(epoch) && epoch >= Number.MAX_SAFE_INTEGER) problems.push('epoch exhausted');
    if (parsed?.checksum !== sha256(String(epoch))) problems.push('checksum mismatch');
    if (problems.length) {
      this.status = 'fail-closed';
      this.reason = `boot epoch unusable (${problems.join('; ')}); refusing to fall back to 0`;
      return { ok: false, epoch: null, reason: this.reason };
    }
    this.#write(epoch + 1);
    this.epoch = epoch + 1;
    this.status = 'ok';
    return { ok: true, epoch: this.epoch, reason: 'advanced' };
  }

  /** Explicit operator rebuild: max observed epoch + 1. */
  rebuild(maxObservedEpoch) {
    const next = Math.max(1, Number(maxObservedEpoch ?? 0) + 1);
    this.#write(next);
    this.epoch = next;
    this.status = 'ok';
    this.reason = 'rebuilt by operator';
    return { ok: true, epoch: next };
  }

  /** Next generation stamp, or null when the epoch is unusable (fail-closed). */
  next() {
    if (this.status !== 'ok' || this.epoch === null) return null;
    this.sequence += 1;
    return { bootEpoch: this.epoch, sequence: this.sequence };
  }
}

/** Order two generation stamps; a missing stamp is older than anything. */
export function generationIsNewer(candidate, baseline) {
  const c = isObj(candidate) ? candidate : null;
  const b = isObj(baseline) ? baseline : null;
  if (c === null) return false;
  if (b === null) return true;
  if (Number(c.bootEpoch ?? 0) !== Number(b.bootEpoch ?? 0)) {
    return Number(c.bootEpoch ?? 0) > Number(b.bootEpoch ?? 0);
  }
  return Number(c.sequence ?? 0) > Number(b.sequence ?? 0);
}

// ── the runtime ──────────────────────────────────────────────────────────────

/** Lock keys are namespaced so a skill and its archive never collide. */
export const lockKey = {
  skill: (name) => `skill.${name}`,
  archive: (archiveId) => `archive.${archiveId}`,
  namespace: () => 'namespace',
};

export class OperationRuntime {
  constructor({ workspaceDir, logger = { warn() {} }, now = () => Date.now() }) {
    this.workspaceDir = workspaceDir;
    this.logger = logger;
    this.now = now;
    this.registry = new OpRegistry({ workspaceDir, logger });
    this.claims = new ClaimRegistry({ workspaceDir, domain: 'skills', now });
    this.wal = new Wal({ workspaceDir, name: 'ops' });
  }

  newOpId(prefix = 'op') {
    return `${prefix}_${this.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  eventsPath(opId) { return join('.ops', opId, 'events.jsonl'); }

  /** Append-only fact log beside the snapshot; fsynced line by line. */
  appendEvent(opId, event) {
    const dir = join(this.workspaceDir, '.ops', opId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'events.jsonl');
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, `${JSON.stringify({ at: nowIso(), ...event })}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  readEvents(opId) {
    const file = join(this.workspaceDir, '.ops', opId, 'events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { corrupt: true, raw: l.slice(0, 120) }; }
    });
  }

  /**
   * Create the manifest for a new operation.
   *
   * revision starts at 1 and increases on every advance, so two writers racing
   * on the same manifest are detectable rather than last-write-wins.
   */
  begin(manifest) {
    const full = {
      schemaVersion: OP_SCHEMA_VERSION,
      revision: 1,
      result: null,
      error: null,
      conflict: null,
      eventsPath: this.eventsPath(manifest.opId),
      ...manifest,
    };
    const created = this.registry.create(full);
    this.appendEvent(full.opId, { event: 'begin', phase: created.phase, kind: created.kind });
    return created;
  }

  advance(opId, patch) {
    const current = this.registry.read(opId);
    if (current === null) throw new Error(`cannot advance ${opId}: no manifest`);
    if (patch.expectRevision !== undefined && patch.expectRevision !== current.revision) {
      throw new Error(`revision CAS failed on ${opId}: expected ${patch.expectRevision}, `
        + `manifest is at ${current.revision}`);
    }
    const { expectRevision, ...rest } = patch;
    const next = this.registry.advance(opId, { ...rest, revision: current.revision + 1 });
    this.appendEvent(opId, { event: 'advance', phase: next.phase, revision: next.revision });
    return next;
  }

  read(opId) { return this.registry.read(opId); }

  /** Idempotent replay: a finished op returns its recorded receipt, no re-run. */
  completedReceipt(opId) {
    const m = this.registry.read(opId);
    if (m === null) return null;
    if (m.phase === 'COMPLETE' || m.phase === 'RESOLVED_ROLLED_FORWARD') {
      return m.result?.receipt ?? null;
    }
    return null;
  }

  complete(opId, receipt, { outcome = 'ok' } = {}) {
    return this.advance(opId, {
      phase: 'COMPLETE',
      result: { outcome, receipt, completedAt: nowIso() },
      error: null,
      conflict: null,
    });
  }

  fail(opId, message, detail = {}) {
    return this.advance(opId, {
      phase: 'FAILED',
      error: { code: detail.code ?? 'EFAILED', message: String(message).slice(0, 500), at: nowIso() },
      result: null,
      conflict: null,
    });
  }

  abort(opId, message) {
    this.appendEvent(opId, { event: 'abort', message: String(message).slice(0, 300) });
    return this.advance(opId, { phase: 'ABORTED', result: null, error: null, conflict: null });
  }

  /**
   * Freeze an operation for a human.
   *
   * Authorization deliberately stays 'claimed' here. Releasing it would let a
   * concurrent operation grab the same capability and mutate the same target,
   * turning "waiting for a human" into "somebody else changed it" (plan 0Q.1).
   */
  conflict(opId, diagnostics, { partial = false } = {}) {
    const conflict = {
      code: diagnostics.code ?? 'ECONFLICT',
      message: String(diagnostics.message ?? 'operation needs an operator decision').slice(0, 500),
      resources: diagnostics.resources ?? [],
      at: nowIso(),
    };
    const next = this.advance(opId, {
      phase: partial ? 'PARTIAL' : 'CONFLICT', conflict, result: null, error: null,
    });
    this.logger.warn?.(`[dsh-evolve] operation ${opId} frozen (${next.phase}): ${conflict.message}`);
    return next;
  }

  // ── locks ──────────────────────────────────────────────────────────────────

  /**
   * Run fn while holding every named resource.
   *
   * Keys are sorted before acquisition so converge, archive and rotation cannot
   * deadlock against each other, and a partial acquisition is always unwound
   * (plan 0J.6).
   */
  async withLocks(resources, opId, fn) {
    const keys = [...new Set(resources.filter(Boolean))].sort();
    const taken = [];
    try {
      for (const key of keys) {
        const got = this.claims.claim(key, opId);
        if (got.status !== 'acquired') {
          return { ok: false, status: 'retry', reason: `resource "${key}" is locked by another operation`, holder: got.holder };
        }
        taken.push(key);
      }
      return { ok: true, value: await fn() };
    } finally {
      for (const key of taken.reverse()) {
        try { this.claims.release(key, opId); } catch { /* fencing already reported */ }
      }
    }
  }

  // ── recovery ───────────────────────────────────────────────────────────────

  /**
   * Classify every unfinished operation, and quarantine unreadable manifests.
   *
   * An unreadable manifest must never be treated as absent: that would let a
   * fresh operation start over the top of one that may already have committed,
   * and a "rollback" would then overwrite a live asset (plan 0J.5 / A44).
   */
  reconcile({ skillsDir = null, archiveDir = null } = {}) {
    const report = { pending: [], recovered: [], frozen: [], orphanLocks: [], corrupt: [] };
    const opsRoot = join(this.workspaceDir, '.ops');
    if (existsSync(opsRoot)) {
      for (const opId of readdirSync(opsRoot)) {
        if (opId.startsWith('.corrupt-')) continue;
        let m;
        try {
          m = this.registry.read(opId);
        } catch (e) {
          const dest = join(opsRoot, `.corrupt-${opId}-${this.now()}`);
          try { renameSync(join(opsRoot, opId), dest); fsyncDir(opsRoot); } catch { /* leave it */ }
          report.corrupt.push({ opId, quarantinedTo: dest, error: String(e.message).slice(0, 200) });
          continue;
        }
        if (m === null) continue;
        if (m.schemaVersion !== OP_SCHEMA_VERSION) {
          report.corrupt.push({ opId, reason: `unknown schemaVersion ${m.schemaVersion}; fail-closed` });
          continue;
        }
        if (TERMINALS.has(m.phase)) {
          if (RESOLVABLE_PHASES.has(m.phase)) report.frozen.push({ opId, phase: m.phase, kind: m.kind });
          continue;
        }
        const verdict = this.classify(m, { skillsDir, archiveDir });
        // durability/unflushed come from degraded() and are the only durable trace that
        // a tree was published without a full flush. Dropping them here is what made
        // the whole chain dead: publish-protocols stamps the field, classify() carries
        // it into the verdict, and this push -- the actual consumer -- used to keep
        // only `verdict` and `reason`.
        report.pending.push({
          opId,
          phase: m.phase,
          kind: m.kind,
          verdict: verdict.verdict,
          reason: verdict.reason,
          ...(verdict.durability ? { durability: verdict.durability } : {}),
          ...(verdict.unflushed ? { unflushed: verdict.unflushed } : {}),
        });
        if (verdict.verdict === 'conflict') {
          try { this.conflict(opId, { code: 'ERECOVERY', message: verdict.reason, resources: verdict.resources ?? [] }); } catch { /* reported */ }
        }
      }
    }
    for (const orphan of this.claims.orphaned()) {
      // Only a lock whose owning operation reached a terminal is provably safe
      // to release. Expiry alone cannot distinguish "died" from "slow".
      const owner = orphan.holder?.opId;
      const m = owner ? (() => { try { return this.registry.read(owner); } catch { return null; } })() : null;
      if (m === null || TERMINALS.has(m.phase)) {
        this.claims.breakOrphan(orphan.resource);
        report.orphanLocks.push({ ...orphan, released: true });
      } else {
        report.orphanLocks.push({ ...orphan, released: false, reason: 'owning operation is still in flight' });
      }
    }
    return report;
  }

  /**
   * Did this operation commit? Decided by op ownership, never by content hash.
   *
   * A committed skill may legitimately have been edited by hand afterwards, so
   * requiring the current hash to equal expectedAfterHash would freeze the
   * bookkeeping forever and hold its evidence hostage (plan 0G.2).
   */
  classify(manifest, { skillsDir = null, archiveDir = null } = {}) {
    const opId = manifest.opId;
    const dirFor = (key) => {
      if (!key) return null;
      if (key.startsWith('archive.')) return archiveDir ? join(archiveDir, key.slice('archive.'.length)) : null;
      if (key.startsWith('skill.')) return skillsDir ? join(skillsDir, key.slice('skill.'.length)) : null;
      return key;
    };

    if (manifest.protocol === 'B') {
      const file = manifest.finalPath;
      if (!file || !existsSync(file)) {
        return { verdict: 'rollback', reason: 'target SKILL.md is absent; the rewrite never committed' };
      }
      const md = readFileSync(file, 'utf8');
      const stateMatch = /<!--dsh-evolve-state:(.*?)-->/s.exec(md);
      let state = {};
      try { state = stateMatch ? JSON.parse(stateMatch[1]) : {}; } catch { state = {}; }
      if (state.lastCommittedOpId === opId) {
        return { verdict: 'roll-forward', reason: 'the state block names this operation; the rename committed' };
      }
      if (existsSync(`${file}.tmp`)) {
        return { verdict: 'rollback', reason: 'a staged rewrite exists but was never renamed' };
      }
      return { verdict: 'rollback', reason: 'the state block does not name this operation' };
    }

    if (manifest.kind === 'move') {
      const src = dirFor(manifest.sourceKey);
      const dest = dirFor(manifest.destKey);
      const srcExists = src ? existsSync(src) : false;
      const destExists = dest ? existsSync(dest) : false;
      if (srcExists && destExists) {
        return {
          verdict: 'conflict',
          reason: 'both source and destination exist; refusing to delete either side',
          resources: [manifest.sourceKey, manifest.destKey],
        };
      }
      if (destExists) {
        const marker = readMarker(dest);
        if (marker?.opId === opId) return { verdict: 'roll-forward', reason: 'destination carries this operation marker', ...degraded(marker) };
        return {
          verdict: 'conflict',
          reason: 'destination exists without this operation marker; it belongs to someone else',
          resources: [manifest.destKey],
        };
      }
      if (srcExists) {
        return { verdict: 'rollback', reason: 'the move never happened; the source is untouched' };
      }
      return { verdict: 'conflict', reason: 'neither source nor destination exists', resources: [manifest.sourceKey] };
    }

    if (manifest.protocol === 'A' || manifest.protocol === 'C') {
      const final = manifest.finalPath;
      if (final && existsSync(final)) {
        const marker = readMarker(final);
        if (marker?.opId === opId) return { verdict: 'roll-forward', reason: 'published directory carries this operation marker', ...degraded(marker) };
        if (manifest.protocol === 'C') {
          const retired = manifest.retiredPath;
          if (retired && existsSync(retired)) {
            return { verdict: 'conflict', reason: 'both the live and retired directories exist', resources: [manifest.targetName] };
          }
        }
        return { verdict: 'conflict', reason: 'the destination exists but is not ours', resources: [manifest.targetName] };
      }
      if (manifest.protocol === 'C' && manifest.retiredPath && existsSync(manifest.retiredPath)) {
        return { verdict: 'restore-retired', reason: 'crashed between the two renames; the retired copy must go back' };
      }
      return { verdict: 'rollback', reason: 'nothing was published' };
    }

    if (manifest.kind === 'converge') {
      const target = manifest.target ?? {};
      if (target.finalPath && existsSync(target.finalPath)) {
        const marker = readMarker(target.finalPath);
        if (marker?.opId === opId) {
          return { verdict: 'roll-forward', reason: 'the umbrella carries this operation marker; finish archiving', ...degraded(marker) };
        }
        return { verdict: 'conflict', reason: 'umbrella path is occupied by a foreign directory', resources: [manifest.targetName] };
      }
      return { verdict: 'rollback', reason: 'the umbrella was never published' };
    }

    if (manifest.kind === 'create-proposal') {
      return { verdict: manifest.phase === 'RESERVED' ? 'release-reservation' : 'rollback', reason: `proposal creation stopped at ${manifest.phase}` };
    }

    return { verdict: 'report', reason: `no recovery rule for kind=${manifest.kind}` };
  }

  // ── resolution: the only exit from CONFLICT/PARTIAL ────────────────────────

  /**
   * Apply an operator decision to a frozen operation.
   *
   * Both validators run here, inside the claim, because that is the only place
   * they can protect anything: the pairing rules exist to stop a resolution
   * inventing its target's capability, receipts or diagnostics.
   *
   * `spendCapability` is a callback rather than a pre-spent claim because the
   * resolution's opId is minted HERE: a capability spent by the caller would be
   * bound to an id that does not exist yet, and the manifest's claim would name
   * the wrong operation. It is called after the id exists and before anything is
   * written, so a capability that cannot be spent aborts before any state moves.
   */
  async resolve({ frozenOpId, decision, capClaim = null, spendCapability = null, source = 'web-user', observedConflictHash }) {
    const original = this.registry.read(frozenOpId);
    if (original === null) return { ok: false, status: 404, error: 'operation-not-found' };
    if (!RESOLVABLE_PHASES.has(original.phase)) {
      return { ok: false, status: 409, error: `operation is ${original.phase}, not frozen` };
    }
    const resolutionOpId = this.newOpId('res');
    const cas = checkResolutionCas(original, resolutionOpId);
    if (!cas.ok) return { ok: false, status: 409, error: cas.code, detail: cas.detail };

    let spentClaim = capClaim;
    if (spendCapability) {
      const spent = spendCapability(resolutionOpId);
      if (!spent?.ok) {
        return { ok: false, status: spent?.code ?? 401, error: spent?.error ?? 'capability-required' };
      }
      spentClaim = spent.claim;
    }

    const releasedReceiptIds = (original.receiptClaims ?? [])
      .filter((r) => r.state === 'claimed').map((r) => r.receiptId);
    const resolution = {
      schemaVersion: OP_SCHEMA_VERSION,
      kind: 'resolution',
      opId: resolutionOpId,
      revision: 1,
      phase: 'CLAIMED',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      eventsPath: this.eventsPath(resolutionOpId),
      result: null,
      error: null,
      conflict: null,
      source,
      resolvesOpId: frozenOpId,
      resolvedKind: original.kind,
      decision,
      // The resolution's own capability is claimed BY the resolution: the caller
      // mints it before this opId exists, so the binding is stamped here rather
      // than trusted from the request.
      capClaim: isObj(spentClaim) ? { ...spentClaim, claimedByOpId: resolutionOpId } : spentClaim,
      releasedCapId: original.capClaim?.capId ?? null,
      releasedReceiptIds,
      observedConflictHash: observedConflictHash ?? canonicalConflictHash(original.conflict),
      targetName: original.targetName ?? `<no-target:${original.kind}>`,
    };

    const pairing = validateResolutionAgainstTarget(resolution, original);
    if (pairing.length) {
      return { ok: false, status: 409, error: 'resolution-does-not-match-operation', detail: pairing.slice(0, 3) };
    }
    const semantic = validateSemantics(resolution);
    if (semantic.length) {
      return { ok: false, status: 400, error: 'resolution-violates-contract', detail: semantic.slice(0, 3) };
    }

    this.begin(resolution);
    // Claim the frozen operation first: two operators must not both "resolve" it.
    this.advance(frozenOpId, { resolution: { status: 'RESOLVING', resolutionOpId, decision: null, resolvedAt: null } });
    this.advance(resolutionOpId, { phase: 'INTENT' });

    const authzState = authorizationAfterResolution(decision);
    if (!authzState) {
      this.fail(resolutionOpId, `unknown decision ${decision}`);
      this.advance(frozenOpId, { resolution: { status: 'UNRESOLVED', resolutionOpId: null, decision: null, resolvedAt: null } });
      return { ok: false, status: 400, error: 'unknown-decision' };
    }

    const phase = resolvedPhaseFor(decision);
    const patch = {
      phase,
      conflict: null,
      resolution: { status: 'RESOLVED', resolutionOpId, decision, resolvedAt: nowIso() },
    };
    if (original.capClaim) patch.capClaim = { ...original.capClaim, state: authzState };
    if (Array.isArray(original.receiptClaims)) {
      patch.receiptClaims = original.receiptClaims.map((r) => (r.state === 'claimed' ? { ...r, state: authzState } : r));
    }
    if (phase === 'RESOLVED_ROLLED_FORWARD') {
      patch.result = original.result ?? {
        outcome: 'degraded',
        completedAt: nowIso(),
        receipt: {
          opId: frozenOpId, kind: original.kind, targetName: original.targetName ?? '<unknown>',
          finalPath: original.finalPath ?? null, afterContentHash: original.expectedAfterContentHash ?? null,
          archiveId: original.archiveId ?? null,
        },
      };
    }
    this.advance(resolutionOpId, { phase: 'APPLIED' });
    this.advance(frozenOpId, patch);
    // The receipt shape is closed by the contract (opId/kind/targetName plus the
    // three optional locators); the decision itself lives in the events log.
    this.appendEvent(resolutionOpId, {
      event: 'resolved', resolvesOpId: frozenOpId, decision, authorization: authzState, phase,
    });
    // The resolution's own capability is spent by reaching COMPLETE: the decision
    // has landed, so it must not stay reusable.
    if (isObj(resolution.capClaim)) {
      this.advance(resolutionOpId, { capClaim: { ...resolution.capClaim, state: 'consumed' } });
    }
    this.complete(resolutionOpId, {
      opId: resolutionOpId, kind: 'resolution', targetName: resolution.targetName,
    });
    return { ok: true, status: 200, resolutionOpId, decision, authorization: authzState, phase };
  }

  /** Operations a human still has to decide about. */
  frozenOperations() {
    return this.registry.list()
      .filter((m) => RESOLVABLE_PHASES.has(m.phase))
      .map((m) => ({
        opId: m.opId, kind: m.kind, phase: m.phase, targetName: m.targetName ?? null,
        conflict: m.conflict ?? null, observedConflictHash: canonicalConflictHash(m.conflict),
        resolution: m.resolution ?? { status: 'UNRESOLVED' },
        updatedAt: m.updatedAt,
      }));
  }
}
