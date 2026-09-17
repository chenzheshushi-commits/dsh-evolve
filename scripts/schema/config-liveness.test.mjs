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
 *
 * Asserted behaviourally, through a real store over a fake table: a source-level
 * check ("does the constructor spread?") would pass the moment someone spread the
 * object somewhere else.
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
 * The mechanism test above proves the store keeps whatever object it is handed. It
 * does NOT prove the host hands it the object the settings page writes to -- that
 * wiring is three separate lines in index.js and was, until now, confirmed only by
 * reading them:
 *
 *   :212   const cfg = { ...MEMORY_DEFAULTS, ...SKILL_DEFAULTS, ...config }
 *   :279   new MemoryStore(table, { ..., config: cfg, ... })
 *   :1798  setConfig:  Object.assign(cfg, patch)          (web route)
 *   :2113  onChange:   Object.assign(cfg, current())      (dsh-settings)
 *
 * Point the store at a different object, or add a fourth write path that mutates
 * the host's original `config` instead of `cfg`, and every behavioural test here
 * still passes while the settings page goes back to having no effect.
 */
test('the store is wired to the same object every config write path mutates', () => {
  const index = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');

  // 1. What identifier does the store receive?
  const ctor = /new MemoryStore\([\s\S]{0,400}?\)\s*;/.exec(index);
  assert.ok(ctor, 'lib/index.js must construct MemoryStore');
  const passed = /config:\s*([A-Za-z_$][\w$]*)/.exec(ctor[0]);
  assert.ok(passed, 'MemoryStore must receive a named config object, not an inline literal: '
    + 'an inline object cannot be mutated by setConfig and freezes every limit');
  const target = passed[1];

  // 2. Every Object.assign that writes config must target that same identifier.
  const writes = [...index.matchAll(/Object\.assign\(\s*([A-Za-z_$][\w$]*)\s*,/g)]
    .map((m) => m[1])
    .filter((name) => name === target || /^(cfg|config)$/.test(name));
  assert.ok(writes.length >= 2,
    `expected the config write paths to be Object.assign calls (found ${writes.length})`);
  for (const name of writes) {
    assert.equal(name, target,
      `a config write path mutates "${name}" but the store holds "${target}"; `
      + 'the settings page would report success and change nothing');
  }
});
