/**
 * The three harness-0.1.7 contracts this plugin now depends on, judged by behaviour.
 *
 * Each of these broke exactly once on the 0.1.5 → 0.1.7 upgrade and each broke
 * SILENTLY: the plugin either failed to import outright, or imported fine and lost
 * a capability (settings no longer surviving a restart, notices no longer being
 * storable). Static checks said "the symbol still exists" in every case.
 *
 *   1. `Config` is the harness's settings form. A field that is not `.volatile()`
 *      takes the ordinary lifecycle and remounts the plugin on every edit.
 *   2. Volatile fields arrive as stable references, while every read site in this
 *      plugin wants ordinary data. A leaked reference silently degrades the
 *      governance limits (Number.isInteger(ref) is false, enum checks fall through).
 *   3. Session format v4 refuses the retired v3 `{ kind: 'plugin', plugin }` source
 *      wrapper, so an injected notice written that way poisons the log it lands in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Config } from '../../lib/index.js';
import { MEMORY_DEFAULTS, SKILL_DEFAULTS } from '../../lib/spec.js';
import { CONFIG_KEY_SPECS } from '../../lib/web-routes.js';
import { SOURCE_KIND } from '../../lib/message-source.js';

/** A minimal in-memory stand-in for the harness KvTable. */
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

/**
 * A record-only mock context. It captures the handlers the plugin registers so a
 * test can drive them, exactly like apply-probe.mjs does.
 */
function mockContext(routes, hooks, tools) {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: {
      get: () => undefined,
      open: async (decl) => {
        const tables = new Map();
        return {
          table(n) { if (!tables.has(n)) tables.set(n, fakeTable()); return tables.get(n); },
          close() {},
          _name: decl.name,
        };
      },
    },
    tools: { register(t) { tools.set(t.name, t); }, get: (n) => tools.get(n) },
    systemPrompt: { section() {}, context() {}, variable() {} },
    on: (evt, fn) => { hooks.push({ evt, fn }); return () => {}; },
    effect: () => {},
    get: () => ({ currentInitiator: () => undefined }),
    llm: { stream: async function* () { /* never called in these tests */ } },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    plugin(child, cfg) {
      const deps = child?.inject ?? [];
      if (deps.every((d) => ctx[d] !== undefined) && typeof child?.apply === 'function') {
        void child.apply(ctx, cfg);
      }
    },
  };
  return ctx;
}

test('Config is a complete volatile form, and its defaults are the runtime defaults', () => {
  // schemastery's toJSON() is a reference table; the node tree is the schema itself.
  const schema = Config;
  assert.equal(schema.type, 'object');

  // Every key the settings page can edit must be volatile, or editing it remounts
  // the plugin instead of committing into the running references.
  const editable = Object.keys(CONFIG_KEY_SPECS);
  assert.ok(editable.length >= 15, `expected the settings form to cover the page (got ${editable.length})`);
  for (const key of editable) {
    assert.ok(Object.hasOwn(schema.dict, key), `settings key "${key}" is missing from Config`);
    assert.equal(schema.dict[key].meta?.volatile, true,
      `Config.${key} is not volatile: a settings edit would remount the plugin `
      + 'instead of committing into the running references');
  }

  // And the schema default must be the value the plugin actually runs with, so the
  // settings page cannot show a default the code does not honour. This is the check
  // that would have caught `refineLLM` being documented and spec'd as `false` while
  // SKILL_DEFAULTS made it `true`. `language` is the one key with no entry in the
  // runtime defaults — the config is its only source, so the schema IS the default.
  const defaults = { ...MEMORY_DEFAULTS, ...SKILL_DEFAULTS };
  const checked = [];
  for (const key of editable) {
    const documented = schema.dict[key].meta?.default;
    if (documented === undefined || !Object.hasOwn(defaults, key)) continue;
    checked.push(key);
    assert.equal(documented, defaults[key],
      `Config.${key} defaults to ${JSON.stringify(documented)} but the plugin runs `
      + `with ${JSON.stringify(defaults[key])}`);
  }
  assert.ok(checked.length >= 15,
    `the defaults comparison must cover the form (checked ${checked.join(', ') || 'none'})`);

  // An entry with no config at all must still validate (that is this plugin's own
  // profile row today), and every field must come back as a live reference.
  const parsed = Config['~standard'].validate(undefined);
  assert.equal(parsed.issues, undefined, 'Config must accept an entry with no config block');
  for (const [key, value] of Object.entries(parsed.value)) {
    assert.equal(typeof value?.get, 'function', `Config.${key} did not come back as a reference`);
  }
});

test('a volatile config is unwrapped into the live config the store reads', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-evolve-host-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const routes = [];
  const hooks = [];
  const tools = new Map();
  try {
    const ctx = mockContext(routes, hooks, tools);
    const mod = await import('../../lib/index.js');

    // Real reference-shaped input, exactly as the harness hands it over. The values
    // are deliberately not the schema defaults (50/30): with defaults, "the host's
    // value arrived" and "the default filled in" are the same observation.
    const live = { maxPendingQueue: 3, disposalMinIdleDays: 17 };
    const config = {
      maxPendingQueue: { get: () => live.maxPendingQueue },
      disposalMinIdleDays: { get: () => live.disposalMinIdleDays },
    };
    await mod.apply(ctx, config);

    const state = routes.find((r) => r.path === '/api/evolve/state');
    assert.ok(state, 'the plugin must register /api/evolve/state');
    const call = async () => {
      const req = {
        method: 'GET',
        headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress: '127.0.0.1' },
        url: state.path,
      };
      req[Symbol.asyncIterator] = async function* () { /* no body */ };
      let payload = null;
      const res = {
        setHeader() {},
        writeHead() { return res; },
        end(b) { payload = JSON.parse(String(b)); },
      };
      await state.handler(req, res);
      return payload;
    };

    const first = await call();
    assert.equal(first.config.maxPendingQueue, 3,
      'the host reference must be unwrapped into an ordinary number the store can '
      + `compare (got ${JSON.stringify(first.config.maxPendingQueue)})`);
    assert.equal(typeof first.config.maxPendingQueue, 'number');
    assert.equal(first.config.disposalMinIdleDays, 17);

    // A committed volatile edit rewrites the SAME references; the plugin must
    // re-mirror them on its own event rather than holding the boot-time value.
    const volatile = hooks.find((h) => h.evt === 'loader/volatile-update');
    assert.ok(volatile, 'the plugin must subscribe to loader/volatile-update');
    live.maxPendingQueue = 9;
    live.disposalMinIdleDays = 2;
    volatile.fn();
    const second = await call();
    assert.equal(second.config.maxPendingQueue, 9,
      'a volatile commit did not reach the live config: the flood-defence cap would '
      + 'keep the boot-time value until the plugin is restarted');
    assert.equal(second.config.disposalMinIdleDays, 2);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a settings write is persisted through the host, not just into memory', async () => {
  // Regression for a bug a user hit: the settings page flipped a value and it
  // "jumped back by itself". v0.7.0's set-config route only did `Object.assign`
  // into the in-memory cfg (its own schema comment said so) while a second writer
  // — the harness's generated settings form — kept the STORED value and pushed it
  // back over the change. So the write had to reach the harness's own persistence
  // and there had to be exactly one writer.
  const home = mkdtempSync(join(tmpdir(), 'dsh-evolve-persist-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const routes = [];
  const hooks = [];
  const tools = new Map();
  try {
    const ctx = mockContext(routes, hooks, tools);
    // A settings service that only records: if the plugin never calls it, the edit
    // cannot survive a restart and this test must fail.
    const persisted = [];
    ctx.settings = {
      update: async (ns, patch) => { persisted.push({ ns, patch: { ...patch } }); },
      describe: () => [{ ns: 'locale', value: { preference: 'zh' } }],
      configure: () => () => {},
    };
    const mod = await import('../../lib/index.js');
    await mod.apply(ctx, {});

    const action = routes.find((r) => r.path === '/api/evolve/action');
    assert.ok(action, 'the plugin must register /api/evolve/action');
    const req = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      socket: { remoteAddress: '127.0.0.1' },
      url: action.path,
    };
    const body = { action: 'set-config', disposalMode: 'suggest' };
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)); };
    let payload = null;
    const res = { setHeader() {}, writeHead() { return res; }, end(b) { payload = JSON.parse(String(b)); } };
    await action.handler(req, res);

    assert.equal(payload?.config?.disposalMode, 'suggest', 'the write must take effect immediately');
    assert.equal(persisted.length, 1,
      'the edit was only applied in memory: it will look saved until anything '
      + 're-reads the stored value, then jump back');
    assert.equal(persisted[0].ns, 'evolve', 'it must persist under this plugin’s own entry id');
    assert.deepEqual(persisted[0].patch, { disposalMode: 'suggest' });

    // And the harness must not be told to generate a competing settings page for
    // this entry: two writers over one config is what made the value jump back.
    const configSrc = (await import('node:fs')).readFileSync(
      new URL('../../lib/index.js', import.meta.url), 'utf8');
    assert.equal(/installSettingsSection/.test(configSrc), false,
      'the old harness settings registrar is a second writer over this config');
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test('every injected notice carries the v4 producer-owned source with a summary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-evolve-src-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const routes = [];
  const hooks = [];
  const tools = new Map();
  try {
    const ctx = mockContext(routes, hooks, tools);
    const mod = await import('../../lib/index.js');
    await mod.apply(ctx, { language: 'en' });

    // The steady-state path: repeated errors of one shape produce a lesson nudge.
    const onError = hooks.find((h) => h.evt === 'agent/error');
    assert.ok(onError, 'the plugin must subscribe to agent/error');
    const injected = [];
    const agent = { inject: (message) => injected.push(message) };
    const failure = new Error('probe failure');
    onError.fn({ agent, turn: 1, step: 1, error: failure });
    onError.fn({ agent, turn: 1, step: 2, error: failure });
    assert.equal(injected.length, 1, 'the repeated-error nudge must fire exactly once');

    // And the recall path, driven through the real tool so the store really holds
    // the record that gets injected.
    const remember = tools.get('memory_remember');
    assert.ok(remember, 'memory_remember must be registered');
    const saved = await remember.execute({
      content: 'the user prefers terse answers in every reply',
      kind: 'preference', importance: 2, scope: 'user',
      tags: ['style'], anchoredToUser: true,
    }, {});
    assert.equal(saved?.saved, true, `the probe record must land (got ${JSON.stringify(saved)})`);

    const onPreStep = hooks.find((h) => h.evt === 'agent/pre-step');
    assert.ok(onPreStep, 'the plugin must subscribe to agent/pre-step');
    const decision = await onPreStep.fn(
      {
        agent: {},
        messages: [{ role: 'user', content: [{ type: 'text', text: 'style terse please' }] }],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'enter', messages: [] }),
    );
    const notices = [...(decision.messages ?? []), ...injected];
    assert.ok(notices.some((m) => m?.source?.summary === '记忆召回注入'),
      'the recall injection must reach the step messages');

    for (const message of notices) {
      assert.equal(message.source.kind, SOURCE_KIND,
        'an injected notice used a retired source kind: format v4 refuses the log '
        + `the moment it is read back (got ${JSON.stringify(message.source.kind)})`);
      assert.equal(message.source.kind, 'plugin:dsh-evolve');
      assert.equal(message.source.form, 'notice');
      assert.equal(typeof message.source.summary, 'string');
      assert.ok(message.source.summary.length > 0,
        'a notice source must carry its one-line summary (the v0.5.2 log-refusal bug)');
    }
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test('every host symbol the plugin imports still exists at the pinned version', async () => {
  // The 0.1.7 outage was a RENAME the host made (`CallId` -> `ToolCallId`) in a
  // package this plugin imports. No unit test could see it: they all import
  // lib/index.js through this repo's own node_modules, so the symbol was there.
  // This gate asks the packages we actually import, by name, and refuses the build
  // if one of them stopped exporting what we call.
  const libDir = new URL('../../lib/', import.meta.url);
  const files = readdirSync(libDir).filter((n) => n.endsWith('.js') && n !== 'client.js');
  assert.ok(files.length >= 10, `expected the host half to have modules (found ${files.length})`);

  /** Static import/re-export clauses plus dynamic imports, keyed by specifier. */
  const importsOf = (name) => {
    const src = readFileSync(new URL(name, libDir), 'utf8');
    const out = new Map();
    const push = (spec, names) => {
      if (!spec.startsWith('@deepseek-ai/')) return;
      const set = out.get(spec) ?? new Set();
      for (const n of names) set.add(n);
      out.set(spec, set);
    };
    for (const m of src.matchAll(/(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
      const clause = m[2];
      const spec = m[3];
      const brace = clause.match(/\{([^}]*)\}/);
      const names = [];
      if (brace) {
        for (const raw of brace[1].split(',')) {
          const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (n) names.push(n);
        }
      }
      if (/^\*\s+as\s+/.test(clause)) names.push('*');
      if (/^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim())) names.push('default');
      if (m[1]) continue; // type-only: tsc already checks these
      push(spec, names);
    }
    for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      push(m[1], ['(dynamic)']);
    }
    return out;
  };

  const checked = [];
  for (const name of files) {
    for (const [spec, names] of importsOf(name)) {
      let mod;
      try {
        mod = await import(spec);
      } catch (e) {
        assert.fail(`${name} imports ${spec} but it does not resolve: ${e.message}`);
      }
      for (const n of names) {
        if (n === '*' || n === '(dynamic)') continue;
        checked.push(`${spec}.${n}`);
        assert.ok(n in mod,
          `${name} imports { ${n} } from ${spec}, which no longer exports it — `
          + 'this is exactly the rename that made the plugin fail to import on 0.1.7');
      }
    }
  }
  assert.ok(checked.length >= 8,
    `the import scan must cover the host surface (checked ${checked.join(', ') || 'none'})`);

  // And no mixed host tree: the packages we share with the harness must be pinned
  // to ONE version, because the harness may route them to its own copies.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const pins = Object.entries(pkg.devDependencies)
    .filter(([k]) => k.startsWith('@deepseek-ai/dsh-'));
  assert.ok(pins.length >= 5, `expected host-shared pins (found ${pins.length})`);
  const versions = new Set(pins.map(([, v]) => v));
  assert.equal(versions.size, 1,
    `host-shared packages are pinned to different versions: ${
      pins.map(([k, v]) => `${k}@${v}`).join(', ')}`);
  for (const [name] of pins) {
    const installed = JSON.parse(readFileSync(
      new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    assert.equal(installed.version, pkg.devDependencies[name],
      `${name} is installed at ${installed.version} but pinned at ${pkg.devDependencies[name]}`);
  }
});
