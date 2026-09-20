#!/usr/bin/env node
/**
 * Find adjacency judgements made with a fixed character window.
 *
 * The banned shape is `text.slice(start, start + N)` -- a guess about how much source
 * fits between two landmarks. Ten of these existed in this directory, and they failed
 * in both directions:
 *
 *   - instance-lock.test.mjs sliced 1200 characters and asserted one identifier came
 *     before another. 126 characters of comment pushed the second one off the end,
 *     `indexOf` returned -1, and the assertion became `740 < -1` -- permanently red on
 *     a change with no behaviour difference. Written the other way round it would have
 *     been permanently green.
 *   - review-session-isolation.test.mjs asserted the ABSENCE of an identifier in 2000
 *     characters. Anything past that was simply not checked, so the ban could pass
 *     while what it banned sat at character 2100.
 *
 * SCOPE: scripts/** -- RECURSIVE, and that is load-bearing. All ten windows live in
 * scripts/schema/, while scripts/ itself holds two .mjs files with none. Read as
 * top-level this scanner finds nothing, its "recorded list is empty" threshold passes
 * on day one, and the debt it exists to track is invisible. `test-fixtures/` is
 * deliberately outside the scope: the scanner's own fixture would otherwise be a
 * permanent finding, so the list could never be empty.
 *
 * Detection is bracket-balanced, not regex: `slice(a, cond ? b + 1200 : c)` and
 * `slice(Math.max(0, i - 200), i + 400)` both nest, and a regex that tried to read
 * the second argument would either miss them or match commas inside strings.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { splitCallArgs, lineOf } from './source-scope.mjs';
import {
  repoRootFrom, walkFiles, relPath, report, readSource,
} from './scan-common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = repoRootFrom(here);

/** Scope, frozen. Recursive under scripts/, nothing else. */
export const SCOPE_DESCRIPTION = 'scripts/** (recursive)';

/**
 * Candidate count, for the scope sentinel. Re-derive this by running the scanner
 * when files are legitimately added; do not edit it to silence a failure.
 */
export const CANDIDATE_SENTINEL = 44;

/**
 * Known windows still awaiting conversion, as repo-relative `path:line`.
 *
 * Empty because v0.7.0 converted all ten to the scope helpers in source-scope.mjs.
 * An entry appearing here again means either new debt or a reverted fix.
 */
export const KNOWN = [];

/**
 * A window is `slice(X, X + N)`: the SAME base expression in both arguments, with a
 * number added. That is a length.
 *
 * `slice(from, i + 1)` is not -- different bases, so the second argument is a cursor
 * that happens to be ahead of the start. Judging by the size of N instead (">= 11 is
 * a budget") looked reasonable and was wrong: the pinned fixture uses `i + 4`, a
 * four-character window, which is every bit the banned shape.
 */

/**
 * Findings for one file: every `.slice(` / `.substring(` whose second argument ends in
 * `+ <number>`.
 *
 * Small additions are index arithmetic (`i + 1` advances a cursor), so only numbers
 * big enough to be a character budget count. source-scope.mjs itself is exempt: it
 * IS the replacement mechanism, and computing a scope end legitimately does
 * `slice(from, i + 1)`.
 */
export function analyze(absPath) {
  const text = readSource(absPath);
  if (text === '') return [];
  if (absPath.endsWith('source-scope.mjs')) return [];
  const hits = [];
  for (const m of text.matchAll(/\.(?:slice|substring)\(/g)) {
    // Prose that describes the old shape is not the old shape. Without this, the
    // comments explaining each conversion would be permanent findings.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue;

    const { args } = splitCallArgs(text, m.index + m[0].length);
    if (args.length < 2) continue;                 // slice(i) has no window
    const budget = /^(.*?)\+\s*(\d+)\s*$/.exec(args[1]);
    if (!budget) continue;
    // Compare the base of the second argument with the first, ignoring whitespace.
    // `slice(idx, idx + 400)` and `slice(m.index, m.index + 500)` match; so does the
    // ternary form once its arm is read, because the arm repeats the same base.
    const base = budget[1].trim().replace(/\s+/g, '');
    const start = args[0].trim().replace(/\s+/g, '');
    if (base === '' || !(base === start || base.endsWith(start) || start.endsWith(base))) continue;
    hits.push({ line: lineOf(text, m.index), budget: Number(budget[2]), snippet: args[1].trim() });
  }
  return hits;
}

/** Candidate files in scope. */
export function scanScope(root = ROOT) {
  return walkFiles(join(root, 'scripts'));
}

/** `path:line` for every finding in scope. */
export function findAll(root = ROOT) {
  const out = [];
  for (const abs of scanScope(root)) {
    for (const hit of analyze(abs)) out.push(`${relPath(root, abs)}:${hit.line}`);
  }
  return out.sort();
}

function main() {
  const fixture = join(ROOT, 'test-fixtures', 'window-sample.mjs');
  const code = report({
    name: 'window-scan',
    scopeDescription: SCOPE_DESCRIPTION,
    candidates: scanScope(),
    found: findAll(),
    expected: KNOWN,
    sentinelCount: CANDIDATE_SENTINEL,
    fixture: { path: 'test-fixtures/window-sample.mjs', hit: analyze(fixture).length > 0 },
  });
  process.exit(code);
}

// CLI body behind the guard: importing this module must not launch a full scan.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
