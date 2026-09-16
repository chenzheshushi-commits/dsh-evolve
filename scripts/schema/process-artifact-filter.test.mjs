/**
 * Process-artifact filter: catch the real pollution, spare the real lessons.
 *
 * The three "must be blocked" cases are the actual records the user found in the
 * review queue, verbatim. The "must pass" cases are the reason the first design
 * was thrown away: flagging any of 评审/review/audit/实现方案 would have killed a
 * large class of genuine lessons, and the same document that proposed it also
 * demanded those lessons be kept -- a contradiction. Process words are a
 * weighted signal, never a trigger.
 *
 * Run: node --test scripts/schema/process-artifact-filter.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProcessArtifact, findProcessArtifactSuspects, MEMORY_VS_DOCUMENT_RULE,
} from '../../lib/process-artifact-filter.js';

// The exact records that prompted this work.
const REAL_POLLUTION = [
  'dsh-evolve v0.6.0 rev2 重新评估：rev1 的 19 个成立问题大多被认真吸收，merge tier/valence 已收敛',
  'dsh-evolve v0.6.0 rev3 独立审查新发现：usage receipt 仍未按 DSH rc.2 真事件形状闭环',
  'dsh-evolve v0.6.0 rev3 复评：统一事务模型使方案较rev2显著提升，但仍有开工阻断。核心：1) manifest',
];

// Genuine lessons that happen to use review vocabulary. Blocking any of these
// would be worse than the pollution -- they are exactly what memory is for.
const GENUINE_LESSONS = [
  '代码评审必须覆盖并发路径，只看单线程逻辑会漏掉竞态',
  'audit log 写入后必须 fsync，否则崩溃时记录会丢',
  '实现方案里的恢复流程必须实测，纸面推演过不了真实文件系统',
  '给外部评审看的材料要能独立复现，否则结论不可信',
  '评分标准应该在开工前定好，事后补会变成为结果找理由',
];

test('the three real polluting records are all blocked', () => {
  for (const content of REAL_POLLUTION) {
    const v = classifyProcessArtifact({ content, provenance: 'model-tool' });
    assert.equal(v.isProcessArtifact, true, `must be blocked: ${content.slice(0, 40)}`);
    assert.ok(v.patternNames.length > 0, 'the audit line needs to say why');
  }
});

test('genuine lessons using review vocabulary all pass (false-positive gate)', () => {
  for (const content of GENUINE_LESSONS) {
    const v = classifyProcessArtifact({ content, provenance: 'model-tool' });
    assert.equal(v.isProcessArtifact, false,
      `must NOT be blocked: ${content}\n  reason given: ${v.reason}`);
  }
});

test('a process word alone never triggers the filter', () => {
  // This is the rule that keeps the filter from eating the lesson set.
  for (const word of ['评审', '实现方案', 'audit', '评分', '更新报告']) {
    const v = classifyProcessArtifact({ content: `做事之前先想清楚${word}怎么安排`, provenance: 'model-tool' });
    assert.equal(v.isProcessArtifact, false, `${word} alone must not be enough`);
  }
});

test('naming a project alone never triggers the filter either', () => {
  const v = classifyProcessArtifact({
    content: 'dsh-evolve 的记忆注入必须排除已软删记录，否则墓碑会复活',
    provenance: 'model-tool',
  });
  assert.equal(v.isProcessArtifact, false,
    'a real lesson learned while working on a project is still a lesson');
});

test('the version+rev shape is strong enough on its own', () => {
  // "v0.6.0 rev3" does not occur in a durable lesson; it only appears when
  // talking about one specific round of review.
  const v = classifyProcessArtifact({ content: 'v0.6.0 rev3 的结论已经确认', provenance: 'model-tool' });
  assert.equal(v.isProcessArtifact, true);
  assert.deepEqual(v.patternNames, ['version-rev']);
});

test('a semver plus a loose rev token needs a process word too', () => {
  const withoutProcess = classifyProcessArtifact({
    content: 'v0.5.2 的 rev2 分支里改过锁的位置',
    provenance: 'model-tool',
  });
  assert.equal(withoutProcess.isProcessArtifact, false,
    'version references alone are not enough without review vocabulary');

  const withProcess = classifyProcessArtifact({
    content: 'v0.5.2 rev2 评审结论：锁位置要改',
    provenance: 'model-tool',
  });
  assert.equal(withProcess.isProcessArtifact, true);
});

test('an explicit user request is never filtered', () => {
  // The boundary that keeps the filter from overriding a human decision.
  const content = REAL_POLLUTION[0];
  const v = classifyProcessArtifact({ content, provenance: 'explicit-user-request' });
  assert.equal(v.isProcessArtifact, false);
  assert.match(v.reason, /trusted/);
});

test('background-review and model-tool are both subject to the filter', () => {
  // The first design only blocked the background reviewer, which would have
  // missed the pollution that actually happened -- the model wrote it directly.
  for (const provenance of ['background-review', 'model-tool', undefined]) {
    const v = classifyProcessArtifact({ content: REAL_POLLUTION[2], provenance });
    assert.equal(v.isProcessArtifact, true, `provenance=${provenance} must be filtered`);
  }
});

test('kind is never consulted', () => {
  // Deciding from kind was rejected earlier: the model fills it in itself.
  const lesson = GENUINE_LESSONS[0];
  for (const kind of ['lesson', 'preference', 'fact', 'decision']) {
    const v = classifyProcessArtifact({ content: lesson, kind, provenance: 'model-tool' });
    assert.equal(v.isProcessArtifact, false, `kind=${kind} must not change the verdict`);
  }
});

test('empty and malformed input are handled without throwing', () => {
  for (const content of ['', null, undefined, 12345]) {
    const v = classifyProcessArtifact({ content, provenance: 'model-tool' });
    assert.equal(v.isProcessArtifact, false);
  }
  assert.equal(classifyProcessArtifact().isProcessArtifact, false);
});

test('findProcessArtifactSuspects reports without touching anything', () => {
  const records = [
    { id: 'a', kind: 'lesson', importance: 3, content: REAL_POLLUTION[0] },
    { id: 'b', kind: 'lesson', importance: 2, content: GENUINE_LESSONS[0] },
    { id: 'c', kind: 'lesson', importance: 3, content: REAL_POLLUTION[1] },
  ];
  const suspects = findProcessArtifactSuspects(records);
  assert.deepEqual(suspects.map((s) => s.id), ['a', 'c']);
  assert.ok(suspects[0].reason, 'each suspect must explain itself for the panel');
  assert.ok(suspects[0].patternNames.length > 0);
  assert.deepEqual(records.map((r) => r.id), ['a', 'b', 'c'], 'the input must not be mutated');
});

test('suspects respect a record-level provenance', () => {
  const records = [
    { id: 'a', content: REAL_POLLUTION[0], provenance: { kind: 'explicit-user-request' } },
    { id: 'b', content: REAL_POLLUTION[1], provenance: { kind: 'model-tool' } },
  ];
  assert.deepEqual(findProcessArtifactSuspects(records).map((s) => s.id), ['b'],
    'something the user asked for must not show up as a suspect');
});

// ── wired into the store, not just defined ──────────────────────────────────
// A filter that exists but is never called protects nothing; that failure mode
// has bitten this project repeatedly, so assert the real write path.

test('the store refuses a process artifact before it reaches the queue', async () => {
  const { MemoryStore } = await import('../../lib/store.js');
  const records = new Map();
  const table = {
    get: (id) => records.get(id) ?? null,
    entries: () => [...records.entries()],
    size: () => records.size,
    async put(id, r) { records.set(id, r); },
    async delete(id) { records.delete(id); },
    async update(id, fn) { records.set(id, fn(records.get(id))); },
  };
  const audited = [];
  const store = new MemoryStore(table, {
    config: {},
    logger: { warn() {}, info() {} },
  });
  store.onProcessArtifactFiltered = (e) => audited.push(e);

  const written = await store.remember({
    content: REAL_POLLUTION[2], kind: 'lesson', scope: 'project',
    importance: 3, provenance: 'model-tool',
  });
  assert.equal(written, null, 'a suspect write must not land at all');
  assert.equal(records.size, 0, 'not even as a pending item -- it must not dirty the queue');

  assert.equal(audited.length, 1, 'the rejection must be auditable');
  assert.match(audited[0].event, /process-artifact-filtered/);
  assert.ok(audited[0].contentSha256, 'a fingerprint identifies it');
  assert.ok(!JSON.stringify(audited[0]).includes('复评'),
    'the audit line must NOT carry the content -- storing it would defeat the refusal');

  // And a genuine lesson on the same path still lands.
  const kept = await store.remember({
    content: GENUINE_LESSONS[1], kind: 'lesson', scope: 'project',
    importance: 2, provenance: 'model-tool',
  });
  assert.ok(kept, 'the false-positive gate has to hold on the real write path too');
});

test('an explicit user request still lands through the store', async () => {
  const { MemoryStore } = await import('../../lib/store.js');
  const records = new Map();
  const table = {
    get: (id) => records.get(id) ?? null,
    entries: () => [...records.entries()],
    size: () => records.size,
    async put(id, r) { records.set(id, r); },
    async delete(id) { records.delete(id); },
    async update(id, fn) { records.set(id, fn(records.get(id))); },
  };
  const store = new MemoryStore(table, { config: {}, logger: { warn() {}, info() {} } });
  const written = await store.remember({
    content: REAL_POLLUTION[0], kind: 'lesson', scope: 'project',
    importance: 3, provenance: 'explicit-user-request',
  });
  assert.ok(written, 'when a human explicitly asks, the filter must step aside');
});

test('the memory-vs-document rule is stated for the reviewer prompt', () => {
  assert.match(MEMORY_VS_DOCUMENT_RULE, /半年后/);
  assert.match(MEMORY_VS_DOCUMENT_RULE, /文档/);
});
