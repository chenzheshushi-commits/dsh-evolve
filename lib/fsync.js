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
 * Both helpers report whether the flush happened rather than pretending it did.
 * Callers that only need "the rename is visible" ignore a false; callers whose
 * next act is to publish a durability claim (writeMarker) must not.
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

function flush(path, mode) {
  let fd;
  try {
    fd = openSync(path, mode);
    fsyncSync(fd);
    return true;
  } catch (e) {
    if (FSYNC_SOFT_FAIL.includes(e?.code)) return false;
    throw e;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * fsync a directory so a rename inside it is durable, not merely visible.
 * Returns false when the platform refused; that is acceptable everywhere,
 * because the data itself is already written.
 */
export function fsyncDir(dir) {
  return flush(dir, 'r');
}

/**
 * fsync a regular file. Opens 'r+' because Windows rejects 'r' and 'w' would
 * truncate.
 *
 * Returns false if the platform refused. IGNORING that return is how v0.6.0
 * shipped a fsyncTree that flushed nothing on Windows: the refusal was swallowed
 * one layer down and every caller assumed success. If your next statement
 * publishes a claim that the bytes are on disk, check the result.
 */
export function fsyncFile(file) {
  return flush(file, 'r+');
}
