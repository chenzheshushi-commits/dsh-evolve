/**
 * Transaction primitives: claims, fencing, and a write-ahead log.
 *
 * Three separate jobs that all exist because "two serial calls" is not a
 * transaction:
 *
 *   claim()    exclusive ownership of a resource, taken atomically with O_EXCL
 *   fencing    a stale executor may never overwrite the current one's result
 *   WAL        intent lands before the action, commit lands after, both fsynced,
 *              so a crash can always be classified afterwards
 *
 * Locks live in a CENTRAL directory (plan 0B.5):
 *
 *     <workspace>/.locks/skills/<canonical-name>.lock
 *
 * NOT inside the resource. A converge moves whole skill directories into
 * staging, and a lock kept inside would travel with them -- the original path
 * becomes lockable again immediately and mutual exclusion silently dies.
 *
 * Nothing here recovers automatically. reconcile() reports; only orphaned locks
 * are released. Auto-continuing a half-finished operation is how a published
 * proposal gets applied twice.
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fsyncDir } from './fsync.js';
import { createHash } from 'node:crypto';

/** How long a claim may go untouched before it is considered orphaned. */
export const PROPOSAL_CLAIM_TTL_MS = 15 * 60 * 1000;
export const USAGE_RECEIPT_TTL_MS = 30 * 60 * 1000;

const nowIso = () => new Date().toISOString();

/** Names that would let a caller escape the lock directory. */
function assertSafeName(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')
      || name.includes('..')) {
    throw new Error(`unsafe resource name: ${JSON.stringify(name)}`);
  }
}


/**
 * A claim on one named resource, stored as a lock file.
 *
 * The file is created with 'wx' (O_EXCL): either this process creates it or the
 * open fails. There is no read-then-write window for two processes to both pass.
 */
export class ClaimRegistry {
  /**
   * @param {object} options
   * @param {string} options.workspaceDir
   * @param {string} [options.domain]  subdirectory under .locks (default 'skills')
   * @param {number} [options.ttlMs]
   * @param {() => number} [options.now]  injectable clock for tests
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir;
    this.domain = options.domain ?? 'skills';
    this.ttlMs = options.ttlMs ?? PROPOSAL_CLAIM_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get lockDir() {
    if (!this.workspaceDir) throw new Error('ClaimRegistry requires a workspaceDir');
    return join(this.workspaceDir, '.locks', this.domain);
  }

  pathFor(resource) {
    assertSafeName(resource);
    return join(this.lockDir, `${resource}.lock`);
  }

  /** Read the current holder, or null when the resource is free. */
  holder(resource) {
    const p = this.pathFor(resource);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // A lock we cannot parse still means "someone holds this". Reporting it as
      // free would hand the resource to a second executor.
      return { opId: null, corrupt: true, at: null };
    }
  }

  /**
   * Try to take the claim.
   *
   * Returns {status:'acquired'} or {status:'retry', holder, orphaned}. An
   * orphaned claim is NOT stolen here -- expiry alone cannot tell "the executor
   * died" from "the executor is slow", and the recovery path needs to compare
   * hashes before deciding (plan 0A.6).
   */
  claim(resource, opId) {
    if (!opId) throw new Error('claim() requires an opId');
    const p = this.pathFor(resource);
    mkdirSync(this.lockDir, { recursive: true });
    let fd;
    try {
      fd = openSync(p, 'wx');
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const held = this.holder(resource);
      const age = held?.atMs ? this.now() - held.atMs : Infinity;
      return {
        status: 'retry',
        holder: held,
        orphaned: age > this.ttlMs,
      };
    }
    try {
      writeSync(fd, `${JSON.stringify({
        opId, pid: process.pid, at: nowIso(), atMs: this.now(),
      }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDir(this.lockDir);
    return { status: 'acquired', holder: this.holder(resource) };
  }

  /**
   * Release a claim, but only if this opId still owns it.
   *
   * This is the fencing rule: a stale executor waking up must not release (or
   * later overwrite) the claim of whoever took over. Returns false when the
   * caller no longer owns it.
   */
  release(resource, opId) {
    const held = this.holder(resource);
    if (held === null) return false;
    if (held.opId !== opId) return false;
    unlinkSync(this.pathFor(resource));
    fsyncDir(this.lockDir);
    return true;
  }

  /**
   * Whether this opId may still write results for this resource.
   *
   * Every finalize, reject and recovery path must call this first. Without it a
   * slow executor that lost its claim can still overwrite the new owner's work.
   */
  stillOwns(resource, opId) {
    const held = this.holder(resource);
    return held !== null && held.opId === opId;
  }

  /** Claims older than the TTL, for the reconcile report. */
  orphaned() {
    if (!existsSync(this.lockDir)) return [];
    const out = [];
    for (const f of readdirSync(this.lockDir)) {
      if (!f.endsWith('.lock')) continue;
      const resource = f.slice(0, -'.lock'.length);
      const held = this.holder(resource);
      const age = held?.atMs ? this.now() - held.atMs : Infinity;
      if (age > this.ttlMs) out.push({ resource, holder: held, ageMs: age });
    }
    return out;
  }

  /** Force-release an orphan. Only the recovery path may call this. */
  breakOrphan(resource) {
    const p = this.pathFor(resource);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    fsyncDir(this.lockDir);
    return true;
  }
}

const walChecksum = (payload) => createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);

/**
 * Write-ahead log: intent before the action, commit after it.
 *
 * The order cannot be swapped. With intent on disk first, a crash can only
 * produce "intent without commit", which the recovery matrix can classify. The
 * reverse order allows "the record is gone but the log says it never happened".
 *
 * appendFileSync is NOT enough -- it returns before the data is durable. Every
 * line goes through openSync/writeSync/fsyncSync/closeSync.
 */
export class Wal {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir;
    this.name = options.name ?? 'ops';
    this._seq = null;
  }

  get path() {
    if (!this.workspaceDir) throw new Error('Wal requires a workspaceDir');
    return join(this.workspaceDir, '.wal', `${this.name}.jsonl`);
  }

  #nextSeq() {
    if (this._seq === null) {
      const entries = this.read();
      this._seq = entries.length ? Math.max(...entries.map((e) => e.seq ?? 0)) : 0;
    }
    this._seq += 1;
    return this._seq;
  }

  #append(entry) {
    const dir = join(this.workspaceDir, '.wal');
    mkdirSync(dir, { recursive: true });
    const full = { seq: this.#nextSeq(), at: nowIso(), ...entry };
    const payload = JSON.stringify(full);
    const line = `${JSON.stringify({ ...full, checksum: walChecksum(payload) })}\n`;
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return full;
  }

  /** Record what is about to happen. Must land before the action runs. */
  intent(entry) {
    return this.#append({ ...entry, phase: 'intent' });
  }

  /** Record that it happened. Must land after the action returns. */
  commit(entry) {
    return this.#append({ ...entry, phase: 'commit' });
  }

  /**
   * Read the log, tolerating a truncated final line.
   *
   * A crash mid-write leaves a partial line; discarding it is correct, because
   * an entry that was never fully written describes nothing that happened.
   * A line whose checksum does not match is reported, not silently dropped --
   * that is corruption, not truncation.
   */
  read() {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf8');
    const lines = raw.split('\n');
    const out = [];
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Only the final line may be torn. Anything earlier is real damage.
        if (i === lines.length - 1 || lines.slice(i + 1).every((l) => !l.trim())) continue;
        out.push({ seq: null, phase: 'CORRUPT', raw: line.slice(0, 120) });
        continue;
      }
      const { checksum, ...rest } = parsed;
      if (checksum && checksum !== walChecksum(JSON.stringify(rest))) {
        out.push({ ...rest, phase: 'CORRUPT', reason: 'checksum mismatch' });
        continue;
      }
      out.push(rest);
    }
    return out;
  }

  /**
   * Intents with no matching commit, keyed by the caller's runId+target.
   *
   * These are exactly the operations whose outcome cannot be known from the log
   * alone, so the caller must inspect the actual resource (plan 0A.6).
   */
  danglingIntents() {
    const committed = new Set();
    const intents = new Map();
    for (const e of this.read()) {
      const key = `${e.runId ?? ''}|${e.target ?? ''}`;
      if (e.phase === 'commit') committed.add(key);
      else if (e.phase === 'intent') intents.set(key, e);
    }
    return [...intents.entries()]
      .filter(([key]) => !committed.has(key))
      .map(([, e]) => e);
  }

  /** Corrupt lines, so a reconcile can report them instead of hiding them. */
  corruptEntries() {
    return this.read().filter((e) => e.phase === 'CORRUPT');
  }
}

/**
 * Conditional write over a storage-domain table.
 *
 * table.update(key, fn) runs fn INSIDE the domain's serial queue, so fn sees the
 * latest value and nobody can interleave between the read and the write. That
 * makes it a real compare-and-swap -- unlike get-then-put, where another writer
 * lands in the gap.
 *
 * Returns {applied, reason}. Two cases are NOT failures:
 *   'missing-key'  the record is already gone; callers treat it as a skip
 *   'precondition' the expectation no longer holds; the value is written back
 *                  unchanged, so nothing is clobbered
 */
export async function casUpdate(table, key, { expect, mutate }) {
  let applied = false;
  let reason = null;
  try {
    await table.update(key, (cur) => {
      if (typeof expect === 'function' && !expect(cur)) {
        reason = 'precondition';
        return cur; // writing the original value back == no change
      }
      applied = true;
      return mutate(cur);
    });
  } catch (e) {
    // A record that vanished is a normal outcome for tidy and reservation
    // sweeps, not an error to propagate.
    if (e?.code === 'missing-key' || /missing-key/.test(String(e?.message))) {
      return { applied: false, reason: 'missing-key' };
    }
    throw e;
  }
  return { applied, reason };
}

/**
 * Publish a directory atomically: build beside the target, then rename over it.
 *
 * Requires the staging directory and the final path to be on the SAME
 * filesystem, because only then is rename atomic. On EXDEV this throws instead
 * of falling back to copy: a copy has no atomic moment, so a crash halfway
 * through leaves a half-published skill. Better unavailable than corrupt.
 */
export function publishDirAtomic(stagingDir, finalDir) {
  if (!existsSync(stagingDir)) throw new Error(`staging dir does not exist: ${stagingDir}`);
  const parent = join(finalDir, '..');
  mkdirSync(parent, { recursive: true });
  try {
    if (existsSync(finalDir)) {
      const retired = `${finalDir}.retired-${Date.now()}`;
      renameSync(finalDir, retired);
      try {
        renameSync(stagingDir, finalDir);
      } catch (e) {
        renameSync(retired, finalDir); // put it back before giving up
        throw e;
      }
      rmSync(retired, { recursive: true, force: true });
    } else {
      renameSync(stagingDir, finalDir);
    }
  } catch (e) {
    if (e?.code === 'EXDEV') {
      throw new Error(`staging and final directory are on different filesystems `
        + `(${stagingDir} -> ${finalDir}); refusing to fall back to copy because a `
        + 'copy has no atomic commit point');
    }
    throw e;
  }
  fsyncDir(parent);
}

/** True when both paths live on the same device, so rename is atomic. */
export function sameFilesystem(a, b) {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/**
 * Move a stale staging directory aside instead of deleting it.
 *
 * An interrupted publish may hold the only copy of work in progress. Deleting it
 * automatically destroys evidence; quarantining it lets a human look.
 */
export function quarantineOrphan(workspaceDir, orphanPath, label) {
  const dir = join(workspaceDir, '.orphans');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${label}-${Date.now()}`);
  renameSync(orphanPath, dest);
  fsyncDir(dir);
  return dest;
}
