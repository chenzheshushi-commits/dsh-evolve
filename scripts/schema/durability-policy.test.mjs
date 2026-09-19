/**
 * The durability policy must stay exhaustive over fsync.js's outcomes.
 *
 * v0.6.4 put EROFS into one of fsync.js's code tables and not the other, inverting
 * "a read-only object must not abort a publish" for that single code. Nothing
 * caught it, because the policy was implicit in those tables -- there was no place
 * a test could read it from. Now DURABILITY_POLICY in lib/publish-protocols.js
 * states it, and this file is what turns "someone added an outcome and forgot the
 * policy" into a red build instead of a silent behaviour change.
 *
 * Deliberately a test and not a load-time invariant: the import chain
 * lib/index.js -> skill-operations.js -> publish-protocols.js is static, so a
 * top-level throw here would reject `import('dsh-evolve')` and take memory_recall
 * down with it. lib/index.js:19 promises apply() never throws into boot, and an
 * import happens before apply. CI is the right place to catch a developer; the
 * runtime already fails closed via DURABILITY_DEFAULT.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FSYNC_FLUSHED, FSYNC_UNSUPPORTED, FSYNC_NOT_WRITABLE,
} from '../../lib/fsync.js';
import {
  DURABILITY_POLICY, DURABILITY_DEFAULT, durabilityDecision,
} from '../../lib/publish-protocols.js';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', '..', 'lib');

/**
 * Every outcome fsync.js can return, discovered from the source rather than from a
 * hand-written list here. A white-list in the test is exactly the shape that let
 * v0.6.1's guard be bypassed by adding a new module: the list was correct the day
 * it was written and wrong the day after.
 */
function declaredOutcomes() {
  const src = readFileSync(join(libDir, 'fsync.js'), 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/^export const FSYNC_[A-Z_]+ = '([a-z-]+)';/gm)) {
    found.add(m[1]);
  }
  return found;
}

test('every fsync outcome declared in fsync.js has a publish policy', () => {
  const outcomes = declaredOutcomes();
  assert.ok(outcomes.size >= 3,
    `expected to discover at least the three known outcomes, found ${[...outcomes]}`);
  // Self-check: the scan must actually be finding the constants, not silently
  // matching nothing and passing. The three below are the ones this version ships.
  for (const known of [FSYNC_FLUSHED, FSYNC_UNSUPPORTED, FSYNC_NOT_WRITABLE]) {
    assert.ok(outcomes.has(known), `scan of fsync.js missed ${known}`);
  }

  const unclassified = [...outcomes].filter((o) => !(o in DURABILITY_POLICY));
  assert.deepEqual(unclassified, [],
    'fsync.js declares an outcome with no entry in DURABILITY_POLICY; decide its '
    + 'policy in lib/publish-protocols.js (proceed | partial | abort)');
});

test('the policy classifies nothing it was not given', () => {
  const outcomes = declaredOutcomes();
  const extra = Object.keys(DURABILITY_POLICY).filter((k) => !outcomes.has(k));
  assert.deepEqual(extra, [],
    'DURABILITY_POLICY names an outcome fsync.js no longer produces -- stale entry');
});

test('a policy decision is derived per outcome, worst case winning', () => {
  assert.equal(durabilityDecision([FSYNC_FLUSHED]).decision, 'proceed');
  assert.equal(durabilityDecision([FSYNC_UNSUPPORTED]).decision, 'proceed',
    'a platform that will not flush directories is not a reason to refuse a publish');
  assert.equal(durabilityDecision([FSYNC_NOT_WRITABLE]).decision, 'partial',
    'a read-only file is published with a degradation note, not aborted');
  assert.equal(
    durabilityDecision([FSYNC_FLUSHED, FSYNC_UNSUPPORTED, FSYNC_NOT_WRITABLE]).decision,
    'partial',
    'partial must win over proceed when both are present');
});

test('an unknown outcome aborts and is named', () => {
  const { decision, unclassified } = durabilityDecision([FSYNC_FLUSHED, 'exploded']);
  assert.equal(decision, DURABILITY_DEFAULT);
  assert.equal(decision, 'abort', 'the default must be fail-closed');
  assert.deepEqual(unclassified, ['exploded'],
    'the abort reason must name the outcome, or an operator cannot act on it');
});

test('the three publish protocols consult the policy before writing a marker', () => {
  const src = readFileSync(join(libDir, 'publish-protocols.js'), 'utf8');
  // Match call sites only: the declaration reads `function durabilityGuard(synced,
  // logger, dir)` and would otherwise be counted as a fourth consumer.
  const guards = [...src.matchAll(/(?<!function )durabilityGuard\(synced, logger, \w+\)/g)];
  assert.equal(guards.length, 3,
    `expected all three publish protocols to consult durabilityGuard, found ${guards.length}`);

  // Ordering is the load-bearing part: a marker written before the check would
  // claim a durable tree that policy had already rejected (plan 0K.6).
  for (const m of src.matchAll(/const synced = fsyncTree\(\w+\);/g)) {
    const after = src.slice(m.index);
    const guardAt = after.indexOf('durabilityGuard(');
    const markerAt = after.indexOf('writeMarker(');
    assert.ok(guardAt > -1, 'an fsyncTree call with no durability guard after it');
    assert.ok(guardAt < markerAt,
      'durabilityGuard must run BEFORE writeMarker, or the marker lies about durability');
  }
});
