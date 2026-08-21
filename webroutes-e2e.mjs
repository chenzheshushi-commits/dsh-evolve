// v0.3.0 web-routes e2e: drive makeEvolveRoutes handlers with a real MemoryStore
// + mock req/res, proving /api/evolve/state and /api/evolve/action work end to
// end (loopback fence, config read, batch-confirm, set-config). No server needed.
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ws = mkdtempSync(join(tmpdir(), 'evolve-webroutes-'));
process.env.DSH_HOME = ws;

const { MemoryStore } = await import('./lib/store.js');
const { makeEvolveRoutes } = await import('./lib/web-routes.js');

function makeTable() {
  const m = new Map();
  return {
    put(k, v) { m.set(k, v); return true; }, get(k) { return m.get(k); },
    delete(k) { return m.delete(k); }, entries() { return [...m.entries()]; },
    get size() { return m.size; },
  };
}

// Mock a trusted loopback request + a capturing response.
function mockReq({ method = 'GET', body } = {}) {
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
  };
  // async-iterable body for POST
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
const routeMap = (routes) => Object.fromEntries(routes.map((r) => [r.path, r]));

const cfg = {
  refineLLM: true, refineProvider: '', refineModel: '', tier1Enabled: true,
  maxRecords: 400, maxContentChars: 2000, mergeSimilarity: 0.7,
  recencyHalfLifeDays: 90, recallLimit: 5, injectCount: 3, injectMaxChars: 1200,
};
const store = new MemoryStore(makeTable(), { workspaceDir: ws, config: cfg, logger: { warn() {}, info() {} } });

// mock llm service for the models list (passed as a value, not via ctx)
const llm = { listProviders: () => [{ id: 'p1' }], listModels: async () => [{ id: 'm1' }, { id: 'm2' }] };

const routes = makeEvolveRoutes({
  store, llm,
  getConfig: () => cfg,
  setConfig: (patch) => { Object.assign(cfg, patch); },
  skillStates: () => ({ counts: { active: 0, stale: 0, archived: 0 }, triage: { disabled: true } }),
});
const R = routeMap(routes);
assert.ok(R['/api/evolve/state'] && R['/api/evolve/action'], 'both routes present');

// seed one pending memory
await store.remember({ content: '一条待确认记忆', kind: 'note', importance: 2, scope: 'project' });

// GET /state
{
  const res = mockRes();
  await R['/api/evolve/state'].handler(mockReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 200, 'state 200');
  const j = JSON.parse(res.body);
  assert.ok(j.ok && j.config.refineLLM === true, 'state returns config (refineLLM on)');
  assert.equal(j.models.length, 2, 'state returns configured models (2)');
  assert.equal(j.memoryStats.pending, 1, 'state shows 1 pending');
  assert.equal(j.memoryStats.pendingQueue.length, 1, 'state pendingQueue lists it');
  console.log('OK web /state: config + models(2) + pending queue(1)');
}

// loopback fence: a non-loopback request is 403
{
  const badReq = mockReq({ method: 'GET' });
  badReq.socket.remoteAddress = '8.8.8.8';
  const res = mockRes();
  await R['/api/evolve/state'].handler(badReq, res);
  assert.equal(res.statusCode, 403, 'non-loopback -> 403 (fence works)');
  console.log('OK web fence: non-loopback request refused 403');
}

// POST /action set-config (pick a model + turn refine off)
{
  const res = mockRes();
  await R['/api/evolve/action'].handler(mockReq({ method: 'POST', body: { action: 'set-config', refineLLM: false, refineProvider: 'p1', refineModel: 'm2' } }), res);
  assert.equal(res.statusCode, 200, 'set-config 200');
  assert.equal(cfg.refineLLM, false, 'set-config mutated cfg.refineLLM -> false');
  assert.equal(cfg.refineModel, 'm2', 'set-config mutated cfg.refineModel -> m2');
  console.log('OK web set-config: toggles refineLLM + picks model (mutates live cfg)');
}

// POST /action confirm-batch (confirms the pending memory)
{
  const res = mockRes();
  await R['/api/evolve/action'].handler(mockReq({ method: 'POST', body: { action: 'confirm-batch' } }), res);
  assert.equal(res.statusCode, 200, 'confirm-batch 200');
  const j = JSON.parse(res.body);
  assert.equal(j.confirmed, 1, 'confirm-batch confirmed 1');
  assert.equal(store.list({ pending: true }).length, 0, 'no pending left after batch confirm');
  console.log('OK web confirm-batch: confirmed 1, pending queue drained');
}

rmSync(ws, { recursive: true, force: true });
console.log('\nWEB-ROUTES E2E PASSED');
