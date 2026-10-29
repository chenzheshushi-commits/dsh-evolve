/**
 * Project scoping for memory: which session-workspace a memory belongs to, and
 * whether one project may see another's records.
 *
 * Why this module exists
 * ---------------------
 * One bridge/host process shares ONE memory store across every session it runs,
 * so "project"-scope records were globally recallable — a session in repo A got
 * repo B's project memories injected whenever the query text overlapped. The
 * record schema has carried a `project` field since v0.3, but nothing ever
 * wrote or read it, so the field was decoration.
 *
 * Two rules make it real:
 *   1. WRITE: a memory written from a session is stamped with that session's
 *      workspace root (the harness validates `session.header.cwd` as an
 *      absolute path at session creation, so it is a stable per-workspace
 *      identity — but see the normalization note below).
 *   2. READ: a project-scope record is visible only in its own workspace.
 *      `user`-scope records are global by design; records with no project are
 *      FAIL-OPEN, because every record written before this version has none
 *      and hiding the whole legacy corpus would be the worse error.
 *
 * One predicate, called from every side
 * -------------------------------------
 * `isVisibleInProject` is used by the recall pool, the near-duplicate
 * reinforcement loop and the pending-queue cap in store.js. Filtering only the
 * recall pool would leave the write side cross-project: an A-workspace write
 * that happens to be a near-duplicate of a B-workspace record would reinforce
 * (and possibly overwrite the content of) that other project's memory.
 *
 * Identity: normalized cwd, not basename
 * --------------------------------------
 * A basename key collides (`~/work/app` and `~/client/app` both become "app")
 * and it also splits work that started in a subdirectory of the same repo into
 * a different project. The full normalized workspace root avoids both; the cost
 * is that moving/renaming a repository orphans its project memories — they
 * then fail-open (visible everywhere) rather than vanishing, which is the
 * intended direction of failure for a memory system.
 */

/**
 * Canonicalize a workspace key so the same workspace always produces the same
 * string: separators unified, duplicate separators collapsed, no trailing
 * separator, Windows paths case-folded (that filesystem is case-insensitive, so
 * two spellings would otherwise split one workspace in two).
 *
 * @param {unknown} raw session cwd (or a stored record's `project` field).
 * @returns {string} '' when the input is missing/blank/non-string.
 */
export function normalizeProjectKey(raw) {
  if (typeof raw !== 'string') return '';
  let p = raw.trim();
  if (p === '') return '';
  p = p.replace(/\\/g, '/');
  const isUnc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  if (isUnc) p = `/${p}`;
  // Drop trailing separators, but keep the two root spellings that ARE a
  // separator: '/' and a drive root 'C:/'.
  while (p.length > 1 && p.endsWith('/') && !/^[a-zA-Z]:\/$/.test(p)) {
    p = p.slice(0, -1);
  }
  if (p === '') return '';
  if (/^[a-zA-Z]:/.test(p) || isUnc) p = p.toLowerCase();
  return p;
}

/**
 * Extract the session this carrier speaks for.
 *
 * Accepted shapes, because the three call sites genuinely differ:
 *   - a tool `exec` object:        { agent: { session } }
 *   - an `agent/pre-step` payload: { agent: { session } }
 *   - an Agent:                    { session }
 *   - a Session:                   { header }
 * @param {unknown} carrier
 * @returns {object|undefined}
 */
function sessionOfCarrier(carrier) {
  if (!carrier || typeof carrier !== 'object') return undefined;
  // A Session exposes its creation metadata directly.
  if (carrier.header && typeof carrier.header === 'object') return carrier;
  const agent = carrier.agent ?? carrier;
  if (agent && typeof agent === 'object' && agent.session) return agent.session;
  return undefined;
}

/**
 * The workspace key for whatever the caller holds (exec, payload, agent or
 * session). '' when the harness gives no cwd — which degrades project scoping
 * to the pre-existing global behaviour instead of blanking recall.
 */
export function projectKeyOfCarrier(carrier) {
  const session = sessionOfCarrier(carrier);
  return normalizeProjectKey(session?.header?.cwd);
}

/**
 * May `record` be read/written by a session in `projectKey`?
 *
 * @param {object} record stored memory record (its own `scope` + `project`).
 * @param {string} projectKey normalized key, or '' when unknown.
 * @param {{allProjects?: boolean}} [options] allProjects = deliberate
 *   cross-project read (debugging / global lookup), never a write path.
 * @returns {boolean}
 */
export function isVisibleInProject(record, projectKey, options = {}) {
  if (options.allProjects === true) return true;
  if (!record) return false;
  // Unknown workspace → the pre-project-scoping behaviour (global).
  if (projectKey === '') return true;
  // `user` scope means "everywhere" by definition.
  if (record.scope !== 'project') return true;
  const recordProject = normalizeProjectKey(record.project);
  // Legacy/unstamped records fail open: never hide a corpus that predates
  // stamping, and background-review writes have no session to stamp with.
  return recordProject === '' || recordProject === projectKey;
}
