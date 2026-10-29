/**
 * Project scoping (issue #4): a host process shares ONE memory store across
 * every session, so "project"-scope memories must not leak between workspaces.
 *
 * These are behavior tests — they drive a real MemoryStore with a fake table.
 * Source-regex assertions would pass for a filter that is never reached (the
 * v0.6.x lesson), so every invariant here is observed through a real call:
 * recall, remember, the reinforcement loop, the pending cap, assessWrite.
 *
 * Run: node --test scripts/schema/project-scope.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../../lib/store.js';
import { normalizeProjectKey, projectKeyOfCarrier, isVisibleInProject } from '../../lib/project-scope.js';

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
  const ws = mkdtempSync(join(tmpdir(), 'dsh-projscope-'));
  const store = new MemoryStore(fakeTable(), {
    workspaceDir: ws,
    config: { maxPendingQueue: 50, recallLimit: 20, ...config },
    logger: { warn() {}, info() {} },
  });
  return { store, ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

/** Seed a raw record, bypassing adjudication (same helper shape as other suites). */
async function seed(store, id, content, extra = {}) {
  const rec = {
    id, kind: 'fact', scope: 'project', project: '', importance: 2, content,
    tags: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    accessCount: 0, observationCount: 1, ...extra,
  };
  await store.table.put(id, rec);
  return rec;
}

const ids = (hits) => hits.map((h) => h.record.id);

// ── identity: normalized workspace key ──────────────────────────────────────

test('normalizeProjectKey canonicalizes one workspace to one key', () => {
  assert.equal(normalizeProjectKey('/home/u/work/app/'), '/home/u/work/app');
  assert.equal(normalizeProjectKey('/home/u/work/app///'), '/home/u/work/app');
  assert.equal(normalizeProjectKey('  /home/u/work/app  '), '/home/u/work/app');
  // Windows: separators unified AND case folded (that filesystem is
  // case-insensitive, so two spellings must not become two projects).
  assert.equal(normalizeProjectKey('C:\\Users\\Admin\\Repo\\'), 'c:/users/admin/repo');
  assert.equal(normalizeProjectKey('C:/Users/Admin/Repo'), 'c:/users/admin/repo');
  // Drive root keeps its separator.
  assert.equal(normalizeProjectKey('C:\\'), 'c:/');
  // UNC keeps its double slash after unification.
  assert.equal(normalizeProjectKey('\\\\srv\\share\\repo'), '//srv/share/repo');
  // Missing/blank/garbage → '' (unknown workspace, not a bogus project).
  assert.equal(normalizeProjectKey(undefined), '');
  assert.equal(normalizeProjectKey(null), '');
  assert.equal(normalizeProjectKey('   '), '');
  assert.equal(normalizeProjectKey(42), '');
});

test('projectKeyOfCarrier reads the workspace out of every caller shape', () => {
  const session = { header: { cwd: '/home/u/work/app/' } };
  // tool exec: { agent: { session } }
  assert.equal(projectKeyOfCarrier({ agent: { session } }), '/home/u/work/app');
  // agent/pre-step payload: same shape
  assert.equal(projectKeyOfCarrier({ agent: { session }, messages: [] }), '/home/u/work/app');
  // a bare agent
  assert.equal(projectKeyOfCarrier({ session }), '/home/u/work/app');
  // a bare session
  assert.equal(projectKeyOfCarrier(session), '/home/u/work/app');
  // No session / no cwd → unknown workspace, never a made-up key.
  assert.equal(projectKeyOfCarrier({ agent: {} }), '');
  assert.equal(projectKeyOfCarrier({ agent: { session: {} } }), '');
  assert.equal(projectKeyOfCarrier(undefined), '');
  assert.equal(projectKeyOfCarrier(null), '');
});

test('isVisibleInProject: project-scope isolates, user-scope and legacy stay global', () => {
  const key = '/w/a';
  assert.equal(isVisibleInProject({ scope: 'project', project: '/w/a' }, key), true);
  assert.equal(isVisibleInProject({ scope: 'project', project: '/w/b' }, key), false);
  assert.equal(isVisibleInProject({ scope: 'project', project: '/w/a/' }, key), true, 'normalized before compare');
  assert.equal(isVisibleInProject({ scope: 'user', project: '/w/b' }, key), true, 'user scope is global by design');
  assert.equal(isVisibleInProject({ scope: 'project', project: '' }, key), true, 'legacy unstamped fails OPEN');
  assert.equal(isVisibleInProject({ scope: 'project', project: '/w/b' }, ''), true, 'unknown caller keeps old global behaviour');
  assert.equal(isVisibleInProject({ scope: 'project', project: '/w/b' }, key, { allProjects: true }), true);
});

// ── read path ───────────────────────────────────────────────────────────────

test('recall does not inject another workspace\'s project memories', async () => {
  const { store, cleanup } = await makeStore();
  try {
    // Identical wording on purpose: a query that scores nothing would let this
    // test pass for the wrong reason.
    const phrase = 'the carrier-ship service owns warehouse stock on port 8600';
    await seed(store, 'a1', phrase, { project: '/w/a' });
    await seed(store, 'b1', phrase, { project: '/w/b' });
    await seed(store, 'u1', 'the user always replies in Chinese', { scope: 'user', project: '/w/b' });
    await seed(store, 'legacy', 'old unstamped record about warehouse stock on port 8600', {});

    const fromA = ids(await store.recall('warehouse stock port 8600', 10, { project: '/w/a' }));
    assert.ok(fromA.includes('a1'), 'own project visible');
    assert.ok(!fromA.includes('b1'), 'foreign project NOT visible');
    assert.ok(fromA.includes('legacy'), 'unstamped legacy record stays visible (fail-open)');

    const userHits = ids(await store.recall('replies in Chinese', 10, { project: '/w/a' }));
    assert.ok(userHits.includes('u1'), 'user-scope memory is global');

    const all = ids(await store.recall('warehouse stock port 8600', 10, { project: '/w/a', allProjects: true }));
    assert.ok(all.includes('b1'), 'allProjects escape hatch sees every workspace');

    // No project option at all = previous behaviour (a caller that could not
    // pass one must not silently lose its whole corpus).
    const noKey = ids(await store.recall('warehouse stock port 8600', 10, {}));
    assert.ok(noKey.includes('a1') && noKey.includes('b1'), 'no project option → global, as before');
  } finally { cleanup(); }
});

test('recall with includePending filters the pending pool too', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const phrase = 'pending foreign note about warehouse stock port 8600';
    await seed(store, 'p-b', phrase, { project: '/w/b', tags: ['pending'] });
    await seed(store, 'p-a', phrase + ' (own)', { project: '/w/a', tags: ['pending'] });
    const hits = ids(await store.recall('pending foreign note warehouse stock', 10,
      { project: '/w/a', includePending: true }));
    assert.ok(hits.includes('p-a'), 'own pending visible to the queue owner');
    assert.ok(!hits.includes('p-b'), 'another workspace\'s pending must not be evaluable from here');
  } finally { cleanup(); }
});

// ── write path ──────────────────────────────────────────────────────────────

test('remember stamps the normalized workspace on the record', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const rec = await store.remember({
      content: 'this repository deploys with pnpm run deploy', kind: 'fact',
      scope: 'project', confirm: true, project: '/w/a/',
    });
    assert.ok(rec, 'write landed');
    assert.equal(rec.project, '/w/a', 'stored key is normalized');

    const anon = await store.remember({
      content: 'background review has no session to stamp with', kind: 'note',
      scope: 'project', confirm: true,
    });
    assert.equal(anon.project, '', 'no project → unstamped legacy shape, not a guess');
  } finally { cleanup(); }
});

test('reinforcement never rewrites another workspace\'s record', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const phrase = 'npm run deploy fails unless the VPN is connected';
    const a = await store.remember({
      content: phrase, kind: 'lesson', scope: 'project', confirm: true, project: '/w/a',
    });
    assert.equal(a.observationCount, 1);

    // Same understanding re-observed in ANOTHER workspace: this is a second
    // memory (its own repo, its own lesson), not reinforcement of A's record.
    const b = await store.remember({
      content: phrase, kind: 'lesson', scope: 'project', confirm: true, project: '/w/b',
    });
    assert.notEqual(b.id, a.id, 'a foreign near-duplicate must not be merged into A');
    assert.equal(b.project, '/w/b');
    assert.equal(store.table.get(a.id).observationCount, 1, 'A\'s record untouched');
    assert.equal(store.table.get(a.id).content, phrase, 'A\'s content untouched');

    // Same workspace: reinforcement works exactly as before.
    const a2 = await store.remember({
      content: phrase, kind: 'lesson', scope: 'project', confirm: true, project: '/w/a',
    });
    assert.equal(a2.id, a.id, 'same project still reinforces');
    assert.equal(a2.observationCount, 2);
  } finally { cleanup(); }
});

test('the pending cap does not count a foreign near-duplicate as reinforcement', async () => {
  const { store, cleanup } = await makeStore({ maxPendingQueue: 1 });
  try {
    const phrase = 'the flaky test is caused by a missing await in the fixture';
    await seed(store, 'a-pending', phrase, { project: '/w/a', tags: ['pending'] });

    // Queue is full (1/1). From B, the same wording is NOT a reinforcement of
    // A's pending item, so the write must be refused rather than merged.
    const foreign = await store.remember({
      content: phrase, kind: 'fact', scope: 'project', project: '/w/b',
    });
    assert.equal(foreign, null, 'foreign reinforcement must not bypass the cap');

    // From A it IS the same item re-observed → allowed through as reinforcement.
    const own = await store.remember({
      content: phrase, kind: 'fact', scope: 'project', project: '/w/a',
    });
    assert.ok(own, 'same-project reinforcement still exempt from the cap');
    assert.equal(own.id, 'a-pending');
  } finally { cleanup(); }
});

test('assessWrite judges near-duplicates inside the caller\'s workspace only', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const phrase = 'the reverse proxy times out after 60 seconds on the analytics route';
    await seed(store, 'b1', phrase, { project: '/w/b', scope: 'project' });

    const foreign = store.assessWrite({ content: phrase, kind: 'fact', scope: 'project' }, { project: '/w/a' });
    assert.equal(foreign.verdict, 'ok', 'redundancy in another workspace is not this workspace\'s redundancy');

    const own = store.assessWrite({ content: phrase, kind: 'fact', scope: 'project' }, { project: '/w/b' });
    assert.equal(own.verdict, 'near-duplicate', 'same workspace still detects redundancy');
    assert.equal(own.similarTo, 'b1');

    const noKey = store.assessWrite({ content: phrase, kind: 'fact', scope: 'project' });
    assert.equal(noKey.verdict, 'near-duplicate', 'unknown caller keeps the old global judgement');
  } finally { cleanup(); }
});
