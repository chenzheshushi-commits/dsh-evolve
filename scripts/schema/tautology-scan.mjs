#!/usr/bin/env node
/**
 * Find assertions that are true by construction.
 *
 * The shape: take a window starting at some landmark, then assert that the landmark's
 * own text appears in it. `ui-api-contract.test.mjs` did exactly this --
 *
 *     const idx = client.indexOf('rollback-proposal-create');
 *     const window = client.slice(idx, idx + 500);
 *     assert.match(window, /rollback-proposal/);
 *
 * -- where the pattern is a PREFIX of the string the window starts at, so the match
 * succeeded before it read anything else. Pointing the endpoint somewhere else left it
 * green while two neighbouring tests went red, which is the whole problem: a test that
 * cannot fail still reports success, and its NAME goes on claiming a guarantee.
 *
 * SCOPE: scripts/schema/*.test.mjs -- TOP LEVEL only, and frozen. The predecessor to
 * this scanner read the same directory, and today scripts/schema/fixtures/ holds no
 * .mjs so top-level and recursive agree. They diverge the moment one is added, which
 * is why the choice is written down instead of left to whoever reads the directory
 * name next. test-fixtures/ is outside the scope for the usual reason: the fixture
 * that must always be caught would otherwise be a permanent finding.
 *
 * The predecessor also had NO verdict exit -- no process.exit, no exitCode, no
 * top-level throw. It printed suspicions and returned 0, so CI saw green no matter
 * what it found. This one exits non-zero, and no-verdict-scan.mjs would flag it if
 * that regressed.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { splitCallArgs, lineOf, enclosingStatement } from './source-scope.mjs';
import {
  repoRootFrom, topLevelFiles, relPath, report, readSource,
} from './scan-common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = repoRootFrom(here);

/** Scope, frozen: this directory only, test files only. */
export const SCOPE_DESCRIPTION = 'scripts/schema/*.test.mjs (top level)';

/** Candidate count for the scope sentinel; re-derive deliberately. */
export const CANDIDATE_SENTINEL = 33;

/**
 * Known tautological assertions, as repo-relative `path:line`.
 *
 * Empty: the one this project had was rewritten in v0.7.0 to read the POST target's
 * actual argument instead of a window around its own name.
 */
export const KNOWN = [];

/** Assertions whose first argument is the haystack being searched. */
const ASSERT_MATCH = /\bassert\s*\.\s*(?:match|ok|equal|strictEqual)\s*\(/g;

/**
 * Literal text a regex or string argument requires, or null when it is not literal
 * enough to reason about.
 *
 * Only the leading run of literal characters matters: /rollback-proposal/ contributes
 * the whole string, while /^ok-\d+$/ contributes "ok-" and is not conclusive on its
 * own, so patterns with metacharacters early are skipped rather than guessed at.
 */
function literalPrefix(arg) {
  const re = /^\/((?:[^\\/[]|\\.)+)\/[a-z]*$/.exec(arg.trim());
  if (re) {
    const body = re[1];
    const stop = body.search(/[.*+?^${}()|[\]\\]/);
    const head = stop === -1 ? body : body.slice(0, stop);
    return head.length >= 4 ? head : null;
  }
  const str = /^(['"])((?:[^\\'"\n]|\\.)*)\1$/.exec(arg.trim());
  if (str) return str[2].length >= 4 ? str[2] : null;
  return null;
}

/**
 * Findings for one file.
 *
 * An assertion is tautological when its haystack variable was derived from a slice
 * starting at `indexOf(<literal>)`, and the pattern it requires is a prefix of that
 * same literal. Both halves are read from the statements themselves -- the slice, and
 * the indexOf that produced its start -- rather than from a character window, so the
 * detector does not have the defect it hunts.
 */
export function analyze(absPath) {
  const raw = readSource(absPath);
  if (raw === '') return [];
  // Comments are stripped first, or this scanner flags ITS OWN header: the example of
  // a tautological assertion quoted above is, read as code, a tautological assertion.
  // Line comments before block comments -- a `/*` inside a `//` line would otherwise
  // open a comment that swallows the rest of the file.
  const text = raw
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [];

  // Map variable -> literal it was anchored at, e.g. window -> 'rollback-proposal-create'
  const anchoredAt = new Map();
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*\.\s*slice\s*\(/g)) {
    const [, target, source] = m;
    const { args } = splitCallArgs(text, m.index + m[0].length);
    const startExpr = args[0] ?? '';
    // The start is either indexOf(...) inline, or a variable assigned from one.
    let literal = null;
    // The literal must not span newlines. An earlier version used
    // `(?:[^\\]|\\.)*`, which happily ran past the end of the line and made the
    // "anchor" a multi-kilobyte chunk of the file -- so this scanner flagged ITSELF
    // (its own header quotes the tautology it hunts) and flagged window-sample.mjs
    // for a match that was really the same runaway capture.
    const inline = /indexOf\s*\(\s*(['"])((?:[^\\'"\n]|\\.)*)\1/.exec(startExpr);
    if (inline) literal = inline[2];
    else {
      const varName = startExpr.trim().match(/^\w+$/)?.[0];
      if (varName) {
        const decl = new RegExp(`(?:const|let)\\s+${varName}\\s*=\\s*\\w+\\s*\\.\\s*indexOf\\s*\\(\\s*(['"])((?:[^\\\\'"\\n]|\\\\.)*)\\1`);
        const dm = decl.exec(text);
        if (dm) literal = dm[2];
      }
    }
    if (literal && literal.length >= 4) anchoredAt.set(target, { literal, source });
  }

  for (const m of text.matchAll(ASSERT_MATCH)) {
    const { args } = splitCallArgs(text, m.index + m[0].length);
    if (args.length < 2) continue;
    const haystack = args[0].trim();
    const anchor = anchoredAt.get(haystack);
    if (!anchor) continue;
    const needed = literalPrefix(args[1]);
    if (!needed) continue;
    // True by construction: the window starts AT the anchor literal, so any pattern
    // the anchor itself satisfies is already matched.
    if (anchor.literal.startsWith(needed)) {
      hits.push({
        line: lineOf(text, m.index),
        anchor: anchor.literal,
        needed,
        statement: enclosingStatement(text, m.index).slice(0, 120),
      });
    }
  }
  return hits;
}

/** Candidate files in scope. */
export function scanScope(root = ROOT) {
  return topLevelFiles(join(root, 'scripts', 'schema'), (n) => n.endsWith('.test.mjs'));
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
  const fixture = join(ROOT, 'test-fixtures', 'tautology-sample.mjs');
  const code = report({
    name: 'tautology-scan',
    scopeDescription: SCOPE_DESCRIPTION,
    candidates: scanScope(),
    found: findAll(),
    expected: KNOWN,
    sentinelCount: CANDIDATE_SENTINEL,
    fixture: { path: 'test-fixtures/tautology-sample.mjs', hit: analyze(fixture).length > 0 },
  });
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
