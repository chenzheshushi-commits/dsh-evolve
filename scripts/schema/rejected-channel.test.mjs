/**
 * The rejected channel: five invariants, one per thing that used to go wrong.
 *
 * Before this existed the review queue could only grow. A wrongly captured
 * memory could be confirmed or ignored -- nothing else -- so the queue hit
 * maxPendingQueue and NEW memories were dropped at the door. Garbage blocking
 * the entrance.
 *
 * The invariants are tested separately because the plan is explicit that
 * filtering in one place is not enough: recall with includePending reads all(),
 * list() only inspects PENDING_TAG, stats() computes all-minus-forgotten, and the
 * reinforcement loop walks the raw table. Each is its own query point.
 *
 * Run: node --test scripts/schema/rejected-channel.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../../lib/store.js';

/** In-memory stand-in for the storage domain's serialized table. */
function fakeTable() {
  const records = new Map();
  return {
    get: (id) => records.get(id) ?? null,
    entries: () => [...records.entries()],
    size: () => records.size,
    async put(id, rec) { records.set(id, rec); },
    async delete(id) { records.delete(id); },
    async update(id, fn) {
      if (!records.has(id)) {
        const e = new Error(`missing-key: ${id}`);
        e.code = 'missing-key';
        throw e;
      }
      records.set(id, fn(records.get(id)));
    },
    records,
  };
}

async function makeStore(config = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-rej-'));
  const table = fakeTable();
  // MemoryStore takes the table as its first positional argument.
  const store = new MemoryStore(table, {
    workspaceDir: ws,
    config: { maxPendingQueue: 50, recallLimit: 20, ...config },
    logger: { warn() {}, info() {} },
  });
  return { store, table, ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

/** Write a pending memory directly, bypassing adjudication. */
async function seedPending(store, id, content, extra = {}) {
  const rec = {
    id,
    kind: 'fact',
    scope: 'user',
    importance: 2,
    content,
    tags: ['pending'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    accessCount: 0,
    ...extra,
  };
  await store.table.put(id, rec);
  return rec;
}

test('reject moves a pending memory to the discard pile without deleting it', async () => {
  const { store, table, cleanup } = await makeStore();
  try {
    await seedPending(store, 'm1', 'wrongly captured');
    const out = await store.reject('m1');
    assert.ok(out.tags.includes('dsh-evolve-rejected'));
    assert.ok(!out.tags.includes('pending'), 'it must leave the pending queue');
    assert.ok(out.rejectedAt, 'when it was discarded is auditable');
    assert.ok(table.get('m1'), 'invariant 5: never physically deleted');
  } finally { cleanup(); }
});

test('invariant 1: a rejected memory is never injected', async () => {
  const { store, cleanup } = await makeStore();
  try {
    // Identical wording on both records so the ranker genuinely matches them --
    // a query that scores nothing would make this test pass for the wrong reason.
    const phrase = 'the user prefers concise replies without preamble';
    await seedPending(store, 'm1', phrase);
    await store.confirm('m1');                       // now a normal memory
    await seedPending(store, 'm2', phrase);
    await store.reject('m2');

    const confirmedIds = store.confirmed().map((r) => r.id);
    assert.deepEqual(confirmedIds, ['m1'], 'confirmed() must not include it');

    // recall returns {record, score} pairs, not bare records.
    const ids = async (opts) => (await store.recall(phrase, 10, opts)).map((h) => h.record.id);

    const recalled = await ids();
    assert.ok(recalled.includes('m1'), 'the query must actually match, or this proves nothing');
    assert.ok(!recalled.includes('m2'), 'recall must not surface it');

    // The dangerous one: includePending goes straight to all(), so it needs its
    // own guard. "Include the queue" never meant "include the discard pile".
    const withPending = await ids({ includePending: true });
    assert.ok(!withPending.includes('m2'), 'includePending must still exclude rejected');

    const tier1 = store.tier1Snapshot({ kinds: ['fact'], minImportance: 1 });
    assert.ok(!tier1.text.includes('delta'), 'tier1 injection must not carry it');
  } finally { cleanup(); }
});

test('invariant 2: a rejected memory is not in the pending queue or the stats', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seedPending(store, 'keep', 'still deciding');
    await seedPending(store, 'toss', 'not wanted');
    await store.reject('toss');

    const s = store.stats({ topN: 5 });
    assert.deepEqual(s.pendingQueue.map((r) => r.id), ['keep']);
    assert.equal(s.pending, 1, 'only the genuinely pending one counts');
    assert.equal(s.rejected, 1, 'the discard pile is reported on its own');
    assert.ok(!s.byKind.fact || s.byKind.fact === 1,
      'rejected records must not inflate the kind distribution');

    assert.deepEqual(store.list({ pending: false }).map((r) => r.id), [],
      'pending:false must not leak rejected records into the default view');
    assert.deepEqual(store.list({ rejected: true }).map((r) => r.id), ['toss']);
  } finally { cleanup(); }
});

test('invariant 3: confirm-all cannot resurrect a rejected memory', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seedPending(store, 'keep', 'a');
    await seedPending(store, 'toss', 'b');
    await store.reject('toss');

    // This is what the panel's confirm-batch does.
    for (const r of store.list({ pending: true })) await store.confirm(r.id);
    assert.ok(store.table.get('toss').tags.includes('dsh-evolve-rejected'),
      'the whole point of the channel: discarding must survive a confirm-all');

    // And naming it explicitly must not work either.
    assert.equal(await store.confirm('toss'), null,
      'a caller passing ids directly must not bypass the guard');
  } finally { cleanup(); }
});

test('invariant 4: a rejected memory can be restored by hand', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seedPending(store, 'm1', 'changed my mind');
    await store.reject('m1');
    const back = await store.restoreRejected('m1');
    assert.ok(back.tags.includes('pending'));
    assert.ok(!back.tags.includes('dsh-evolve-rejected'));
    assert.equal(back.rejectedAt, null);
    assert.deepEqual(store.list({ pending: true }).map((r) => r.id), ['m1']);

    assert.equal(await store.restoreRejected('m1'), null,
      'restoring something that is not rejected is a no-op, not a mutation');
  } finally { cleanup(); }
});

test('a legacy record carrying both tags still frees its quota slot', async () => {
  // reject() strips PENDING_TAG, so in normal operation the quota filter never
  // sees both tags at once. Upgrades and hand-edited data can produce that
  // shape though, and then the guard is what stops a discarded memory from
  // holding a slot forever. Without this case the filter is untested code.
  const { store, cleanup } = await makeStore({ maxPendingQueue: 1 });
  try {
    await seedPending(store, 'legacy', 'discarded but still tagged pending', {
      tags: ['pending', 'dsh-evolve-rejected'],
    });
    const written = await store.remember({
      content: 'a genuinely new memory', kind: 'other', scope: 'user',
      importance: 2, tags: ['pending'],
    });
    assert.ok(written,
      'a rejected record must not occupy a pending slot even if it kept the tag');
  } finally { cleanup(); }
});

test('rejected records do not consume the pending quota', async () => {
  // The bug this fixes: discarding freed nothing, so the queue stayed blocked
  // and new memories were still dropped at the door.
  const { store, cleanup } = await makeStore({ maxPendingQueue: 2 });
  try {
    await seedPending(store, 'a', 'one');
    await seedPending(store, 'b', 'two');
    await store.reject('a');

    // The cap only applies to writes that land PENDING, so the test has to
    // exercise that path -- a confirmed write never reaches the guard.
    const pendingWrite = () => store.remember({
      content: `unrelated new memory ${Math.random()}`,
      kind: 'fact', scope: 'user', importance: 2, tags: ['pending'],
    });

    assert.ok(await pendingWrite(),
      'with one of two slots freed by the discard, a new pending memory must fit');
    // Now genuinely full again (b + the one just written) -> the next is refused.
    assert.equal(await pendingWrite(), null,
      'the cap must still bite once the real pending count reaches it');
  } finally { cleanup(); }
});

test('tidy never disposes of a rejected memory automatically', async () => {
  const { store, cleanup } = await makeStore({ disposalMinIdleDays: 0 });
  try {
    await seedPending(store, 'toss', 'old and unused', { createdAt: '2020-01-01T00:00:00Z' });
    await store.reject('toss');
    const candidates = store.disposalCandidates();
    assert.ok(!candidates.some((c) => c.id === 'toss'),
      'only a human may turn a rejected record into a tombstone');
  } finally { cleanup(); }
});

test('reject is idempotent and unknown ids are handled', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seedPending(store, 'm1', 'x');
    const first = await store.reject('m1');
    const second = await store.reject('m1');
    assert.equal(second.rejectedAt, first.rejectedAt, 'a second reject must not restamp it');
    assert.equal(await store.reject('nope'), null);
    assert.equal(await store.restoreRejected('nope'), null);
  } finally { cleanup(); }
});

test('listRejected is the discard pile, newest first', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seedPending(store, 'old', 'first');
    await store.reject('old');
    await store.table.put('old', { ...store.table.get('old'), rejectedAt: '2026-01-01T00:00:00Z' });
    await seedPending(store, 'new', 'second');
    await store.reject('new');
    await store.table.put('new', { ...store.table.get('new'), rejectedAt: '2026-06-01T00:00:00Z' });

    assert.deepEqual(store.listRejected().map((r) => r.id), ['new', 'old']);
  } finally { cleanup(); }
});
