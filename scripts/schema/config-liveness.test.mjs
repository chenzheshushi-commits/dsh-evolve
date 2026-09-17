/**
 * Governance limits must be adjustable at runtime.
 *
 * store.js used to copy the config object in its constructor:
 *
 *   this.config = { ...MEMORY_DEFAULTS, ...(options.config ?? {}) };
 *
 * The host's setConfig() mutates the ORIGINAL object in place, so the copy froze
 * every limit at load time. Lowering maxPendingQueue from 50 to 10 in the settings
 * page returned 200, /state showed 10, and the flood defence kept admitting up to
 * 50 until the process restarted -- the one setting whose whole purpose is to be
 * tightened while something is going wrong.
 *
 * index.js:398 documents this trap for idleTrigger, which avoided it by reading
 * through predicates. The store had the same shape and no such protection, and two
 * consecutive external reviews reported it before it was fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Minimal in-memory stand-in for the host's KvTable. */
function fakeTable() {
  const rows = new Map();
  return {
    get: (k) => rows.get(k),
    put: (k, v) => { rows.set(k, v); },
    delete: (k) => rows.delete(k),
    entries: () => [...rows.entries()],
    keys: () => [...rows.keys()],
    get size() { return rows.size; },
    update: (k, fn) => {
      const cur = rows.get(k);
      if (cur === undefined) throw new Error('missing-key');
      const next = fn(cur);
      rows.set(k, next);
      return next;
    },
  };
}

async function makeStore(cfg) {
  const { MemoryStore } = await import('../../lib/store.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-evolve-cfg-'));
  const store = new MemoryStore(fakeTable(), {
    workspaceDir: root, config: cfg, logger: { warn() {}, info() {} },
  });
  return { store, root };
}

test('a config change made after construction is visible to the store', async () => {
  const cfg = { maxPendingQueue: 50, disposalMinIdleDays: 30 };
  const { store, root } = await makeStore(cfg);
  try {
    assert.equal(store.config.maxPendingQueue, 50, 'the initial value must come through');

    // Exactly what the host's setConfig does: mutate the same object in place.
    Object.assign(cfg, { maxPendingQueue: 10 });

    assert.equal(store.config.maxPendingQueue, 10,
      'the store still sees the old limit: it holds a snapshot, so tightening the '
      + 'flood defence at runtime does nothing until restart');

    Object.assign(cfg, { disposalMinIdleDays: 1 });
    assert.equal(store.config.disposalMinIdleDays, 1,
      'the disposal cooling-off period must also be adjustable at runtime');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaults are still applied for keys the host never set', async () => {
  const { MEMORY_DEFAULTS } = await import('../../lib/spec.js').catch(() => ({ MEMORY_DEFAULTS: null }));
  const cfg = { maxPendingQueue: 7 };            // everything else omitted
  const { store, root } = await makeStore(cfg);
  try {
    assert.equal(store.config.maxPendingQueue, 7, 'an explicit value must win over the default');
    assert.notEqual(store.config.disposalMinIdleDays, undefined,
      'an omitted key must fall back to its default, not to undefined');
    if (MEMORY_DEFAULTS) {
      assert.equal(store.config.disposalMinIdleDays, MEMORY_DEFAULTS.disposalMinIdleDays,
        'the fallback must be the declared default');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Back-filling defaults into the caller's object is the mechanism that makes the
 * above work without touching all 16 `this.config.*` reads. Pin it, so nobody
 * "cleans it up" back into a spread.
 */
test('the store does not copy the config object', () => {
  const text = readFileSync(new URL('../../lib/store.js', import.meta.url), 'utf8');
  const ctor = text.slice(text.indexOf('constructor(table'), text.indexOf('constructor(table') + 1600);
  assert.equal(/this\.config\s*=\s*\{\s*\.\.\./.test(ctor), false,
    'spreading into this.config recreates the snapshot bug: setConfig mutates the '
    + 'original object, so a copy can never see later changes');
  assert.match(ctor, /this\.config\s*=\s*live/,
    'the store must hold the host\'s own config object');
});

/**
 * End-to-end: drive the REAL web route the settings page calls, then read the REAL
 * store the plugin built.
 *
 * The v0.6.3 version of this test matched /Object\.assign\(\s*(\w+)\s*,/ against
 * index.js and compared identifiers. Two measured problems with that:
 *
 *   - it rejected `for (const [k,v] of Object.entries(patch)) cfg[k] = v`, a change
 *     with byte-for-byte identical behaviour. A guard that fails correct refactors
 *     teaches people to ignore red.
 *   - it caught the real defect (assigning onto a copy) only as a side effect of a
 *     `writes.length >= 2` count, not through the rule it claimed to enforce.
 *
 * Judging config wiring by the shape of an assignment expression is the same mistake
 * the fsync gate made by judging a handle by its variable name. So this asserts the
 * behaviour instead: POST the action the frontend posts, and check the store moved.
 */
test('POST set-config reaches the live store (end to end)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-evolve-e2e-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const openedDomains = new Map();
    const routes = [];
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      storageDomain: {
        get: (name) => openedDomains.get(name),
        open: async (decl) => {
          const tables = new Map();
          const d = {
            table(n) { if (!tables.has(n)) tables.set(n, fakeTable()); return tables.get(n); },
            close() {},
          };
          openedDomains.set(decl.name, d);
          return d;
        },
      },
      tools: { register() {}, get: () => undefined },
      systemPrompt: { section() {}, context() {}, variable() {} },
      on: () => {},
      effect: () => {},
      get: () => ({ currentInitiator: () => undefined }),
      llm: { stream: async function* () { /* not called */ } },
      plugin(child, cfg2) {
        const deps = child?.inject ?? [];
        if (deps.every((d) => ctx[d] !== undefined) && typeof child?.apply === 'function') {
          void child.apply(ctx, cfg2);
        }
      },
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };

    const mod = await import('../../lib/index.js');
    await mod.apply(ctx, { maxPendingQueue: 50, disposalMinIdleDays: 30 });

    const routeFor = (path) => {
      const r = routes.find((x) => x.path === path);
      assert.ok(r, `the plugin must register ${path}`);
      return r;
    };
    const action = routeFor('/api/evolve/action');
    const state = routeFor('/api/evolve/state');

    // Same shape as webroutes-e2e.mjs: a loopback request, JSON body for POST.
    const call = async (route, body) => {
      const req = {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        socket: { remoteAddress: '127.0.0.1' },
        url: route.path,
      };
      req[Symbol.asyncIterator] = async function* () {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      };
      let status = 0;
      let payload = null;
      const res = {
        setHeader() {},
        writeHead(s) { status = s; return res; },
        end(b) { try { payload = JSON.parse(String(b)); } catch { payload = String(b); } },
      };
      await route.handler(req, res);
      return { status, payload };
    };
    const post = (body) => call(action, body);

    const before = await post({ action: 'set-config', maxPendingQueue: 10 });
    assert.equal(before.status, 200,
      `set-config must succeed (got ${before.status}: ${JSON.stringify(before.payload)})`);

    assert.ok(openedDomains.has('evolve_memory'), 'the memory domain must be open');
    assert.equal(before.payload?.config?.maxPendingQueue, 10,
      'the route must report the new value');

    // The point of this test is the STORE, not the echoed response. /state renders
    // its view from the same object the store holds, so a snapshotting store shows
    // the stale limit here even though the POST above answered 200.
    const view = await call(state);
    assert.equal(view.status, 200, `/state must answer (got ${view.status})`);
    assert.equal(view.payload?.config?.maxPendingQueue, 10,
      'the write reached the route but not the live config: the settings page would '
      + 'report success while the flood defence kept its old limit until restart');

    const second = await post({ action: 'set-config', disposalMinIdleDays: 1 });
    assert.equal(second.status, 200, 'a second write must also succeed');
    assert.equal(second.payload?.config?.disposalMinIdleDays, 1,
      'the second key must round-trip too');
    // And the first key must not have been clobbered -- proof the writes land on one
    // shared object rather than on per-request copies.
    assert.equal(second.payload?.config?.maxPendingQueue, 10,
      'the earlier change was lost: each write is landing on a fresh copy, which is '
      + 'exactly the snapshot bug one layer up');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
});
