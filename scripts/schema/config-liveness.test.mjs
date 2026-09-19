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

/*
 * A text gate on store.js's constructor used to live here, pinning
 * `this.config = live` inside a 1600-character window. It was removed in v0.7.0:
 * three changes with zero behaviour difference each turned it red on their own
 * (renaming `live`, inlining the intermediate variable, and adding 1784 characters
 * of comment above it -- `this.config = live` sits +918 into the constructor, so
 * ordinary comments push it out of the window). Its red said nothing about whether
 * the store still shares the host's object.
 *
 * What it claimed to protect is covered by behaviour instead: the e2e below drives
 * the real route and reads the real store, and goes red when the snapshot bug is
 * reintroduced (verified by injecting `this.config = { ...live }`: 2 of 3 tests fail).
 */

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
    const registeredTools = new Map();
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
      tools: {
        register(t) { registeredTools.set(t.name, t); },
        get: (n) => registeredTools.get(n),
      },
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
    // apply()'s second argument is NOT the object the plugin goes on to share.
    // lib/index.js:212 does `const cfg = { ...MEMORY_DEFAULTS, ...SKILL_DEFAULTS,
    // ...config }`, so what we pass in here is spread into a NEW object immediately.
    // `cfg` is the shared one: getConfig returns it, setConfig does Object.assign on
    // it, and `new MemoryStore({ ..., config: cfg })` hands it to the store. Asserting
    // against this object would therefore prove nothing about liveness -- the earlier
    // comment claimed the opposite and made this test look stronger than it was.
    //
    // Values are deliberately NOT the defaults (50/30). With defaults, "the host's
    // initial value arrived" and "the default was applied" are the same observation,
    // so the e2e below could not tell them apart.
    const hostConfig = { maxPendingQueue: 3, disposalMinIdleDays: 17 };
    await mod.apply(ctx, hostConfig);

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

    // Before touching anything: the value the HOST passed to apply() must be what the
    // plugin is running on. This is why hostConfig above uses 3/17 instead of the
    // defaults -- with 50/30 this assertion would also pass when the host's object was
    // ignored entirely and MEMORY_DEFAULTS filled in the same numbers.
    const initial = await call(state);
    assert.equal(initial.payload?.config?.maxPendingQueue, 3,
      "the host's initial maxPendingQueue must reach the plugin, not be replaced by the default");
    assert.equal(initial.payload?.config?.disposalMinIdleDays, 17,
      "the host's initial disposalMinIdleDays must reach the plugin too");

    const before = await post({ action: 'set-config', maxPendingQueue: 10 });
    assert.equal(before.status, 200,
      `set-config must succeed (got ${before.status}: ${JSON.stringify(before.payload)})`);

    assert.ok(openedDomains.has('evolve_memory'), 'the memory domain must be open');
    assert.equal(before.payload?.config?.maxPendingQueue, 10,
      'the route must report the new value');

    // Both /state and the POST reply render from readConfigView(getConfig()) --
    // the SAME object setConfig writes. Asserting on either only proves the route
    // echoes its own patch, so a store holding a snapshot passes both. Ask the STORE.
    const view = await call(state);
    assert.equal(view.status, 200, `/state must answer (got ${view.status})`);
    assert.equal(view.payload?.config?.maxPendingQueue, 10, 'the route view must move');



    const second = await post({ action: 'set-config', disposalMinIdleDays: 1 });
    assert.equal(second.status, 200, 'a second write must also succeed');
    assert.equal(second.payload?.config?.disposalMinIdleDays, 1,
      'the second key must round-trip too');
    // And the first key must not have been clobbered -- proof the writes land on one
    // shared object rather than on per-request copies.
    assert.equal(second.payload?.config?.maxPendingQueue, 10,
      'the earlier change was lost: each write is landing on a fresh copy, which is '
      + 'exactly the snapshot bug one layer up');

    // Now the part the route view cannot prove. store.remember() enforces the
    // pending-queue cap by reading `this.config.maxPendingQueue` (store.js:399) and
    // returns null once the queue is full. maxPendingQueue is now 1 (set above via
    // the real route), so the SECOND pending write must be refused. A store holding
    // a construction-time copy still believes the cap is 50 and accepts it.
    // Drop the cap to 1 through the same route, so the second write is over it.
    const tighten = await post({ action: 'set-config', maxPendingQueue: 1 });
    assert.equal(tighten.status, 200, `tightening the cap must succeed (got ${tighten.status})`);

    const remember = registeredTools.get('memory_remember');
    assert.ok(remember, 'the plugin must register memory_remember (the store-side probe)');
    // The second argument is the exec context. `confirm` used to be passed here as
    // though the tool might ask for approval; `grep -rn 'exec.confirm' lib/` finds
    // nothing -- memory_remember reads only exec.agent / exec.callId / exec.signal.
    // An empty object is the honest shape, and it keeps this probe from implying a
    // confirmation path that does not exist.
    const write = (content) => remember.execute(
      { content, kind: 'note', importance: 1, scope: 'project' },
      {},
    );

    const first = await write('the office kettle lives on the third shelf by the window');
    assert.equal(first?.saved, true, `the first write must land (got ${JSON.stringify(first)})`);
    assert.equal(first?.status, 'pending', 'the probe write must be a PENDING item (the capped kind)');

    // store.remember() returns null once the cap is reached; the tool reports that
    // as { saved: false }.
    const overflow = await write('quarterly freight invoices are reconciled every second Tuesday');
    assert.equal(overflow?.saved, false,
      'the store accepted a second pending item while maxPendingQueue was 1, so it is '
      + 'not reading the config the route just changed: lib/index.js handed MemoryStore '
      + 'its own copy. The settings page answers 200 and the flood defence keeps its '
      + `old limit until restart. Got: ${JSON.stringify(overflow)}`);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
});
