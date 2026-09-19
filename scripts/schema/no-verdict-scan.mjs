#!/usr/bin/env node
/**
 * Find scripts that compute a result and then have no way to report a verdict.
 *
 * This is the scanner that justifies the whole set. The tautology detector this
 * project inherited had `process.exit`, `process.exitCode` and a top-level `throw` in
 * ZERO places: it found suspicious assertions, printed them, and returned success. CI
 * saw green. A gate that cannot fail and a gate that guards nothing are the same
 * thing from the outside, which is exactly what makes this class of defect survive.
 *
 * SCOPE: baseline/ + scripts/*.mjs (TOP LEVEL, excluding scripts/schema/) + root
 * *.mjs. Frozen, and recursion is banned here: walking the tree from the repo root
 * would pull in test-fixtures/no-verdict-sample.mjs, whose entire job is to be caught
 * by this criterion. It would then be a permanent finding, the recorded list could
 * never be empty, and the threshold would be meaningless. The fixture is fed in
 * directly through analyze() instead.
 *
 * A file "has a verdict exit" if it can end non-zero or raise: process.exit,
 * process.exitCode, a throw, or an assertion import that is actually called. The
 * assertion case is why an import alone is not enough -- importing assert and never
 * calling it is precisely the shape of a script that only prints.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  repoRootFrom, topLevelFiles, relPath, report, readSource,
} from './scan-common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = repoRootFrom(here);

/** Scope, frozen. Never recursive -- see the note above about the fixture. */
export const SCOPE_DESCRIPTION =
  'baseline/ + scripts/*.mjs (top level, excludes scripts/schema/) + root *.mjs';

/** Candidate count for the scope sentinel; re-derive deliberately, never to silence. */
export const CANDIDATE_SENTINEL = 8;

/**
 * Files in scope that genuinely have no verdict exit.
 *
 * Empty as measured. baseline/retrieval-baseline.mjs was expected to be here and is
 * NOT: it ends with `main().catch(... process.exit(1))`, so it can fail on an error.
 * What it lacks is a THRESHOLD -- it prints recall and MRR for a human to compare --
 * but that is a different criterion from "can this script report a verdict at all",
 * and conflating the two is how a scanner ends up asserting something it does not
 * actually test. The retrieval work in this release adds the threshold; until then
 * the gap is tracked as a todo in f3-precision-hole.test.mjs, not here.
 */
export const KNOWN = [];

/** Names that mean "this call decides something", for the assertion check. */
const ASSERT_CALL = /\bassert\s*(?:\.\w+\s*)?\(|\bassert\.(?:ok|equal|deepEqual|match|strictEqual|deepStrictEqual|notEqual|throws|fail|rejects)\s*\(/;

/**
 * Verdict exits found in one file. A non-empty array means the file can fail.
 *
 * Returns the reasons rather than a boolean so the CLI can explain itself; callers
 * that only care about the verdict check for length.
 */
export function verdictExits(text) {
  const exits = [];
  // Comments are stripped first: a file that only DISCUSSES process.exit in prose has
  // no verdict exit, and the inherited scanner's own header did exactly that.
  // Line comments FIRST. smoke.mjs's header says "bare @deepseek-ai/* imports", and
  // stripping block comments first treated that `/*` as an opening delimiter and ate
  // the rest of the file -- which made an 84KB file with 3 assert calls look like a
  // script with no verdict exit at all. Order matters more than the patterns here.
  const code = text
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  if (/\bprocess\s*\.\s*exit\s*\(/.test(code)) exits.push('process.exit');
  if (/\bprocess\s*\.\s*exitCode\s*=/.test(code)) exits.push('process.exitCode');
  if (/\bthrow\b/.test(code)) exits.push('throw');
  // An assert import counts only when something actually calls it.
  // Both 'node:assert' and 'node:assert/strict' count; smoke.mjs uses the former, and
  // an earlier version of this pattern required the suffix and therefore missed it.
  if (/from\s*['"]node:assert(?:\/strict)?['"]/.test(code) && ASSERT_CALL.test(code)) {
    exits.push('assert call');
  }
  return exits;
}

/** Findings for one file: a single entry when the file has no verdict exit. */
export function analyze(absPath) {
  const text = readSource(absPath);
  if (text === '') return [];
  return verdictExits(text).length === 0 ? [{ reason: 'no verdict exit' }] : [];
}

/** Candidate files in scope. scripts/schema/ is excluded by using top-level only. */
export function scanScope(root = ROOT) {
  return [
    ...topLevelFiles(join(root, 'baseline')),
    ...topLevelFiles(join(root, 'scripts')),
    ...topLevelFiles(root),
  ].sort();
}

/** Repo-relative path of every file in scope with no verdict exit. */
export function findAll(root = ROOT) {
  return scanScope(root)
    .filter((abs) => analyze(abs).length > 0)
    .map((abs) => relPath(root, abs))
    .sort();
}

function main() {
  const fixture = join(ROOT, 'test-fixtures', 'no-verdict-sample.mjs');
  const code = report({
    name: 'no-verdict-scan',
    scopeDescription: SCOPE_DESCRIPTION,
    candidates: scanScope(),
    found: findAll(),
    expected: KNOWN,
    sentinelCount: CANDIDATE_SENTINEL,
    fixture: { path: 'test-fixtures/no-verdict-sample.mjs', hit: analyze(fixture).length > 0 },
  });
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
