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
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const index = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../../lib/spec.js', import.meta.url), 'utf8');

/** The v0.6.0 section, so a claim from an older release cannot satisfy a check. */
function currentSection() {
  const start = readme.indexOf(`## What's new in v${pkg.version}`);
  assert.ok(start > 0, `README must have a "What's new in v${pkg.version}" section`);
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
  const section = currentSection();
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
  const section = currentSection();
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
  const section = currentSection();
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
  const section = currentSection();
  if (!/approval/i.test(section)) return;
  // The README states that cancelling leaves the memory pending and declining
  // reports it rejected. Both are observable in index.js.
  assert.match(index, /cancelled\/unavailable intentionally remain pending/,
    'the fail-closed comment must still describe the code');
  assert.match(index, /wasRejected \? 'rejected'/,
    'a declined memory must report as rejected, as the README claims');
});

test('claims about cross-filesystem behaviour match the protocols', () => {
  const section = currentSection();
  if (!/[Cc]ross-filesystem/.test(section)) return;
  const protocols = readFileSync(new URL('../../lib/publish-protocols.js', import.meta.url), 'utf8');
  // Anchored on the CHECK function, not on the first mention of EXDEV -- the first
  // mention is in the file header comment, and matching a comment would let a
  // deleted implementation pass.
  const fnStart = protocols.indexOf('function assertSameFilesystem');
  assert.ok(fnStart > 0,
    'the same-filesystem check must exist as a named function, so every protocol '
    + 'goes through one implementation instead of repeating the test');
  const after = protocols.indexOf('\nfunction ', fnStart + 10);
  const checkFn = protocols.slice(fnStart, after === -1 ? fnStart + 1200 : after);
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
  const section = currentSection();
  if (!/archiveId/.test(section)) return;
  const ops = readFileSync(new URL('../../lib/skill-operations.js', import.meta.url), 'utf8');
  assert.match(ops, /archiveId/, 'archives must genuinely be addressed by id');
  assert.match(index, /listArchives/, 'and the id must be reachable from the host wiring');
});

test('the rollback claim matches the tool', () => {
  const section = currentSection();
  if (!/skill_rollback/.test(section)) return;
  // The README says rollback only ever creates a proposal. If the tool could roll
  // back directly, that sentence would be actively dangerous advice.
  const start = index.indexOf("name: 'skill_rollback'");
  assert.ok(start > 0, 'the tool must exist');
  const block = index.slice(start, start + 2000);
  assert.match(block, /proposalStore\.create/, 'it must create a proposal');
  assert.match(block, /sealRollbackArtifact/, 'and pin the artifact by hash');
  assert.equal(/skillTx\.rollbackSkill/.test(block), false,
    'the tool must not perform the rollback itself');
});
