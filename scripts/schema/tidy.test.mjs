/** Tidy tier: same candidates as suggest, CAS recheck, strict intent audit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../../lib/store.js';
import { runTidy } from '../../lib/tidy.js';
import { appendAuditStrict } from '../../lib/prune-plan.js';
import { validateConfigValue, readConfigView } from '../../lib/web-routes.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-16T00:00:00Z');

function mem(id, extra = {}) {
  return { id, content: `memory ${id}`, kind: 'note', tags: [], scope: 'project', project: '',
    importance: 1, createdAt: new Date(NOW - 40 * DAY).toISOString(), updatedAt: '', accessedAt: '',
    accessCount: 0, injectionCount: 0, observationCount: 1, reinforcedAt: '', expiresAt: '',
    crystallizedAt: '', sourceContext: '', forgottenAt: '', pinned: false, ...extra };
}
function makeTable(records = [], opts = {}) {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    entries: () => map.entries(), get: async (k) => map.get(k), put: async (k, v) => { map.set(k, v); },
    delete: async (k) => map.delete(k),
    update: async (k, fn) => {
      const cur = map.get(k);
      if (!cur) { const e = new Error('missing-key'); e.code = 'missing-key'; throw e; }
      const next = fn(cur);
      if (opts.barrier) await opts.barrier(k, cur, next, map);
      map.set(k, next);
    },
    get size() { return map.size; }, _map: map,
  };
}
function setup(records, tableOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tidy-'));
  const table = makeTable(records, tableOpts);
  const cfg = { disposalMode: 'tidy', disposalMinIdleDays: 30, tidyMaxPerRun: 5,
    auditMaxRuns: 100, approvalMode: 'manual' };
  const store = new MemoryStore(table, { workspaceDir: root, config: cfg, logger: { warn() {}, info() {} } });
  return { root, table, cfg, store };
}

test('suggest and tidy share the exact candidate function', async () => {
  const s = setup([mem('a'), mem('used', { accessCount: 1 }), mem('pinned', { pinned: true })]);
  try {
    const before = s.store.disposalCandidates(NOW).map((x) => x.id);
    const result = await runTidy({ store: s.store, workspaceDir: s.root, cfg: s.cfg, now: NOW });
    assert.deepEqual(result.candidates.map((x) => x.id), before,
      'tidy must act on exactly what suggest showed, not private logic');
    assert.deepEqual(result.softDeleted, ['a']);
    assert.ok(s.table._map.get('a').forgottenAt);
    assert.equal(s.table._map.get('used').forgottenAt, '');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('all seven exclusions hold, including rejected and importance 3', () => {
  const rows = [
    mem('eligible'), mem('forgotten', { forgottenAt: '2026-01-01' }), mem('pinned', { pinned: true }),
    mem('preference', { kind: 'preference' }), mem('decision', { kind: 'decision' }),
    mem('pending', { tags: ['pending'] }), mem('rejected', { tags: ['dsh-evolve-rejected'] }),
    mem('imp3', { importance: 3 }), mem('injected', { injectionCount: 1 }), mem('recalled', { accessCount: 1 }),
    mem('recent', { createdAt: new Date(NOW - DAY).toISOString() }),
  ];
  const s = setup(rows);
  try { assert.deepEqual(s.store.disposalCandidates(NOW).map((x) => x.id), ['eligible']); }
  finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('tidyMaxPerRun is a hard cap', async () => {
  const s = setup(Array.from({ length: 8 }, (_, i) => mem(`m${i}`)));
  try {
    s.cfg.tidyMaxPerRun = 3;
    const r = await runTidy({ store: s.store, workspaceDir: s.root, cfg: s.cfg, now: NOW });
    assert.equal(r.softDeleted.length, 3);
    assert.equal([...s.table._map.values()].filter((x) => x.forgottenAt).length, 3);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('strict INTENT audit failure degrades to suggest and changes nothing', async () => {
  const s = setup([mem('a')]);
  try {
    const r = await runTidy({ store: s.store, workspaceDir: s.root, cfg: s.cfg, now: NOW,
      audit: { appendStrict: () => { throw new Error('disk full'); } } });
    assert.equal(r.status, 'suggest-only');
    assert.deepEqual(r.candidates.map((x) => x.id), ['a']);
    assert.equal(s.table._map.get('a').forgottenAt, '', 'no intent means no mutation');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('strict audit fsync path returns written bytes and throws on failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tidy-'));
  try {
    const r = appendAuditStrict(root, { event: 'tidy', phase: 'intent', ids: ['a'] });
    assert.equal(r.ok, true); assert.ok(r.bytes > 20);
    assert.match(readFileSync(join(root, '.evolve-audit.jsonl'), 'utf8'), /"phase":"intent"/);
    assert.throws(() => appendAuditStrict(join(root, 'missing', 'dir'), { x: 1 }), /./);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CAS recheck sees a recall that happened after candidate scan', async () => {
  const s = setup([mem('a')]);
  try {
    const expected = s.store.disposalCandidates(NOW)[0];
    await s.table.put('a', { ...s.table._map.get('a'), accessCount: 1 });
    const receipt = await s.store.softForgetIfEligible('a', expected, NOW);
    assert.equal(receipt.softDeleted, 0);
    assert.equal(receipt.skipped, 'no-longer-eligible');
    assert.equal(s.table._map.get('a').forgottenAt, '');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('noteInjection generation invalidates an old candidate before update', async () => {
  const s = setup([mem('a')]);
  try {
    const expected = s.store.disposalCandidates(NOW)[0];
    s.store.noteInjection(['a']);
    // Isolate the generation check from effectiveInjectionCount: simulate that
    // the cheap pending-delta counter was lost/flushed, while the monotonic
    // generation still proves an injection happened since the snapshot.
    s.store._injectionDelta.clear();
    const receipt = await s.store.softForgetIfEligible('a', expected, NOW);
    assert.equal(receipt.softDeleted, 0);
    assert.equal(receipt.skipped, 'used-since',
      'generation is the independent proof when counters happen to equal the old snapshot');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('late injection after tidy put resurrects the just-used record on flush', async () => {
  let once = true;
  let store;
  const s = setup([mem('a')], { barrier: async (id, _cur, next, map) => {
    if (once && next.forgottenAt) {
      once = false;
      map.set(id, next);                  // tidy backend put landed
      store.noteInjection([id]);          // injection arrives immediately after
    }
  } });
  store = s.store;
  try {
    const expected = store.disposalCandidates(NOW)[0];
    await store.softForgetIfEligible('a', expected, NOW);
    await store.flushInjections();
    const r = s.table._map.get('a');
    assert.equal(r.forgottenAt, '', 'a memory used concurrently must finish live');
    assert.equal(r.injectionCount, 1);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('success is receipt.softDeleted===1, not merely "did not throw"', async () => {
  const s = setup([mem('a')]);
  try {
    const orig = s.store.softForgetIfEligible.bind(s.store);
    s.store.softForgetIfEligible = async () => ({ softDeleted: 0, skipped: 'raced' });
    const r = await runTidy({ store: s.store, workspaceDir: s.root, cfg: s.cfg, now: NOW });
    assert.deepEqual(r.softDeleted, []);
    assert.deepEqual(r.skipped, [{ id: 'a', reason: 'raced' }]);
    s.store.softForgetIfEligible = orig;
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('tidy config is present at all five code touchpoints', () => {
  assert.equal(validateConfigValue('disposalMode', 'tidy').ok, true);
  assert.equal(validateConfigValue('tidyMaxPerRun', 5).ok, true);
  assert.equal(validateConfigValue('idleMinutes', 9).ok, true);
  assert.equal(readConfigView({ disposalMode: 'tidy', tidyMaxPerRun: 7, idleMinutes: 9 }).disposalMode, 'tidy');
  assert.equal(readConfigView({ disposalMode: 'tidy', tidyMaxPerRun: 7, idleMinutes: 9 }).tidyMaxPerRun, 7);
  assert.equal(readConfigView({ disposalMode: 'tidy', tidyMaxPerRun: 7, idleMinutes: 9 }).idleMinutes, 9);
  const index = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');
  const spec = readFileSync(new URL('../../lib/spec.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../src/client/EvolveSettingsSection.tsx', import.meta.url), 'utf8');
  assert.match(index, /z\.const\('tidy'\)/, 'schema touchpoint');
  assert.match(index, /\['manual', 'suggest', 'tidy'\]\.includes/, 'settings base touchpoint');
  assert.match(spec, /tidyMaxPerRun:\s*5/, 'defaults touchpoint');
  assert.match(index, /idleMinutes: z\.number/, 'idleMinutes schema touchpoint');
  assert.match(ui, /setConfig\(\{ idleMinutes:/, 'idleMinutes front-end control');
  assert.match(ui, /'manual' \| 'suggest' \| 'tidy'/, 'front-end type touchpoint');
  assert.match(ui, /\['tidy', '整理'/, 'front-end control touchpoint');
});

test('no physical delete exists in tidy implementation', () => {
  const src = readFileSync(new URL('../../lib/tidy.js', import.meta.url), 'utf8');
  assert.match(src, /softForgetIfEligible/);
  assert.equal(/\.forget\(|\.delete\(|rmSync|unlink/.test(src), false,
    'tidy may only stamp forgottenAt; physical deletion is forbidden at every tier');
  const index = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');
  const block = index.slice(index.indexOf("name: 'memory_forget'"), index.indexOf("name: 'crystallize_skill'"));
  assert.match(block, /store\.softForget\(/, 'conversation-side memory_forget must be recoverable too');
  assert.equal(/store\.forget\(/.test(block), false);
});
