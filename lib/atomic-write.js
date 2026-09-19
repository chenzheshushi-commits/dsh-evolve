/**
 * The one place a file is replaced atomically.
 *
 * Every caller that wanted "readers see the old bytes or the complete new bytes"
 * used to write its own four lines: `${file}.tmp`, `openSync(tmp, 'w')`, write,
 * fsync, rename. There were seven such copies plus two functions with the SAME NAME
 * and different semantics (publish-protocols.js's `writeFileDurable` truncated the
 * real file in place; skill-operations.js's did temp+rename), and the fixed name
 * with mode 'w' is exploitable in two measured ways:
 *
 *   - Symlink pre-placement. Planting `SKILL.md.tmp -> ../../PWNED.txt` in a skill
 *     directory and then saving the skill wrote OUTSIDE the tree with no error at
 *     all -- verified: the target file was created containing the skill body. 'wx'
 *     refuses with EEXIST instead of following the link.
 *   - Concurrent truncation. Two writers opening the same fixed tmp with 'w' leaves
 *     whichever finished last: A wrote "AAAA-complete-AAAA", B wrote "BB", the file
 *     held "BB", and A saw no error. fsync cannot help here -- the bytes were
 *     replaced before any flush.
 *
 * The shape below is copied from this repo's own artifact seal
 * (op-runtime.js, `sealRollbackArtifact`): random suffix, exclusive create, write,
 * fsync, then publish. Same motive, so the same mechanism.
 *
 * Directory fsync after the rename is kept, because that is what five releases of
 * durability work bought: without it the rename is visible but not durable.
 */
import {
  closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { fsyncDir } from './fsync.js';

/**
 * Suffix that marks a file as this module's in-progress temp file.
 *
 * Recovery sweeps by this suffix rather than by a recorded exact path: with random
 * names, "the one tmp file for this write" is not knowable after a crash. Callers
 * that used to persist a `tmpPath` and delete exactly that file must sweep instead
 * -- lib/skill-proposals.js already lists a directory and filters `.tmp`, so this is
 * a pattern the repo had, not a new convention.
 */
export const TMP_SUFFIX = '.tmp';

/** True for a name this module could have created, for recovery sweeps. */
export function isTempName(name) {
  return name.endsWith(TMP_SUFFIX);
}

/**
 * Replace `file` with `body`, atomically and durably.
 *
 * `mode` is required, not defaulted: the permissions of state files are a decision
 * each call site should make visibly. Passing 0o600 for something world-readable is
 * a bug worth seeing at the call site rather than inheriting from here.
 *
 * Throws if the temp file cannot be created exclusively, after removing it.
 */
export function writeFileAtomic(file, body, mode) {
  if (typeof mode !== 'number') {
    throw new TypeError('writeFileAtomic requires an explicit mode, so the permissions '
      + 'of each state file are decided where that file is written');
  }
  const tmp = `${file}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`;
  let fd;
  try {
    // 'wx' is O_EXCL: it fails rather than following a symlink someone planted at
    // this path, and it cannot truncate another writer's in-progress temp file
    // because the random name is not guessable.
    fd = openSync(tmp, 'wx', mode);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
  // The rename is durable only once the directory entry is flushed. A refusal here
  // is a platform property (Windows never flushes directory handles), so the
  // outcome is returned for callers that report durability rather than thrown.
  return fsyncDir(dirname(file));
}
