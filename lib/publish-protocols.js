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
  // The marker means "these bytes are on disk". If a file could not be flushed,
  // publishing it would be a lie that recovery later trusts (plan 0K.6).
  if (!synced.ok) {
    return { ok: false, reason: `could not fsync ${synced.unsynced.length} file(s) under ${stagingDir}; `
      + `refusing to publish a durability marker (first: ${synced.unsynced[0]})` };
  }
  writeMarker(stagingDir, marker);           // last, so its presence proves the tree
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
  if (!synced.ok) {
    return { ok: false, reason: `could not fsync ${synced.unsynced.length} file(s) under ${stagingDir}; `
      + `refusing to publish a durability marker (first: ${synced.unsynced[0]})` };
  }
  writeMarker(stagingDir, marker);
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
  if (!synced.ok) {
    return { ok: false, reason: `could not fsync ${synced.unsynced.length} file(s) under ${sourceDir}; `
      + `refusing to publish a durability marker (first: ${synced.unsynced[0]})` };
  }
  writeMarker(sourceDir, marker);
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
