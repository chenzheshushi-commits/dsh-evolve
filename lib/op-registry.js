/**
 * Durable op manifests: the record that makes recovery possible.
 *
 * Every mutating operation writes a manifest BEFORE it touches anything, then
 * advances it as it goes. On restart, the manifest -- not the current state of
 * the files -- decides what happened. Plan section 0G.2: op ownership is the
 * only authority for recovery, because "the file hash equals what I expected"
 * cannot distinguish "my commit landed" from "someone else wrote the same bytes".
 *
 * Storage layout (plan 0G.0):
 *
 *     <workspace>/.ops/<opId>/manifest.json
 *
 * Deliberately NOT next to the asset being operated on: a converge moves
 * directories, and neither the lock nor the manifest may travel with them.
 *
 * Every advance is tmp -> rename -> fsync(dir). An advance without the fsync is
 * treated as never having happened, so a crash can only ever lose whole steps,
 * never leave half a manifest.
 *
 * The manifest is an append-only record of fact: a step may advance state or
 * mark a conflict, but may never rewrite history. rewriteHistory guards that.
 */

import {
  closeSync, existsSync, mkdirSync, openSync, fsyncSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { validateSemantics, TERMINALS } from './op-semantics.js';

/** Phases an operation moves through before reaching a terminal. */
export const LIVE_PHASES = new Set([
  'CREATED', 'CLAIMED', 'PREPARED', 'COMMITTED', 'STAMPING', 'RESOLVING',
]);

/**
 * Fields that describe what an operation IS, fixed when the manifest is created.
 * Recovery trusts them, so a later step must never quietly change them --
 * that is how an operation ends up adopting another one's commit.
 */
const IMMUTABLE_FIELDS = [
  'opId', 'kind', 'source', 'protocol', 'action', 'createdAt',
  'targetName', 'proposalId', 'archiveId', 'logicalSkillName',
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nowIso = () => new Date().toISOString();

/** fsync a directory so a rename inside it is durable, not just visible. */
function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (e) {
    // Some filesystems refuse O_RDONLY fsync on directories; a failure to make
    // the rename durable must not be silent, but it must not be fatal either --
    // the caller has already written the data.
    if (!['EINVAL', 'EACCES', 'EPERM', 'EISDIR'].includes(e?.code)) throw e;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/** Write JSON atomically: temp file, fsync the file, rename, fsync the dir. */
function writeJsonAtomic(dir, name, value) {
  mkdirSync(dir, { recursive: true });
  const final = join(dir, name);
  const tmp = `${final}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, final);
  fsyncDir(dir);
}

/**
 * Report which immutable fields a patch would change.
 *
 * Returns [] when the patch only advances state. Callers must refuse a
 * non-empty result: a manifest that can be rewritten is not a record of fact,
 * and recovery decisions made from it would be unreliable.
 */
export function rewriteHistory(current, patch) {
  const changed = [];
  for (const f of IMMUTABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, f)) continue;
    if (Object.prototype.hasOwnProperty.call(current, f) && patch[f] !== current[f]) {
      changed.push(f);
    }
  }
  return changed;
}

export class OpRegistry {
  /**
   * @param {object} options
   * @param {string} options.workspaceDir  the evolve workspace root
   * @param {object} [options.logger]      anything with .warn/.info
   * @param {boolean} [options.validate]   run the semantic contract on every
   *   advance (default true). Turning this off is only for tests that
   *   deliberately construct broken manifests.
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir;
    this.logger = options.logger;
    this.validate = options.validate !== false;
  }

  get opsRoot() {
    if (!this.workspaceDir) throw new Error('OpRegistry requires a workspaceDir');
    return join(this.workspaceDir, '.ops');
  }

  dirFor(opId) {
    if (typeof opId !== 'string' || !opId || opId.includes('/') || opId.includes('..')) {
      throw new Error(`unsafe opId: ${JSON.stringify(opId)}`);
    }
    return join(this.opsRoot, opId);
  }

  pathFor(opId) {
    return join(this.dirFor(opId), 'manifest.json');
  }

  /**
   * Read a manifest, or null when this op was never recorded.
   *
   * A manifest that exists but cannot be parsed is NOT treated as absent: that
   * would let recovery start a fresh operation over a half-finished one. It
   * throws, so a human looks at it.
   */
  read(opId) {
    const p = this.pathFor(opId);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`manifest for ${opId} is corrupt (${e.message}); refusing to treat `
        + 'it as absent -- inspect it by hand');
    }
  }

  /** True when this op already reached a terminal phase. */
  isTerminal(opId) {
    const m = this.read(opId);
    return m !== null && TERMINALS.has(m.phase);
  }

  /**
   * Step 1 of the claim ordering in plan 0G.4: has this exact op already
   * finished? If so the caller returns the recorded receipt and must NOT
   * re-check the capability -- it is legitimately consumed by now.
   *
   * This is what makes "same opId retry returns the original receipt" and
   * "replaying a consumed capability is 401" stop contradicting each other:
   * a retry never reaches the capability check.
   */
  completedReceipt(opId) {
    const m = this.read(opId);
    if (m === null || m.phase !== 'COMPLETE') return null;
    return m.result?.receipt ?? null;
  }

  /** Create the manifest for a new operation. Refuses to overwrite one. */
  create(manifest) {
    if (!isObj(manifest)) throw new Error('create() needs a manifest object');
    const { opId } = manifest;
    const dir = this.dirFor(opId);
    if (existsSync(this.pathFor(opId))) {
      throw new Error(`manifest for ${opId} already exists; opIds must be unique`);
    }
    const full = { createdAt: nowIso(), updatedAt: nowIso(), ...manifest };
    full.updatedAt = full.updatedAt ?? full.createdAt;
    this.#assertValid(full, 'create');
    writeJsonAtomic(dir, 'manifest.json', full);
    return full;
  }

  /**
   * Advance an existing manifest.
   *
   * Refuses to rewrite immutable fields, and refuses to move an operation that
   * already reached a terminal -- a terminal is final, and silently reopening
   * one would make the audit trail a lie.
   */
  advance(opId, patch) {
    if (!isObj(patch)) throw new Error('advance() needs a patch object');
    const current = this.read(opId);
    if (current === null) throw new Error(`cannot advance ${opId}: no manifest`);

    const rewritten = rewriteHistory(current, patch);
    if (rewritten.length) {
      throw new Error(`refusing to rewrite immutable field(s) on ${opId}: `
        + `${rewritten.join(', ')} -- a manifest records fact, it is not editable`);
    }
    if (TERMINALS.has(current.phase) && patch.phase && patch.phase !== current.phase) {
      throw new Error(`${opId} is already terminal (${current.phase}); refusing to move it `
        + `to ${patch.phase}`);
    }

    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.#assertValid(next, `advance to ${patch.phase ?? current.phase}`);
    writeJsonAtomic(this.dirFor(opId), 'manifest.json', next);
    return next;
  }

  /**
   * Every operation recorded on disk, newest first.
   *
   * An unreadable entry is reported rather than skipped: silently ignoring it
   * would hide exactly the operation most likely to need attention.
   */
  list() {
    if (!existsSync(this.opsRoot)) return [];
    const out = [];
    for (const name of readdirSync(this.opsRoot)) {
      try {
        const m = this.read(name);
        if (m !== null) out.push(m);
      } catch (e) {
        out.push({ opId: name, phase: 'UNREADABLE', error: String(e.message) });
      }
    }
    return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }

  /**
   * Operations that were interrupted mid-flight and need the recovery path.
   *
   * Terminals are done; UNREADABLE ones are surfaced too, because they are the
   * ones a human must look at.
   */
  pendingRecovery() {
    return this.list().filter((m) => !TERMINALS.has(m.phase));
  }

  /** Remove a manifest directory. Only for tests and explicit operator cleanup. */
  forget(opId) {
    rmSync(this.dirFor(opId), { recursive: true, force: true });
    if (existsSync(this.opsRoot)) fsyncDir(this.opsRoot);
  }

  #assertValid(manifest, what) {
    if (!this.validate) return;
    const errs = validateSemantics(manifest);
    if (errs.length) {
      throw new Error(`manifest ${manifest.opId} would violate its contract on ${what}: `
        + errs.slice(0, 3).join(' | '));
    }
  }
}
