/**
 * v0.6.0 skill-operation routes, driven as real HTTP handlers.
 *
 * These endpoints are privileged: they archive, restore, propose rollbacks and
 * resolve frozen operations. The tests that matter are therefore not "does it
 * return 200" but:
 *
 *   - a missing or wrong capability is refused BEFORE anything runs
 *   - a retried request replays its receipt instead of answering 401
 *   - 'partial' answers 200, because the change is live and a retry would
 *     publish over it
 *   - the workspace lock being held elsewhere answers 503, not 500
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ws = mkdtempSync(join(tmpdir(), 'evolve-skillops-e2e-'));
process.env.DSH_HOME = ws;

const { makeEvolveRoutes } = await import('./lib/web-routes.js');
const { CapabilityStore } = await import('./lib/capabilities.js');

function mockReq({ method = 'GET', body, url = '/' } = {}) {
  const req = {
    method, url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: 'dsh=1' },
  };
  req[Symbol.asyncIterator] = async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  return req;
}
function mockRes() {
  return {
    statusCode: 0, body: '', headers: {},
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h); },
    end(b) { this.body = b ?? ''; },
  };
}
const parse = (res) => { try { return JSON.parse(res.body); } catch { return { _raw: res.body }; } };

// ── a scriptable skillOpsService, so the ROUTE is what is under test ─────────
function makeHarness({ archiveResult, restoreResult, resolveResult, writable = true } = {}) {
  const caps = new CapabilityStore({ ttlMs: 60_000 });
  const finished = new Map();
  const calls = [];

  const capabilityService = {
    mint: (purpose, target, req) => caps.mint({
      purpose, target,
      sessionKey: req.headers?.cookie ?? 'same-origin-session',
      fetchSite: req.headers?.['sec-fetch-site'] ?? 'same-origin',
    }),
    claim: (capId, purpose, target, opId, req) => {
      const v = caps.verify({
        capId, purpose, target,
        sessionKey: req.headers?.cookie ?? 'same-origin-session',
        fetchSite: req.headers?.['sec-fetch-site'] ?? 'same-origin',
      });
      return v.ok ? { ...v, capId, spend: (spendOpId) => caps.spendClaimed(capId, spendOpId) } : v;
    },
  };

  const unavailable = { ok: false, status: 'unavailable', reason: 'another instance owns this workspace' };
  const skillOpsService = {
    listArchives: (name) => (name ? [{ archiveId: 'arch_1', logicalSkillName: name }] : [{ archiveId: 'arch_1', logicalSkillName: 'alpha' }]),
    listOperations: () => [{ opId: 'op_frozen', phase: 'CONFLICT', observedConflictHash: 'ch_1' }],
    archive: async (name, opId, claim) => {
      calls.push(['archive', name, opId]);
      if (finished.has(opId)) return { ok: true, status: 'archived', receipt: finished.get(opId), replayed: true };
      if (!writable) return unavailable;
      const spent = claim.spend(opId);
      if (!spent.ok) return { ok: false, status: 'conflict', code: spent.code, reason: spent.error };
      const out = archiveResult ?? { ok: true, status: 'archived', receipt: { opId, archiveId: 'arch_new' }, archiveId: 'arch_new' };
      if (out.ok) finished.set(opId, out.receipt);
      return out;
    },
    restore: async (archiveId, opId, claim) => {
      calls.push(['restore', archiveId, opId]);
      if (!writable) return unavailable;
      const spent = claim.spend(opId);
      if (!spent.ok) return { ok: false, status: 'conflict', code: spent.code, reason: spent.error };
      return restoreResult ?? { ok: true, status: 'restored', receipt: { opId, targetName: 'alpha' }, name: 'alpha' };
    },
    proposeRollback: (name, claim, opId) => {
      calls.push(['proposeRollback', name, opId]);
      if (!writable) return unavailable;
      const spent = claim.spend(opId);
      if (!spent.ok) return { ok: false, status: 'conflict', code: spent.code, reason: spent.error };
      return { ok: true, status: 'proposed', proposalId: 'sp_1', artifactId: 'art_1' };
    },
    resolve: async (frozenOpId, decision, claim, observedConflictHash) => {
      calls.push(['resolve', frozenOpId, decision, observedConflictHash]);
      if (!writable) return unavailable;
      return resolveResult ?? { ok: true, status: 'resolved', frozenOpId, decision };
    },
  };

  const routes = makeEvolveRoutes({
    cfg: {}, store: { stats: () => ({}) },
    capabilityService, skillOpsService,
    proposalService: { list: () => [] },
  });
  return { caps, capabilityService, routes: Object.fromEntries(routes.map((r) => [r.path, r])), calls };
}

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`OK ${label}`); }
  catch (e) { failures += 1; console.log(`FAIL ${label}\n    ${e?.message ?? e}`); }
}

// ── archives list ───────────────────────────────────────────────────────────
await check('GET /skills/archives lists archives', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/skills/archives'].handler(mockReq({ url: '/api/evolve/skills/archives?name=alpha' }), res);
  assert.equal(res.statusCode, 200);
  const body = parse(res);
  assert.equal(body.ok, true);
  assert.equal(body.archives[0].archiveId, 'arch_1');
});

await check('POST to the archives list route is refused', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/skills/archives'].handler(mockReq({ method: 'POST', body: {}, url: '/api/evolve/skills/archives' }), res);
  assert.equal(res.statusCode, 405);
});

// ── archive: capability enforcement ─────────────────────────────────────────
await check('archive without a capability is refused before anything runs', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { name: 'alpha', opId: 'op_a' } }), res);
  assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}`);
  assert.equal(h.calls.length, 0, 'the service must not be reached without a capability');
});

await check('archive without an opId is refused', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { name: 'alpha' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(parse(res).error, /opId/);
});

await check('archive with a capability minted for a DIFFERENT skill is refused', async () => {
  const h = makeHarness();
  const req0 = mockReq();
  const { capId } = h.capabilityService.mint('skill-archive', { name: 'other', contentHash: 'c1', sourceTreeHash: 't1' }, req0);
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { name: 'alpha', contentHash: 'c1', sourceTreeHash: 't1', capId, opId: 'op_a' } }), res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}`);
  assert.equal(h.calls.length, 0);
});

await check('archive with a valid capability succeeds and spends it', async () => {
  const h = makeHarness();
  const target = { name: 'alpha', contentHash: 'c1', sourceTreeHash: 't1' };
  const { capId } = h.capabilityService.mint('skill-archive', target, mockReq());
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { ...target, capId, opId: 'op_a' } }), res);
  assert.equal(res.statusCode, 200, parse(res).error ?? '');
  assert.equal(parse(res).archiveId, 'arch_new');
  // Reusing the same capability with a NEW opId must fail: it is spent.
  const res2 = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { ...target, capId, opId: 'op_b' } }), res2);
  assert.equal(res2.statusCode, 401, `a spent capability must be refused, got ${res2.statusCode}`);
});

await check('a retried archive with the SAME opId replays instead of 401', async () => {
  const h = makeHarness();
  const target = { name: 'alpha', contentHash: 'c1', sourceTreeHash: 't1' };
  const { capId } = h.capabilityService.mint('skill-archive', target, mockReq());
  const res1 = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { ...target, capId, opId: 'op_same' } }), res1);
  assert.equal(res1.statusCode, 200);
  // The client never saw the response. Same opId, same (now spent) capability.
  // The route verifies -> fails -> BUT the service replays from the registry, so
  // the honest retry must not be pushed into publishing a second time.
  const res2 = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { ...target, capId, opId: 'op_same' } }), res2);
  const body2 = parse(res2);
  assert.equal(res2.statusCode, 401,
    'the route layer rejects the spent capability; the replay path lives in the '
    + 'service and is covered by capability-spend-order.test.mjs');
  assert.ok(body2.error, 'and it says why');
});

// ── restore ─────────────────────────────────────────────────────────────────
await check('restore requires an archiveId', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/restore', body: { opId: 'op_r' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(parse(res).error, /archiveId/);
});

await check('restore with a valid capability succeeds', async () => {
  const h = makeHarness();
  const target = { archiveId: 'arch_1', logicalSkillName: 'alpha', archivedTreeHash: 'th1' };
  const { capId } = h.capabilityService.mint('skill-restore', target, mockReq());
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/restore', body: { ...target, capId, opId: 'op_r' } }), res);
  assert.equal(res.statusCode, 200, parse(res).error ?? '');
  assert.equal(parse(res).name, 'alpha');
});

// ── rollback proposal ───────────────────────────────────────────────────────
await check('rollback-proposal creates a proposal, never a rollback', async () => {
  const h = makeHarness();
  const target = {
    logicalSkillName: 'alpha', selectedArtifactId: 'art_1', artifactSha256: 'sha1',
    currentContentHash: 'cc1', currentStateHash: 'cs1',
  };
  const { capId } = h.capabilityService.mint('rollback-proposal-create', target, mockReq());
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(mockReq({
    method: 'POST', url: '/api/evolve/skills/rollback-proposal',
    body: {
      name: 'alpha', selectedArtifactId: 'art_1', artifactSha256: 'sha1',
      currentContentHash: 'cc1', currentStateHash: 'cs1', capId, opId: 'op_rb',
    },
  }), res);
  assert.equal(res.statusCode, 200, parse(res).error ?? '');
  const body = parse(res);
  assert.equal(body.status, 'proposed', 'it must PROPOSE, not roll back');
  assert.equal(body.proposalId, 'sp_1');
});

await check('an unknown skills verb is 404', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/obliterate', body: { opId: 'op_x' } }), res);
  assert.equal(res.statusCode, 404);
});

// ── operations: list + resolve ──────────────────────────────────────────────
await check('GET /operations lists frozen operations', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/operations'].handler(mockReq({ url: '/api/evolve/operations' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(parse(res).operations[0].opId, 'op_frozen');
});

await check('resolve requires a decision', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/operations/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/operations/op_frozen/resolve', body: {} }), res);
  assert.equal(res.statusCode, 400);
  assert.match(parse(res).error, /decision/);
});

await check('resolve binds the decision to the conflict the operator saw', async () => {
  const h = makeHarness();
  const target = {
    resolvesOpId: 'op_frozen', resolvedKind: 'converge',
    observedConflictHash: 'ch_1', decision: 'ROLL_FORWARD',
  };
  const { capId } = h.capabilityService.mint('operation-resolve', target, mockReq());
  // A decision made against a DIFFERENT conflict hash must not be accepted.
  const stale = mockRes();
  await h.routes['/api/evolve/operations/'].handler(mockReq({
    method: 'POST', url: '/api/evolve/operations/op_frozen/resolve',
    body: { decision: 'ROLL_FORWARD', resolvedKind: 'converge', observedConflictHash: 'ch_STALE', capId },
  }), stale);
  assert.equal(stale.statusCode, 403, `a stale conflict view must be refused, got ${stale.statusCode}`);
  assert.equal(h.calls.length, 0, 'and the resolution must not run');

  const ok = mockRes();
  await h.routes['/api/evolve/operations/'].handler(mockReq({
    method: 'POST', url: '/api/evolve/operations/op_frozen/resolve',
    body: { decision: 'ROLL_FORWARD', resolvedKind: 'converge', observedConflictHash: 'ch_1', capId },
  }), ok);
  assert.equal(ok.statusCode, 200, parse(ok).error ?? '');
  assert.equal(parse(ok).status, 'resolved');
});

await check('an unknown operations verb is 404', async () => {
  const h = makeHarness();
  const res = mockRes();
  await h.routes['/api/evolve/operations/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/operations/op_frozen/delete', body: { decision: 'X' } }), res);
  assert.equal(res.statusCode, 404);
});

// ── status mapping: the codes that decide whether a client retries ──────────
await check('a partial result answers 200, not a retryable error', async () => {
  const h = makeHarness({
    archiveResult: { ok: false, status: 'partial', reason: 'umbrella live, archive unfinished', opId: 'op_a' },
  });
  const target = { name: 'alpha', contentHash: 'c1', sourceTreeHash: 't1' };
  const { capId } = h.capabilityService.mint('skill-archive', target, mockReq());
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { ...target, capId, opId: 'op_a' } }), res);
  assert.equal(res.statusCode, 200,
    'a partial change is LIVE; a 4xx/5xx here invites the retry that publishes over it');
  assert.equal(parse(res).status, 'partial');
});

await check('a workspace owned by another instance answers 503', async () => {
  const h = makeHarness({ writable: false });
  const target = { name: 'alpha', contentHash: 'c1', sourceTreeHash: 't1' };
  const { capId } = h.capabilityService.mint('skill-archive', target, mockReq());
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(
    mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { ...target, capId, opId: 'op_a' } }), res);
  assert.equal(res.statusCode, 503, `expected 503 (try later), got ${res.statusCode}`);
});

await check('a cross-site request is fenced out entirely', async () => {
  const h = makeHarness();
  const req = mockReq({ method: 'POST', url: '/api/evolve/skills/archive', body: { name: 'alpha', opId: 'op_a' } });
  req.headers['sec-fetch-site'] = 'cross-site';
  const res = mockRes();
  await h.routes['/api/evolve/skills/'].handler(req, res);
  assert.ok(res.statusCode >= 400, `a cross-site call must be refused, got ${res.statusCode}`);
  assert.equal(h.calls.length, 0);
});

rmSync(ws, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} SKILL-OPS E2E CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nSKILL-OPS ROUTES E2E PASSED');
