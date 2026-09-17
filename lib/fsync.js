/**
 * The one place fsync happens.
 *
 * Four modules used to carry their own copy of this logic and its error-code
 * list. Two of the copies were missing ENOTSUP, so the same unsyncable
 * filesystem made the transaction layer throw while the proposal layer shrugged
 * -- one event, two semantics. v0.6.0 shipped a Windows EPERM for exactly this
 * reason: skill-proposals.js was left out of a refactor that fixed the others.
 * A single exported implementation is the only thing that makes "fixed" mean
 * fixed everywhere.
 *
 * Platform facts this file exists to encode:
 *
 *   openSync(file, 'r')  + fsyncSync -> EPERM on Windows  (FlushFileBuffers
 *                                       needs GENERIC_WRITE)
 *   openSync(file, 'r+') + fsyncSync -> OK, and does not truncate
 *   openSync(file, 'w')  + fsyncSync -> OK, but TRUNCATES -- never use it here
 *   openSync(dir,  'r')  + fsyncSync -> EPERM on Windows, EINVAL on some Unix
 *
 * The helpers report an OUTCOME, not a boolean. v0.6.2 returned true/false, and
 * one `false` had to stand for two unrelated things: "this platform does not
 * support flushing this kind of handle" (harmless -- every Windows directory
 * fsync) and "this particular file could not be opened for writing" (a read-only
 * file). publish-protocols could not tell them apart, so it treated both as a
 * reason to abort, and a single 0444 file anywhere in a skill tree failed the
 * whole publish. Callers need the distinction, so it is in the return value.
 */
import { closeSync, fsyncSync, openSync } from 'node:fs';

/**
 * Codes that mean "this filesystem/platform will not fsync this handle", as
 * opposed to "something is actually wrong".
 *
 * ENOTSUP appears on some network and virtual mounts. It belongs here for the
 * same reason EINVAL does; leaving it out of two of the four old copies is what
 * made their behaviour diverge.
 */
export const FSYNC_SOFT_FAIL = Object.freeze(
  ['EINVAL', 'EACCES', 'EPERM', 'EISDIR', 'ENOTSUP'],
);

/**
 * Codes that mean "this OBJECT is not writable by us", as distinct from "this
 * platform does not do this kind of fsync".
 *
 * The difference is not academic. A directory fsync failing with EPERM on Windows
 * is a platform property: nothing is wrong, and every operation would fail if we
 * treated it as an error. A regular FILE failing with EPERM/EACCES means someone
 * marked it read-only (0444, or `attrib +R`), which is a property of that file and
 * usually fixable -- but it is not evidence that the bytes are unsafe, because the
 * data was already written and closed before we ever tried to flush it.
 */
const NOT_WRITABLE = Object.freeze(['EACCES', 'EPERM', 'EROFS']);

/** Outcome kinds. `flushed` is success; the other two are both "no fsync happened". */
export const FSYNC_FLUSHED = 'flushed';
export const FSYNC_UNSUPPORTED = 'unsupported';   // the platform will not do it
export const FSYNC_NOT_WRITABLE = 'not-writable'; // this object is read-only

function flush(path, mode, { readOnlyIsUnsupported }) {
  let fd;
  try {
    fd = openSync(path, mode);
    fsyncSync(fd);
    return { ok: true, outcome: FSYNC_FLUSHED, code: null };
  } catch (e) {
    const code = e?.code ?? null;
    if (!FSYNC_SOFT_FAIL.includes(code)) throw e;   // ENOSPC/EIO are real failures
    const outcome = (!readOnlyIsUnsupported && NOT_WRITABLE.includes(code))
      ? FSYNC_NOT_WRITABLE
      : FSYNC_UNSUPPORTED;
    return { ok: false, outcome, code };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * fsync a directory so a rename inside it is durable, not merely visible.
 *
 * A refusal is always `unsupported`: a directory handle cannot be opened for
 * writing on any platform, so EPERM/EACCES here says nothing about permissions.
 * Acceptable everywhere -- the data itself is already written.
 */
export function fsyncDir(dir) {
  return flush(dir, 'r', { readOnlyIsUnsupported: true });
}

/**
 * fsync a regular file. Opens 'r+' because Windows rejects 'r' and 'w' would
 * truncate.
 *
 * Returns `{ ok, outcome, code }`. IGNORING the result is how v0.6.0 shipped a
 * fsyncTree that flushed nothing on Windows: the refusal was swallowed one layer
 * down and every caller assumed success. But do not treat every `ok:false` as a
 * failed write either -- see the outcome kinds above.
 */
export function fsyncFile(file) {
  return flush(file, 'r+', { readOnlyIsUnsupported: false });
}
