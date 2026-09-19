/**
 * The four publish protocols, each with a single commit point.
 *
 * Why four instead of one: "rename the staging directory over the target" was
 * the original plan, and it does not work. Renaming onto an existing directory
 * fails with ENOTEMPTY, and a staging directory holding only SKILL.md would
 * silently discard the skill's references/, scripts/ and assets/ (plan 0I.1).
 * So the protocol follows the shape of the change:
 *
 *   A  create / converge-umbrella   new directory, rename into place
 *   B  refine / fold                one file rewritten, marker inside its own
 *                                   state block -> content and proof land in the
 *                                   same rename, with no window between them
 *   C  rollback                      whole-directory replacement, via a retired
 *                                   intermediate so a crash is always classifiable
 *   D  archive / restore / autoArchive  pure move; the tree is unchanged
 *
 * Shared rules: staging lives on the same filesystem as the destination and
 * outside the watcher's reach; EXDEV always fails closed (a copy has no atomic
 * moment, so a crash mid-copy leaves a half-written skill); the commit marker is
 * written last, so its presence proves the whole tree is durable.
 */

import {
  cpSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync,
  renameSync, rmSync, statSync, writeSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  MARKER_NAME, fsyncDir, fsyncTree, treeHash, writeMarker, readMarker, removeMarker,
  inspectTarball, memberManifestOf,
} from './op-runtime.js';
import { FSYNC_FLUSHED, FSYNC_UNSUPPORTED, FSYNC_NOT_WRITABLE } from './fsync.js';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const nowIso = () => new Date().toISOString();

/**
 * Staging root: a sibling of the skills directory, so rename stays atomic, and
 * dot-prefixed and outside the watched root, so a staged SKILL.md is never
 * hot-loaded before it is committed (plan 0I.4).
 */
export function stagingRootFor(skillsDir, opId) {
  return join(dirname(skillsDir), '.evolve-ops', opId, 'staging');
}

/** Same device means rename is atomic. Different device means we refuse. */
export function assertSameFilesystem(a, b) {
  const devOf = (p) => {
    let cur = p;
    for (let i = 0; i < 8; i += 1) {
      try { return statSync(cur).dev; } catch { cur = dirname(cur); }
    }
    return null;
  };
  const da = devOf(a);
  const db = devOf(b);
  if (da === null || db === null) return { ok: true, reason: 'device unknown; proceeding' };
  if (da !== db) {
    return {
      ok: false,
      reason: `${a} and ${b} are on different filesystems; refusing to publish by copy `
        + '(a copy has no atomic commit point, so a crash halfway leaves a broken skill)',
    };
  }
  return { ok: true };
}

function writeFileDurable(file, body) {
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Stamp the flush outcome onto the marker instead of throwing the publish away.
 *
 * v0.6.2 refused to publish whenever any file declined to flush. That conflated
 * two things fsync.js keeps apart: a platform that does not support this kind of
 * fsync, and a file that is read-only. Neither means the bytes are missing -- the
 * data was written and closed first -- and a single 0444 file inside a skill tree
 * made crystallize / refine / rollback fail outright.
 *
 * Recovery decides OWNERSHIP by `opId` alone -- see the marker-trusting branches of
 * `OperationRuntime.classify()` in op-runtime.js. Line numbers are deliberately not
 * quoted here: this comment carried `764/781/800` from v0.6.4 onwards while the real
 * positions had moved to 796/813/833, and two of this project's own evaluation
 * reports then disagreed with each other about which was right. A function name does
 * not drift.
 *
 * The durability note is NOT unread. `degraded()` folds it into the roll-forward
 * verdict and, since v0.7.0, `reconcile()` forwards it into `report.pending`, so an
 * operator sees which trees were published without a full flush. It stays advisory:
 * a permissions quirk must not become an outage.
 */
/**
 * What each fsync outcome means for a publish, declared here rather than inferred
 * from an error-code table two layers down.
 *
 * v0.6.4 put EROFS -- literally "read-only filesystem" -- into fsync.js's soft-fail
 * list and not into its not-writable list, which silently inverted the "a read-only
 * object must not abort a publish" rule for that one code. Nothing caught it,
 * because the policy did not live anywhere that a test could read. It does now:
 * adding an outcome to fsync.js without deciding its policy here makes
 * `scripts/schema/durability-policy.test.mjs` red.
 *
 * `proceed` -- publish; the bytes are written, the flush merely did not happen.
 * `partial` -- publish, and stamp the marker so an operator can see the gap.
 * `abort`   -- refuse; we cannot explain why the flush failed.
 */
export const DURABILITY_POLICY = Object.freeze({
  [FSYNC_FLUSHED]: 'proceed',
  [FSYNC_UNSUPPORTED]: 'proceed',
  [FSYNC_NOT_WRITABLE]: 'partial',
});

/** Outcomes with no entry above abort, so a new code fails closed instead of passing silently. */
export const DURABILITY_DEFAULT = 'abort';

/**
 * Resolve a set of fsync outcomes into one decision for this publish.
 *
 * Returns `{ decision, unclassified }`. `unclassified` is non-empty only when
 * fsync.js grew an outcome that nobody classified here -- the case that used to
 * be invisible.
 */
export function durabilityDecision(outcomes) {
  const unclassified = [...new Set(outcomes)].filter((o) => !(o in DURABILITY_POLICY));
  if (unclassified.length > 0) return { decision: DURABILITY_DEFAULT, unclassified };
  const decisions = new Set(outcomes.map((o) => DURABILITY_POLICY[o]));
  if (decisions.has('abort')) return { decision: 'abort', unclassified: [] };
  if (decisions.has('partial')) return { decision: 'partial', unclassified: [] };
  return { decision: 'proceed', unclassified: [] };
}

/**
 * Apply DURABILITY_POLICY to what fsyncTree reported. Returns a `{ ok:false, reason }`
 * for the caller to hand straight back when policy says abort, otherwise null.
 *
 * Callers must consult this BEFORE writeMarker: the marker means "this tree is
 * complete and durable", so stamping one after an abort-worthy outcome is the
 * inversion that plan 0K.6 exists to prevent.
 */
function durabilityGuard(synced, logger, dir) {
  const { decision, unclassified } = durabilityDecision(synced?.outcomes ?? []);
  if (decision !== 'abort') return null;
  const detail = unclassified.length > 0
    ? `unclassified fsync outcome(s): ${unclassified.join(', ')}`
    : 'an fsync outcome classified as abort';
  logger?.error?.(`[dsh-evolve] refusing to publish ${dir}: ${detail}. `
    + 'lib/publish-protocols.js DURABILITY_POLICY decides this; add the outcome there.');
  return { ok: false, reason: `durability policy aborted the publish (${detail})` };
}

function durabilityMarker(marker, synced, logger, dir) {
  const unsynced = synced?.unsynced ?? [];
  const unsupported = synced?.unsupported ?? [];
  if (unsynced.length === 0 && unsupported.length === 0) return marker;
  if (unsynced.length > 0) {
    logger.warn?.(`[dsh-evolve] published ${dir} with ${unsynced.length} unflushed file(s) `
      + `(read-only, first: ${unsynced[0]}); the write itself succeeded, but a crash `
      + 'before the OS flushes could lose it -- clear the read-only bit to restore '
      + 'full durability');
  }
  return {
    ...marker,
    durability: unsynced.length > 0 ? 'partial' : 'platform-limited',
    ...(unsynced.length > 0 ? { unflushed: unsynced } : {}),
    ...(unsupported.length > 0 ? { unflushedUnsupported: unsupported.length } : {}),
  };
}

/**
 * Protocol A: publish a brand-new directory.
 *
 * The destination must not exist. Asserting that up front is what makes the
 * single rename a real commit point, and it also protects a same-named skill a
 * human may have created since the proposal was written.
 */
export function publishNewDirectory({ stagingDir, finalDir, marker, logger = { warn() {} } }) {
  if (!existsSync(stagingDir)) return { ok: false, reason: `staging directory missing: ${stagingDir}` };
  if (existsSync(finalDir)) {
    return { ok: false, conflict: true, reason: `destination already exists: ${finalDir}` };
  }
  const fsCheck = assertSameFilesystem(stagingDir, dirname(finalDir));
  if (!fsCheck.ok) return { ok: false, reason: fsCheck.reason };
  const synced = fsyncTree(stagingDir);
  const durabilityAbort = durabilityGuard(synced, logger, stagingDir);
  if (durabilityAbort) return durabilityAbort;
  // The marker's load-bearing property is its ORDERING -- written last, so its
  // presence means the tree is complete (plan 0K.6). A file the platform or its own
  // permissions would not let us flush does not invalidate that: the bytes were
  // written and closed before we tried. So record the degradation in the marker
  // instead of aborting. v0.6.2 aborted, and one 0444 file failed every publish.
  writeMarker(stagingDir, durabilityMarker(marker, synced, logger, stagingDir));
  mkdirSync(dirname(finalDir), { recursive: true });
  try {
    renameSync(stagingDir, finalDir);        // ← commit point
  } catch (e) {
    if (e?.code === 'EXDEV') return { ok: false, reason: `EXDEV publishing ${finalDir}; refusing to copy` };
    if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST') {
      return { ok: false, conflict: true, reason: `destination became non-empty: ${finalDir}` };
    }
    throw e;
  }
  fsyncDir(dirname(finalDir));
  fsyncDir(dirname(stagingDir));
  return { ok: true, finalDir, committedTreeHash: treeHash(finalDir) };
}

/**
 * Protocol B: rewrite one SKILL.md.
 *
 * The commit marker is the `lastCommittedOpId` inside the file's own state
 * block, so the prose and the proof are published by the same rename. This also
 * leaves references/ and scripts/ completely untouched, which the
 * whole-directory approach did not.
 *
 * The pre-rename recheck is best effort by design and is documented as such: a
 * plain POSIX rename cannot compare-and-swap, so a hand edit landing in the last
 * few milliseconds can still be overwritten. Checking inode, size, mtime and
 * hash closes everything that can be closed without pretending otherwise.
 */
export function publishSkillFile({ file, body, expect = null, opId, logger = { warn() {} } }) {
  if (!existsSync(file)) return { ok: false, reason: `target file missing: ${file}` };
  const before = statSync(file);
  const beforeBody = readFileSync(file, 'utf8');
  if (expect) {
    const drift = [];
    if (expect.ino !== undefined && expect.ino !== before.ino) drift.push('inode');
    if (expect.size !== undefined && expect.size !== before.size) drift.push('size');
    if (expect.mtimeMs !== undefined && expect.mtimeMs !== before.mtimeMs) drift.push('mtime');
    if (expect.contentHash !== undefined && expect.contentHash !== sha256(beforeBody)) drift.push('content');
    if (drift.length) {
      return { ok: false, stale: true, reason: `target changed before publish (${drift.join(', ')})` };
    }
  }
  const tmp = `${file}.tmp`;
  writeFileDurable(tmp, body);
  try {
    renameSync(tmp, file);                   // ← commit point
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  fsyncDir(dirname(file));                   // the skill's own directory, not skillsDir
  return { ok: true, file, lastCommittedOpId: opId, afterContentHash: sha256(body) };
}

/** Snapshot the four fields protocol B rechecks immediately before its rename. */
export function fileFingerprint(file) {
  if (!existsSync(file)) return null;
  const st = statSync(file);
  return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, contentHash: sha256(readFileSync(file, 'utf8')) };
}

/**
 * Protocol C: replace a whole directory from a sealed rollback artifact.
 *
 * Two renames with a named intermediate: the live directory moves to `retired`,
 * then the staged tree moves into place. Recovery can therefore always tell
 * which of the two happened, instead of finding the target missing and having to
 * guess (plan 0I.3).
 */
export function publishDirectoryReplacement({
  artifactPath, artifactSha256, expectRoot, stagingRoot, finalDir, retiredDir, marker,
  memberManifest = null, logger = { warn() {} },
}) {
  if (!existsSync(artifactPath)) return { ok: false, reason: `artifact missing: ${artifactPath}` };
  const actual = sha256(readFileSync(artifactPath));
  if (artifactSha256 && actual !== artifactSha256) {
    return { ok: false, reason: 'artifact sha256 does not match the sealed value; refusing to extract' };
  }
  const inspect = inspectTarball(artifactPath, { expectRoot });
  if (!inspect.ok) return { ok: false, reason: inspect.reason };

  mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = join(stagingRoot, expectRoot);
  rmSync(stagingDir, { recursive: true, force: true });
  execFileSync('tar', ['-C', stagingRoot, '-xzf', artifactPath], { stdio: 'ignore' });
  if (!existsSync(join(stagingDir, 'SKILL.md'))) {
    return { ok: false, reason: 'extracted artifact has no SKILL.md' };
  }
  if (memberManifest) {
    const got = memberManifestOf(stagingDir, expectRoot);
    const want = new Map(memberManifest.filter((m) => m.type === 'file').map((m) => [m.path, m.contentHash]));
    const gotFiles = new Map(got.filter((m) => m.type === 'file').map((m) => [m.path, m.contentHash]));
    for (const [path, hash] of want) {
      if (gotFiles.get(path) !== hash) {
        return { ok: false, reason: `member ${path} differs from the sealed manifest` };
      }
    }
    for (const path of gotFiles.keys()) {
      if (!want.has(path)) return { ok: false, reason: `extracted tree has an extra member ${path}` };
    }
  }
  const fsCheck = assertSameFilesystem(stagingDir, dirname(finalDir));
  if (!fsCheck.ok) return { ok: false, reason: fsCheck.reason };

  const synced = fsyncTree(stagingDir);
  const retireAbort = durabilityGuard(synced, logger, stagingDir);
  if (retireAbort) return retireAbort;
  writeMarker(stagingDir, durabilityMarker(marker, synced, logger, stagingDir));
  mkdirSync(dirname(retiredDir), { recursive: true });
  const hadLive = existsSync(finalDir);
  if (hadLive) {
    try {
      renameSync(finalDir, retiredDir);      // first rename
    } catch (e) {
      if (e?.code === 'EXDEV') return { ok: false, reason: 'EXDEV retiring the live directory; refusing' };
      throw e;
    }
    fsyncDir(dirname(finalDir));
  }
  try {
    renameSync(stagingDir, finalDir);        // ← commit point
  } catch (e) {
    if (hadLive) {
      try { renameSync(retiredDir, finalDir); fsyncDir(dirname(finalDir)); } catch { /* recovery reports */ }
    }
    if (e?.code === 'EXDEV') return { ok: false, reason: 'EXDEV publishing the restored directory; refusing' };
    throw e;
  }
  fsyncDir(dirname(finalDir));
  return { ok: true, finalDir, retiredDir: hadLive ? retiredDir : null, committedTreeHash: treeHash(finalDir) };
}

/**
 * Protocol D: move a whole tree (archive, restore, autoArchive).
 *
 * The marker goes into the source before the rename, so the moved directory
 * arrives already carrying proof of who moved it. EXDEV fails closed here too:
 * the previous copy-then-delete fallback silently gave up atomicity for
 * exactly the operation whose whole promise is reversibility.
 */
export function publishMove({ sourceDir, destDir, marker, logger = { warn() {} } }) {
  if (!existsSync(sourceDir)) return { ok: false, reason: `source missing: ${sourceDir}` };
  if (existsSync(destDir)) return { ok: false, conflict: true, reason: `destination exists: ${destDir}` };
  const fsCheck = assertSameFilesystem(sourceDir, dirname(destDir));
  if (!fsCheck.ok) return { ok: false, reason: fsCheck.reason };
  const beforeTreeHash = treeHash(sourceDir);
  const synced = fsyncTree(sourceDir);
  const archiveAbort = durabilityGuard(synced, logger, sourceDir);
  if (archiveAbort) return archiveAbort;
  writeMarker(sourceDir, durabilityMarker(marker, synced, logger, sourceDir));
  mkdirSync(dirname(destDir), { recursive: true });
  try {
    renameSync(sourceDir, destDir);          // ← commit point
  } catch (e) {
    try { removeMarker(sourceDir); } catch { /* leave for recovery */ }
    if (e?.code === 'EXDEV') {
      return {
        ok: false,
        reason: `EXDEV moving ${sourceDir} -> ${destDir}; archive and skills must be on one `
          + 'filesystem (copy+delete is not atomic, so it is refused)',
      };
    }
    if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST') {
      return { ok: false, conflict: true, reason: `destination appeared: ${destDir}` };
    }
    throw e;
  }
  fsyncDir(dirname(sourceDir));
  fsyncDir(dirname(destDir));
  // treeHash excludes the marker, so a pure move must not change it. A mismatch
  // means the content itself changed, which a move must never do (plan 0L.2).
  const committedTreeHash = treeHash(destDir);
  return { ok: true, beforeTreeHash, committedTreeHash, destDir };
}

/** Undo a not-yet-committed protocol D attempt: drop the marker we wrote. */
export function abortMove({ sourceDir }) {
  try { return removeMarker(sourceDir); } catch { return false; }
}

/** Put a retired directory back after a failed protocol C. */
export function restoreRetired({ retiredDir, finalDir }) {
  if (!existsSync(retiredDir)) return { ok: false, reason: 'nothing retired' };
  if (existsSync(finalDir)) return { ok: false, conflict: true, reason: 'the live directory is present again' };
  mkdirSync(dirname(finalDir), { recursive: true });
  renameSync(retiredDir, finalDir);
  fsyncDir(dirname(finalDir));
  removeMarker(finalDir);
  return { ok: true };
}

/** Build a protocol-appropriate commit marker. */
export function buildMarker({ opId, protocol, action, ...rest }) {
  const base = { opId, protocol, action, at: nowIso() };
  if (protocol === 'D') {
    return { ...base, logicalSkillName: rest.logicalSkillName, archiveId: rest.archiveId };
  }
  return {
    ...base,
    expectedAfterContentHash: rest.expectedAfterContentHash,
    expectedAfterStateHash: rest.expectedAfterStateHash,
    ...(protocol === 'B' ? { lastCommittedOpId: opId } : {}),
  };
}

/** Copy an existing skill tree into staging so a rewrite keeps its extra files. */
export function stageExistingSkill({ sourceDir, stagingDir }) {
  mkdirSync(dirname(stagingDir), { recursive: true });
  rmSync(stagingDir, { recursive: true, force: true });
  if (existsSync(sourceDir)) {
    cpSync(sourceDir, stagingDir, { recursive: true });
    const marker = join(stagingDir, MARKER_NAME);
    if (existsSync(marker)) rmSync(marker, { force: true });
  } else {
    mkdirSync(stagingDir, { recursive: true });
  }
  return stagingDir;
}

/** Remove an operation's staging tree once it is no longer needed. */
export function cleanStaging(skillsDirParentOpDir) {
  try { rmSync(skillsDirParentOpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Directory names inside an archive root, newest first. */
export function listArchiveIds(archiveDir, logicalSkillName = null) {
  let entries = [];
  try { entries = readdirSync(archiveDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(archiveDir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    let state = {};
    try {
      const m = /<!--dsh-evolve-state:(.*?)-->/s.exec(readFileSync(file, 'utf8'));
      state = m ? JSON.parse(m[1]) : {};
    } catch { state = {}; }
    const logical = state.logicalSkillName ?? state.tag ?? entry.name;
    if (logicalSkillName && logical !== logicalSkillName) continue;
    out.push({
      archiveId: entry.name,
      logicalSkillName: logical,
      version: state.version ?? null,
      archivedAt: state.archivedAt ?? null,
    });
  }
  return out.sort((a, b) => (a.archiveId < b.archiveId ? 1 : -1));
}
