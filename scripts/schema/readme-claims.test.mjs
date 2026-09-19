/**
 * The README must not promise what the code does not do.
 *
 * This is not pedantry: the README is the only thing an external installer reads
 * before trusting the plugin with their memory store. A stale boundary statement
 * ("multiple processes are unsupported" after a lock was added, or the reverse)
 * is a documentation bug that costs a user their data or their trust.
 *
 * Only claims that can be mechanically checked are checked here. Prose quality is
 * not the target; contradictions with the shipped code are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { functionBody, enclosingStatement, splitCallArgs, lineOf } from './source-scope.mjs';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const index = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../../lib/spec.js', import.meta.url), 'utf8');

/** The current version's section, so a claim from an older release cannot satisfy a check. */
function currentSection() {
  const start = readme.indexOf(`## What's new in v${pkg.version}`);
  assert.ok(start > 0, `README must have a "What's new in v${pkg.version}" section`);
  const next = readme.indexOf("\n## What's new in v", start + 10);
  return readme.slice(start, next === -1 ? readme.length : next);
}

/**
 * A PATCH release (x.y.Z, Z > 0) ships no new configuration by definition, so the
 * config-table and boundary checks below must read the FEATURE section they belong
 * to (x.y.0) instead of the patch note. Without this, a patch release could only
 * pass by copy-pasting a config table it did not change -- which is exactly the
 * documentation drift this file exists to prevent.
 */
function featureSection() {
  const [maj, min, patch] = pkg.version.split('.');
  if (patch === '0') return currentSection();
  const anchor = `## What's new in v${maj}.${min}.0`;
  const start = readme.indexOf(anchor);
  assert.ok(start > 0,
    `v${pkg.version} is a patch release, so README must still carry the "${anchor}" `
    + 'section that documents the configuration it inherits');
  const next = readme.indexOf("\n## What's new in v", start + 10);
  return readme.slice(start, next === -1 ? readme.length : next);
}

test('the pin URL matches the version being shipped', () => {
  const { version } = pkg;
  assert.match(readme, new RegExp(`releases/download/v${version.replace(/\./g, '\\.')}/dsh-evolve-${version.replace(/\./g, '\\.')}\\.tgz`),
    `the README install command must point at v${version}; a stale pin sends users to `
    + 'a release that does not exist yet');
});

test('every documented config key exists in the schema', () => {
  const section = featureSection();
  // The config table rows look like: | `key` | `default` | effect |
  const rows = [...section.matchAll(/^\|\s*`([a-zA-Z]+)`(?:\s*\/\s*`([a-zA-Z]+)`)?\s*\|/gm)];
  assert.ok(rows.length >= 5, `the config table must be parseable (found ${rows.length} rows)`);
  const keys = rows.flatMap((m) => [m[1], m[2]].filter(Boolean));
  for (const k of keys) {
    assert.ok(spec.includes(k) || index.includes(k),
      `README documents config key "${k}" but it appears in neither spec.js nor index.js`);
  }
});

test('documented config defaults match the schema defaults', () => {
  const section = featureSection();
  const rows = [...section.matchAll(/^\|\s*`([a-zA-Z]+)`\s*\|\s*`?([a-zA-Z0-9]+)`?\s*\|/gm)];
  const checked = [];
  for (const [, key, documented] of rows) {
    // Find `key: z.<type>()...default(<value>)` in either file.
    const rx = new RegExp(`${key}:\\s*z\\.[a-zA-Z]+\\(\\)[^,\\n]*?\\.default\\(([^)]*)\\)`);
    const m = rx.exec(spec) ?? rx.exec(index);
    if (!m) continue;
    const actual = m[1].replace(/['"]/g, '').trim();
    checked.push(key);
    assert.equal(actual, documented,
      `README says ${key} defaults to "${documented}" but the schema says "${actual}"`);
  }
  assert.ok(checked.length >= 3,
    `at least a few defaults must be verifiable (checked ${checked.join(', ') || 'none'})`);
});

test('the multi-process boundary describes the lock that exists', () => {
  const section = featureSection();
  // An instance lock IS implemented, so the old "unsupported" claim would now be
  // both wrong and scarier than reality.
  assert.equal(/Multiple processes sharing one evolve workspace are unsupported/.test(section), false,
    'an instance lock is implemented; this boundary statement is stale');
  assert.match(section, /instance lock/i,
    'the boundary section must describe the lock, since the behaviour users see '
    + '(automatic work refusing) is otherwise unexplained');
  // And the claim must match the code: tidy degrades, prune refuses.
  assert.match(index, /lockVerdict\.acquired/, 'tidy must actually check ownership');
  assert.match(index, /pruning is disabled here/, 'prune must actually refuse');
});

test('claims about approval outcomes match the tool', () => {
  const section = featureSection();
  if (!/approval/i.test(section)) return;
  // The README states that cancelling leaves the memory pending and declining
  // reports it rejected. Both are observable in index.js.
  assert.match(index, /cancelled\/unavailable intentionally remain pending/,
    'the fail-closed comment must still describe the code');
  assert.match(index, /wasRejected \? 'rejected'/,
    'a declined memory must report as rejected, as the README claims');
});

test('claims about cross-filesystem behaviour match the protocols', () => {
  const section = featureSection();
  if (!/[Cc]ross-filesystem/.test(section)) return;
  const protocols = readFileSync(new URL('../../lib/publish-protocols.js', import.meta.url), 'utf8');
  // Anchored on the CHECK function, not on the first mention of EXDEV -- the first
  // mention is in the file header comment, and matching a comment would let a
  // deleted implementation pass.
  const fnStart = protocols.indexOf('function assertSameFilesystem');
  assert.ok(fnStart > 0,
    'the same-filesystem check must exist as a named function, so every protocol '
    + 'goes through one implementation instead of repeating the test');
  // Was `slice(fnStart, after === -1 ? fnStart + 1200 : after)`: the fallback arm of
  // that ternary is a character window, and it is the arm that runs whenever the
  // function happens to be the last one in the file. A scope has no fallback arm.
  const checkFn = functionBody(protocols, fnStart);
  // Staging legitimately copies an existing skill tree so a rewrite keeps its
  // references/ and scripts/; the ban applies to the move path only.
  assert.equal(/cpSync|copyFileSync/.test(checkFn), false,
    'the README says cross-filesystem moves fail closed; a copy fallback here would '
    + 'silently give up atomicity for the operation whose whole promise is '
    + 'reversibility');
  assert.match(checkFn, /ok:\s*false|throw/,
    'the check must produce a refusal, not a warning');
  // And it must be consulted by the publish paths rather than merely defined.
  const uses = (protocols.match(/assertSameFilesystem\(/g) ?? []).length;
  assert.ok(uses >= 3,
    `every publishing protocol must consult it (found ${uses} call sites)`);
});

test('the archive claim matches how archives are actually named', () => {
  const section = featureSection();
  if (!/archiveId/.test(section)) return;
  const ops = readFileSync(new URL('../../lib/skill-operations.js', import.meta.url), 'utf8');
  assert.match(ops, /archiveId/, 'archives must genuinely be addressed by id');
  assert.match(index, /listArchives/, 'and the id must be reachable from the host wiring');
});

test('the rollback claim matches the tool', () => {
  const section = featureSection();
  if (!/skill_rollback/.test(section)) return;
  // The README says rollback only ever creates a proposal. If the tool could roll
  // back directly, that sentence would be actively dangerous advice.
  const start = index.indexOf("name: 'skill_rollback'");
  assert.ok(start > 0, 'the tool must exist');
  // Was `slice(start, start + 2000)` with 596 characters of real headroom -- 2432
  // characters of comment turned it red. The tool is one object literal, so read
  // exactly that object.
  const block = enclosingStatement(index, start);
  assert.match(block, /proposalStore\.create/, 'it must create a proposal');
  assert.match(block, /sealRollbackArtifact/, 'and pin the artifact by hash');
  assert.equal(/skillTx\.rollbackSkill/.test(block), false,
    'the tool must not perform the rollback itself');
});


/**
 * The platform row is a boundary claim like any other, and it was WRONG in v0.6.0:
 * it said "Windows is untested", which reads as "some edges may be rough". The
 * truth was that ProposalStore.create() threw EPERM on Windows, so skill evolution
 * in the DEFAULT approval modes did not work at all. Once the fsync guards exist,
 * the row must not still describe an untested platform.
 */
test('the platform row matches the fsync guards that are shipped', () => {
  const proposals = readFileSync(new URL('../../lib/skill-proposals.js', import.meta.url), 'utf8');
  const guarded = /FSYNC_SOFT_FAIL/.test(proposals) && /openSync\(p, 'r\+'\)/.test(proposals);
  const row = readme.split('\n').find((l) => /^\|\s*(Linux|Windows)/.test(l) && /Windows/.test(l));
  assert.ok(row, 'README must carry a platform-support row mentioning Windows');
  if (guarded) {
    assert.equal(/Windows is untested/.test(row), false,
      'the Windows fsync guards are shipped, so "Windows is untested" is stale: it '
      + 'both understates what was broken before and hides that it is now covered');
    assert.match(row, /Windows/,
      'the row must still state the platform position explicitly');
  }
});

test('the README claim that no gate uses a character window is true', () => {
  // README says "no gate in scripts/schema/ judges adjacency by character count any
  // more". That is a countable claim, so count it here rather than trusting prose:
  // v0.6.5's README said "two guards" while ten existed.
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  if (!/judges adjacency by character count/.test(readme)) return;

  const dir = new URL('.', import.meta.url);
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    // source-scope.mjs is the replacement mechanism: its cursor arithmetic
    // (`slice(from, i + 1)`) is how a scope END is computed, not an adjacency window.
    if (name === 'source-scope.mjs') continue;
    const text = readFileSync(new URL(name, dir), 'utf8');
    for (const m of text.matchAll(/\.(?:slice|substring)\(/g)) {
      // Prose describing the windows this release removed is not a window. Skip any
      // match inside a comment -- without this the fix's own explanation trips it.
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const before = text.slice(lineStart, m.index);
      if (/^\s*(?:\/\/|\*|\/\*)/.test(before)) continue;

      const { args } = splitCallArgs(text, m.index + m[0].length);
      if (args.length < 2) continue;
      // The banned shape is a LENGTH added to the start: slice(i, i + 400) with a
      // number large enough to be a character budget. Cursor steps (+ 1, + 2) are
      // ordinary index arithmetic.
      const budget = /\+\s*(\d+)\s*$/.exec(args[1]);
      if (budget && Number(budget[1]) > 10) {
        offenders.push(`${name}:${lineOf(text, m.index)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these gates still use a fixed character window, so the README sentence is false; '
    + 'either fix them with source-scope.mjs or correct the README');
});
