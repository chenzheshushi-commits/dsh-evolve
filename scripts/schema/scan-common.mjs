/**
 * Shared plumbing for the debt scanners in this directory.
 *
 * Each scanner answers one question about a set of source files and must be able to
 * fail. That sounds obvious; the tool this project imported to find tautological
 * assertions had `process.exit` / `exitCode` / a top-level `throw` in zero places,
 * so it printed its findings and returned success. A scanner without a verdict exit
 * is the thing it was built to detect.
 *
 * The three pieces every scanner shares:
 *
 *   - A FROZEN scope. A bare directory name is read two ways -- "this directory" or
 *     "this tree" -- and the two give different answers. The window scanner read as
 *     top-level finds nothing at all, because every window it hunts lives one level
 *     down, so its "list is empty" threshold would pass on day one with the debt
 *     untouched.
 *   - A SELF-CHECK anchored on a fixture, not on a count taken from real code. Any
 *     count drops as the debt is paid, so a scanner pinned to one would report
 *     "scope misconfigured" at the exact moment the work succeeded.
 *   - A line-by-line diff against a recorded list, not a total. Equal totals with
 *     different members is the failure a total cannot see.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Repository root, given a scanner's own directory (scripts/schema). */
export function repoRootFrom(dir) {
  return join(dir, '..', '..');
}

/**
 * Files directly inside `dir` matching `filter`. Non-recursive on purpose: callers
 * that want a tree say so by calling `walkFiles`.
 */
export function topLevelFiles(dir, filter = (n) => n.endsWith('.mjs')) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isFile() && filter(e.name))
    .map((e) => join(dir, e.name))
    .sort();
}

/** Every file under `dir` matching `filter`, recursively. */
export function walkFiles(dir, filter = (n) => n.endsWith('.mjs')) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, filter));
    else if (e.isFile() && filter(e.name)) out.push(full);
  }
  return out;
}

/** Repo-relative path with forward slashes, so lists compare across platforms. */
export function relPath(root, abs) {
  return relative(root, abs).split(sep).join('/');
}

/**
 * Compare findings against the recorded list in both directions.
 *
 * Both directions matter and for different reasons: something new means undone or
 * reintroduced debt, while something missing means the entry was fixed (update the
 * list) or the scanner stopped seeing it (a real regression that an "is the list
 * empty" check would read as success).
 */
export function diffAgainstList(found, expected) {
  const f = new Set(found);
  const e = new Set(expected);
  return {
    unexpected: [...f].filter((x) => !e.has(x)).sort(),
    missing: [...e].filter((x) => !f.has(x)).sort(),
  };
}

/**
 * Run a scanner's self-check, scope sentinel and list diff, then report.
 *
 * Returns the exit code rather than calling process.exit, so `analyze()` stays
 * importable and the CLI wrapper owns the exit. Every failure below is fatal: a
 * warning in CI is indistinguishable from silence.
 */
export function report({
  name, scopeDescription, candidates, found, expected, sentinelCount, fixture,
}) {
  const problems = [];
  const lines = [`[${name}] scope: ${scopeDescription}`];

  // 1. The fixture must be caught. If it is not, the criterion has decayed or the
  //    scope is wrong -- and either way an empty result means nothing.
  if (fixture) {
    lines.push(`[${name}] self-check fixture: ${fixture.path}`);
    if (!fixture.hit) {
      problems.push(`the self-check fixture ${fixture.path} was NOT flagged. The criterion `
        + 'has degraded or the fixture was "tidied up"; an empty finding list cannot be '
        + 'trusted until this passes. Do not fix the fixture by making it compliant.');
    }
  }

  // 2. The candidate count guards the scope itself. Scope drift changes what "zero
  //    findings" means, and nothing else in the run would notice.
  lines.push(`[${name}] candidates: ${candidates.length} (sentinel ${sentinelCount})`);
  if (candidates.length !== sentinelCount) {
    problems.push(`scope sentinel: expected ${sentinelCount} candidate files, found `
      + `${candidates.length}. Files were added or moved, so re-derive the sentinel `
      + 'deliberately rather than editing it to match.');
  }

  // 3. The findings themselves, line by line.
  const { unexpected, missing } = diffAgainstList(found, expected);
  lines.push(`[${name}] findings: ${found.length}, recorded: ${expected.length}`);
  for (const x of unexpected) lines.push(`  + ${x}`);
  for (const x of missing) lines.push(`  - ${x}`);
  if (unexpected.length > 0) {
    problems.push(`${unexpected.length} finding(s) are not in the recorded list`);
  }
  if (missing.length > 0) {
    problems.push(`${missing.length} recorded entr(ies) were not found -- either they are `
      + 'fixed (remove them from the list in the same commit) or the scanner stopped '
      + 'seeing them');
  }

  for (const line of lines) console.log(line);
  if (problems.length === 0) {
    console.log(`[${name}] OK`);
    return 0;
  }
  for (const p of problems) console.error(`[${name}] FAIL: ${p}`);
  return 1;
}

/** Read a source file, or '' when unreadable, so one bad path cannot abort a scan. */
export function readSource(abs) {
  try {
    if (!statSync(abs).isFile()) return '';
    return readFileSync(abs, 'utf8');
  } catch { return ''; }
}
