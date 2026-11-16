/**
 * Native memory history: rollback must work with NO external binary.
 *
 * The defect these tests exist for: rollback used to be delegated to `git` in the
 * plugin workspace, and `_scheduleCommit()` returns immediately when `.git` is
 * absent -- so on a machine without git every write produced no history at all,
 * silently. Every case below runs with an EMPTY PATH, which is the exact shape of
 * a default Windows install, a slim Linux image or a container. A test that only
 * runs with git present would have passed against the broken behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemoryHistory, RESTORE_FIELDS, USAGE_FIELDS, SNAPSHOT_ID_RE,
  restorableKey, snapshotIdFor, takenAtOf,
} from '../../lib/memory-history.js';
import { MemoryRecordSchema } from '../../lib/spec.js';
import { MemoryStore } from '../../lib/store.js';
import { buildCanonicalDigest } from '../../lib/capabilities.js';

const NOW = Date.parse('2026-11-16T00:00:00Z');
const SAVED_PATH = process.env.PATH;

function mem(id, extra = {}) {
  return {
    id, content: `memory ${id}`, kind: 'note', tags: [], scope: 'project', project: '',
    importance: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    accessedAt: '', accessCount: 0, injectionCount: 0, observationCount: 1, reinforcedAt: '',
    expiresAt: '', crystallizedAt: '', forgottenAt: '', pinned: false, sourceContext: '',
    forgottenGeneration: { bootEpoch: 0, sequence: 0 }, ...extra,
  };
}

function makeTable(records = []) {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    entries: () => map.entries(), get: async (k) => map.get(k),
    put: async (k, v) => { map.set(k, v); }, delete: async (k) => map.delete(k),
    update: async (k, fn) => {
      const cur = map.get(k);
      if (!cur) { const e = new Error('missing-key'); e.code = 'missing-key'; throw e; }
      map.set(k, fn(cur));
    },
    get size() { return map.size; }, _map: map,
  };
}

/** A history whose clock advances one second per capture, so ids stay ordered. */
function makeHistory(root, overrides = {}) {
  let tick = 0;
  return new MemoryHistory({
    workspaceDir: root, debounceMs: 0, logger: { warn() {}, info() {} },
    now: () => NOW + (tick++) * 1000, ...overrides,
  });
}

function withNoPath(fn) {
  process.env.PATH = '';
  try { return fn(); } finally { process.env.PATH = SAVED_PATH; }
}

test('a machine with no git on PATH still gets restorable snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-nogit-'));
  try {
    withNoPath(() => {
      const history = makeHistory(root);
      const records = [mem('a'), mem('b', { content: 'user prefers metric units', kind: 'preference', importance: 3 })];
      const cap = history.captureNow(records);
      assert.equal(cap.ok, true, `capture must succeed without git (got ${JSON.stringify(cap)})`);
      assert.equal(existsSync(join(root, '.git')), false, 'the point of this test: no git repository exists');
      const back = history.read(cap.id);
      assert.equal(back.ok, true, 'the snapshot must be readable');
      assert.deepEqual(back.records.map((r) => r.id).sort(), ['a', 'b'], 'both records come back');
      assert.equal(back.records.find((r) => r.id === 'b').content, 'user prefers metric units');
      assert.match(back.sha256, /^[0-9a-f]{64}$/, 'the file hash is returned for capability binding');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unchanged table does not mint a second snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-dedupe-'));
  try {
    const history = makeHistory(root);
    const records = [mem('a')];
    const first = history.captureNow(records);
    const again = history.captureNow([{ ...records[0] }]);
    assert.equal(again.skipped, 'unchanged');
    assert.equal(again.id, first.id, 'the existing snapshot is reported, not a new one');
    assert.equal(history.list().snapshots.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the ring keeps the newest snapshots and drops the oldest files', () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-ring-'));
  try {
    const history = makeHistory(root, { maxSnapshots: 3 });
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(history.captureNow([mem('a', { content: `version ${i}` })]).id);
    const listed = history.list().snapshots.map((s) => s.id);
    assert.deepEqual(listed, ids.slice(-3).reverse(), 'newest first, oldest dropped');
    assert.equal(history.read(ids[0]).ok, false, 'a pruned snapshot is really gone (not just unlisted)');
    assert.equal(readdirSync(join(root, 'memory-history')).filter((n) => SNAPSHOT_ID_RE.test(n.replace('.json', ''))).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the size cap prunes oldest-first but never to zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-bytes-'));
  try {
    const big = 'x'.repeat(900);
    const history = makeHistory(root, { maxSnapshots: 40, maxTotalBytes: 2000 });
    for (let i = 0; i < 6; i += 1) history.captureNow([mem('a', { content: `${big}${i}` })]);
    const listed = history.list();
    assert.ok(listed.snapshots.length >= 1, 'the newest snapshot always survives');
    assert.ok(listed.totalBytes <= 2000, `total bytes must respect the cap (got ${listed.totalBytes})`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a diff speaks in content and state, not in usage telemetry', () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-diff-'));
  try {
    const history = makeHistory(root);
    const snap = history.captureNow([mem('a'), mem('b')]);
    // heat only: this must NOT look like a content change
    const heatOnly = [mem('a', { injectionCount: 42, accessCount: 7, accessedAt: '2026-11-15T00:00:00Z' }), mem('b')];
    assert.deepEqual(history.diff(snap.id, heatOnly).counts,
      { added: 0, removed: 0, changed: 0, wouldRetire: 0 }, 'usage counters are not a rollback-relevant change');
    // real content change + a newcomer
    const changed = [mem('a'), mem('b', { content: 'rewritten' }), mem('c')];
    const d = history.diff(snap.id, changed);
    assert.equal(d.counts.changed, 1);
    assert.equal(d.counts.added, 1);
    assert.equal(d.counts.wouldRetire, 1, 'the newcomer is what a restore would retire');
    assert.equal(d.samples.changed[0].before, 'memory b', 'the preview shows the old text');
    // a record missing from current state would come back
    assert.equal(history.diff(snap.id, [mem('a')]).counts.removed, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restore brings content back, tombstones newcomers, and keeps live usage counters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-restore-'));
  const table = makeTable();
  const ftsCalls = [];
  const fts = {
    available: true,
    backfill() {}, upsert(r) { ftsCalls.push(['up', r.id]); }, remove(id) { ftsCalls.push(['rm', id]); },
  };
  process.env.PATH = '';
  try {
    const history = makeHistory(root);
    const store = new MemoryStore(table, { workspaceDir: root, config: {}, history, fts, logger: { warn() {}, info() {} } });
    const a = await store.remember({ content: 'original text', kind: 'note', importance: 2, confirm: true });
    const b = await store.remember({ content: 'keep me', kind: 'note', importance: 2, confirm: true });
    history.flush(() => store.all());
    const snap = history.latest();
    assert.ok(snap, 'a snapshot exists');
    // The user's bad edit + a memory written afterwards
    await table.put(a.id, { ...table._map.get(a.id), content: 'BAD REWRITE' });
    await table.put(a.id, { ...table._map.get(a.id), content: 'BAD REWRITE', injectionCount: 99, accessCount: 5 });
    const c = await store.remember({ content: 'written after the snapshot', kind: 'note', importance: 1, confirm: true });
    const before = history.captureNow(store.all());
    const out = await store.restoreFromSnapshot(history.read(snap.id).records);
    assert.equal(out.restored, 1, 'the rewritten record is restored');
    assert.equal(out.retired, 1, 'the newcomer is retired');
    assert.equal(out.revived, 0);
    const live = table._map;
    assert.equal(live.get(a.id).content, 'original text', 'content came back');
    assert.equal(live.get(a.id).injectionCount, 99, 'usage heat is NOT reverted (tidy would read it as cold)');
    assert.equal(live.get(a.id).accessCount, 5);
    assert.equal(live.get(b.id).content, 'keep me', 'the untouched record is untouched');
    assert.ok(live.get(c.id), 'the newcomer is still in the table: a restore never physically deletes');
    assert.ok(live.get(c.id).forgottenAt, 'it is soft-deleted through the tidy tombstone instead');
    assert.ok(history.list().snapshots.some((x) => x.id === before.id), 'the pre-restore state was kept, so this is reversible');
    assert.ok(ftsCalls.some(([kind, id]) => kind === 'up' && id === a.id), 'the FTS index is resynced');
    assert.ok(ftsCalls.some(([kind, id]) => kind === 'rm' && id === c.id), 'the retired record leaves the FTS index');
    // Convergence: after the restore, the same snapshot must look like a no-op.
    assert.deepEqual(history.diff(snap.id, store.all()).counts,
      { added: 0, removed: 0, changed: 0, wouldRetire: 0 },
      'a completed restore must converge -- otherwise the panel keeps offering it');
  } finally { process.env.PATH = SAVED_PATH; rmSync(root, { recursive: true, force: true }); }
});

test('a table with only get/put (no atomic update) still retires newcomers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-noupdate-'));
  try {
    const base = makeTable();
    // Deliberately no `update`: the real host table has one, but the store already
    // tolerates its absence elsewhere, and a skipped retire would turn a partial
    // restore into a silent one.
    const table = { entries: base.entries, get: base.get, put: base.put, delete: base.delete };
    const history = makeHistory(root);
    const store = new MemoryStore(table, { workspaceDir: root, config: {}, history, logger: { warn() {}, info() {} } });
    const a = await store.remember({ content: 'kept', kind: 'note', importance: 2, confirm: true });
    history.flush(() => store.all());
    const snap = history.latest();
    const c = await store.remember({ content: 'newcomer', kind: 'note', importance: 1, confirm: true });
    const out = await store.restoreFromSnapshot(history.read(snap.id).records);
    assert.equal(out.retired, 1);
    assert.ok(base._map.get(c.id).forgottenAt, 'the newcomer is tombstoned through the fallback');
    assert.equal(base._map.get(a.id).content, 'kept');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a snapshot edited on disk changes the capability digest (and count drift is refused)', () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-tamper-'));
  try {
    const history = makeHistory(root);
    const cap = history.captureNow([mem('a')]);
    const target = history.mintTarget(cap.id);
    const digestBefore = buildCanonicalDigest('memory-restore-snapshot', target);
    const file = join(root, 'memory-history', `${cap.id}.json`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.records.push(mem('injected'));
    doc.count = doc.records.length;
    writeFileSync(file, JSON.stringify(doc));
    const tampered = history.mintTarget(cap.id);
    assert.notEqual(buildCanonicalDigest('memory-restore-snapshot', tampered), digestBefore,
      'a snapshot whose bytes changed must not authorize the restore of the old target');
    // A count that disagrees with the record list is refused outright.
    doc.count = 99;
    writeFileSync(file, JSON.stringify(doc));
    assert.equal(history.read(cap.id).ok, false);
    assert.equal(history.read(cap.id).error, 'snapshot-count-mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown and traversal snapshot ids are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-ids-'));
  try {
    const history = makeHistory(root);
    history.captureNow([mem('a')]);
    for (const bad of ['', 'nope', '../../etc/passwd', '20261116T000000000-abcdef/../x', '20261116T000000000-ABCDEF']) {
      const r = history.read(bad);
      assert.equal(r.ok, false, `"${bad}" must be refused`);
    }
    assert.equal(history.read(snapshotIdFor(NOW)).error, 'unknown-snapshot');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('snapshot ids round-trip to their UTC timestamp', () => {
  const id = snapshotIdFor(Date.parse('2026-11-16T07:08:09.123Z'));
  assert.match(id, SNAPSHOT_ID_RE);
  assert.equal(takenAtOf(id), '2026-11-16T07:08:09.123Z');
  assert.equal(takenAtOf('garbage'), null);
});

test('the store snapshots on real writes and flushes a pending one on dispose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-store-'));
  try {
    let tick = 0;
    const history = new MemoryHistory({
      workspaceDir: root, debounceMs: 60_000, logger: { warn() {}, info() {} }, now: () => NOW + (tick++) * 1000,
    });
    const store = new MemoryStore(makeTable(), { workspaceDir: root, config: {}, history, logger: { warn() {}, info() {} } });
    await store.remember({ content: 'debounced write', kind: 'note', importance: 2, confirm: true });
    assert.equal(history.list().snapshots.length, 0, 'the write only SCHEDULED a snapshot (60s debounce)');
    store.flushHistory();
    assert.equal(history.list().snapshots.length, 1, 'dispose flushes it, so a short-lived process still gets history');
    const live = history.read(history.list().snapshots[0].id);
    assert.equal(live.records[0].content, 'debounced write');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a real write produces a snapshot on its own (no explicit flush)', async () => {
  // The hook, not the flush, is what makes history exist in normal use: the flush
  // path alone would keep this test green while the plugin recorded nothing.
  const root = mkdtempSync(join(tmpdir(), 'memhist-hook-'));
  try {
    let tick = 0;
    const history = new MemoryHistory({
      workspaceDir: root, debounceMs: 30, logger: { warn() {}, info() {} }, now: () => NOW + (tick++) * 1000,
    });
    const store = new MemoryStore(makeTable(), { workspaceDir: root, config: {}, history, logger: { warn() {}, info() {} } });
    await store.remember({ content: 'written by a real call', kind: 'note', importance: 2, confirm: true });
    await new Promise((r) => setTimeout(r, 150));
    const listed = history.list();
    assert.equal(listed.snapshots.length, 1, 'the debounced hook must have written it');
    assert.equal(history.read(listed.snapshots[0].id).records[0].content, 'written by a real call');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the workspace gitignore keeps snapshot bodies out of the user repo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memhist-gitignore-'));
  try {
    const store = new MemoryStore(makeTable(), { workspaceDir: root, config: {}, logger: { warn() {}, info() {} } });
    await store.remember({ content: 'anything', kind: 'note', importance: 2, confirm: true });
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    assert.ok(lines.includes('memory-history/'), `snapshots must be gitignored (got: ${lines.join('|')})`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every record field is classified for rollback (schema drift gate)', () => {
  // A new user-visible field silently missing from RESTORE_FIELDS would be a
  // quiet data loss on every restore; a new usage field in RESTORE_FIELDS would
  // revert heat. Neither can happen without this test going red.
  const fresh = MemoryRecordSchema({ id: 'x', content: 'y', createdAt: 'c', updatedAt: 'u' });
  const classified = new Set(['id', ...RESTORE_FIELDS, ...USAGE_FIELDS]);
  const unclassified = Object.keys(fresh).filter((k) => !classified.has(k));
  assert.deepEqual(unclassified, [], `classify these new record fields as restorable or live: ${unclassified.join(', ')}`);
  assert.deepEqual(RESTORE_FIELDS.filter((f) => USAGE_FIELDS.includes(f)), [], 'a field cannot be both');
  // And the classifier must actually agree with the schema, not with itself.
  for (const field of RESTORE_FIELDS) assert.ok(field in fresh, `${field} is not a record field any more`);
});

test('restorableKey ignores usage but notices content', () => {
  const a = mem('a');
  const hot = mem('a', { injectionCount: 9, accessCount: 3, provenance: { kind: 'web-human', originalKind: '', callId: '', outcome: '' } });
  assert.equal(restorableKey(a), restorableKey(hot));
  assert.notEqual(restorableKey(a), restorableKey(mem('a', { content: 'other' })));
  assert.notEqual(restorableKey(a), restorableKey(mem('a', { pinned: true })));
});
