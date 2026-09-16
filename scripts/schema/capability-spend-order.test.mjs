/**
 * The capability spend ordering, at the seam where it actually matters.
 *
 * Two rules meet on the apply route and used to contradict each other:
 *
 *   - the same opId retried is idempotent and returns the original receipt
 *   - a spent capability is rejected with 401
 *
 * If the route spends the capability before the operation registry is consulted,
 * a retried apply hits rule 2 and never reaches rule 1 -- so the client that lost
 * its response can never learn the operation succeeded, and the honest thing it
 * does next (retry with a fresh capability) publishes the change twice.
 *
 * These tests pin the resolution: verify first, replay check, then spend.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityStore } from '../../lib/capabilities.js';

const SESSION = 'cookie=abc';
const SITE = 'same-origin';

function store() {
  return new CapabilityStore({ ttlMs: 60_000 });
}

function target(hash = 'h1') {
  return { proposalId: 'p_1', proposalHash: hash, baseHashes: { 'SKILL.md': 'b1' } };
}

function mint(s, t = target()) {
  return s.mint({ purpose: 'proposal-apply', target: t, sessionKey: SESSION, fetchSite: SITE });
}

test('verify accepts a valid capability without spending it', () => {
  const s = store();
  const { capId } = mint(s);
  const first = s.verify({ capId, purpose: 'proposal-apply', target: target(), sessionKey: SESSION, fetchSite: SITE });
  assert.equal(first.ok, true);
  assert.equal(first.spent, false, 'verify must not consume');
  // The whole point: verifying twice is fine, because nothing was burned.
  const second = s.verify({ capId, purpose: 'proposal-apply', target: target(), sessionKey: SESSION, fetchSite: SITE });
  assert.equal(second.ok, true, 'a verified-but-unspent capability is still usable');
});

test('verify rejects exactly what consume rejects', () => {
  const cases = [
    ['unknown capability', (s) => ({ capId: 'cap_nope', target: target(), sessionKey: SESSION, fetchSite: SITE }), 401],
    ['changed target', (s) => ({ capId: mint(s).capId, target: target('CHANGED'), sessionKey: SESSION, fetchSite: SITE }), 403],
    ['other session', (s) => ({ capId: mint(s).capId, target: target(), sessionKey: 'cookie=other', fetchSite: SITE }), 403],
    ['cross-site', (s) => ({ capId: mint(s).capId, target: target(), sessionKey: SESSION, fetchSite: 'cross-site' }), 403],
  ];
  for (const [label, build, code] of cases) {
    const sv = store(); const sc = store();
    const argsV = build(sv); const argsC = build(sc);
    const v = sv.verify({ purpose: 'proposal-apply', ...argsV });
    const c = sc.consume({ purpose: 'proposal-apply', ...argsC, opId: 'op_1' });
    assert.equal(v.ok, false, `${label}: verify must refuse`);
    assert.equal(c.ok, false, `${label}: consume must refuse`);
    assert.equal(v.code, code, `${label}: verify code`);
    assert.equal(v.code, c.code,
      `${label}: verify and consume must agree, or the pre-check would let through `
      + 'something the spend then rejects after the operation already ran');
    assert.equal(v.error, c.error, `${label}: same reason`);
  }
});

test('a verified capability is spent exactly once', () => {
  const s = store();
  const { capId } = mint(s);
  assert.equal(s.verify({ capId, purpose: 'proposal-apply', target: target(), sessionKey: SESSION, fetchSite: SITE }).ok, true);
  const first = s.spendClaimed(capId, 'op_a');
  assert.equal(first.ok, true);
  assert.equal(first.claim.state, 'claimed');
  assert.equal(first.claim.claimedByOpId, 'op_a', 'the manifest must name the op that spent it');
  // Two requests can both pass verify; only one may spend.
  const second = s.spendClaimed(capId, 'op_b');
  assert.equal(second.ok, false, 'the second spend must lose');
  assert.equal(second.code, 409);
});

test('a spent capability no longer verifies', () => {
  const s = store();
  const { capId } = mint(s);
  assert.equal(s.spendClaimed(capId, 'op_a').ok, true);
  const v = s.verify({ capId, purpose: 'proposal-apply', target: target(), sessionKey: SESSION, fetchSite: SITE });
  assert.equal(v.ok, false, 'spending must close the capability for later verifies too');
  assert.equal(v.code, 401);
});

test('an expired capability cannot be spent even after a successful verify', () => {
  let clock = 1_000;
  const s = new CapabilityStore({ ttlMs: 5_000, now: () => clock });
  const { capId } = s.mint({ purpose: 'proposal-apply', target: target(), sessionKey: SESSION, fetchSite: SITE });
  assert.equal(s.verify({ capId, purpose: 'proposal-apply', target: target(), sessionKey: SESSION, fetchSite: SITE }).ok, true);
  // The gap between verify and spend is real: the registry lookup happens there.
  clock += 10_000;
  const spent = s.spendClaimed(capId, 'op_a');
  assert.equal(spent.ok, false, 'expiry must be re-checked at spend time, not only at verify');
  assert.equal(spent.code, 401);
});

test('the route ordering lets a retried apply replay instead of answering 401', () => {
  // A miniature of the real route + service, so the ORDER is what is under test.
  const s = store();
  const { capId } = mint(s);
  const finished = new Map();

  const route = (capIdIn, opId) => {
    // 1. verify, do not spend
    const claim = s.verify({ capId: capIdIn, purpose: 'proposal-apply', target: target(), sessionKey: SESSION, fetchSite: SITE });
    // 2. the service answers from the registry BEFORE any spend
    const replay = finished.get(opId);
    if (replay) return { http: 200, body: { ok: true, status: 'applied', receipt: replay, replayed: true } };
    if (!claim.ok) return { http: claim.code, body: { ok: false, error: claim.error } };
    // 3. only now is it spent
    const spent = s.spendClaimed(capIdIn, opId);
    if (!spent.ok) return { http: spent.code, body: { ok: false, error: spent.error } };
    const receipt = { opId, targetName: 'alpha' };
    finished.set(opId, receipt);
    return { http: 200, body: { ok: true, status: 'applied', receipt } };
  };

  const first = route(capId, 'op_apply_1');
  assert.equal(first.http, 200);
  assert.equal(first.body.status, 'applied');

  // The client never saw the response and retries the SAME opId.
  const retry = route(capId, 'op_apply_1');
  assert.equal(retry.http, 200,
    'the retry must replay; a 401 here is what pushes a client into publishing twice');
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.receipt, first.body.receipt, 'the same receipt, not a new operation');

  // A different opId reusing the spent capability is still refused.
  const reuse = route(capId, 'op_apply_2');
  assert.equal(reuse.body.ok, false, 'replay protection must survive the reordering');
  assert.equal(reuse.http, 401);
});
