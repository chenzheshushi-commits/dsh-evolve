/**
 * Skill mutations as durable transactions, against a real filesystem.
 *
 * The valuable assertions here are the ones about interruption and partial
 * failure, because those are the states that a passing happy-path test says
 * nothing about. Several tests deliberately break a dependency mid-flight (a
 * backup that throws, an archive that cannot move) and then assert what the
 * operation did with an asset that was already published.
 *
 * Run: node --test scripts/schema/skill-operations.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillOperations, protocolFor } from '../../lib/skill-operations.js';
import { OperationRuntime, readMarker, MARKER_NAME, lockKey } from '../../lib/op-runtime.js';
import { writeCrystallizedSkill, readState } from '../../lib/skills.js';

const OWNER = 'c'.repeat(32);
const H = (c) => c.repeat(64);

function env(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skops-'));
  const workspaceDir = join(root, 'ws');
  const skillsDir = join(root, 'skills');
  const archiveDir = join(workspaceDir, 'archived-skills');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  const store = {
    stamped: [],
    async markCrystallized(ids) { this.stamped.push(...ids); },
  };
  const ops = new SkillOperations({
    workspaceDir, skillsDir, archiveDir, ownerId: OWNER,
    cfg: { skillMaxChars: 40000, skillAutoMaxChars: 10000 },
    logger: { warn() {} },
    store,
    ...overrides,
  });
  return { root, workspaceDir, skillsDir, archiveDir, ops, store };
}

function evidence(tag, n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m_${tag}_${i}`, kind: 'lesson', importance: 2, content: `lesson ${tag} ${i}`, tags: [tag],
  }));
}

function seed(e, name, tag = name, extra = '') {
  const r = writeCrystallizedSkill(e.skillsDir, name, tag, evidence(tag), { warn() {} },
    `# ${name}\n\nSteps.${extra}`, undefined, { ownerId: OWNER });
  assert.ok(r, `seeding ${name}`);
  mkdirSync(join(e.skillsDir, name, 'references'), { recursive: true });
  writeFileSync(join(e.skillsDir, name, 'references', 'api.md'), 'reference body\n');
  return r;
}

const cap = (opId, purpose = 'proposal-apply') => ({
  capId: `cap_${opId}`, purpose, digest: H('a'), claimedByOpId: opId, state: 'claimed',
});

// ── create ───────────────────────────────────────────────────────────────────

test('a created skill is published with a durable manifest and a commit marker', async () => {
  const e = env();
  try {
    const opId = e.ops.rt.newOpId('apply');
    const out = await e.ops.createSkill({
      opId, source: 'web-proposal', name: 'alpha', tag: 'alpha',
      records: evidence('alpha'), body: '# Alpha\n\nDo it.', description: 'Use when alpha.',
      proposalId: 'p-1', capClaim: cap(opId), sourceIds: ['m_alpha_0'],
      reservationRevisionBefore: 1, reservationRevisionAfter: 2,
    });
    assert.equal(out.ok, true, out.reason);
    const file = join(e.skillsDir, 'alpha', 'SKILL.md');
    assert.ok(existsSync(file));
    assert.equal(readMarker(join(e.skillsDir, 'alpha')).opId, opId);
    assert.equal(readState(readFileSync(file, 'utf8')).lastCommittedOpId, opId,
      'the state block names the committing operation, so recovery needs no hash guess');

    const m = e.ops.rt.read(opId);
    assert.equal(m.phase, 'COMPLETE');
    assert.equal(m.capClaim.state, 'consumed', 'a landed mutation spends its authorization');
    assert.deepEqual(m.stampProgress, { done: ['m_alpha_0'], pending: [] });
    assert.deepEqual(e.store.stamped, ['m_alpha_0'], 'the evidence is marked as used');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('retrying a finished operation replays its receipt without touching the skill', async () => {
  const e = env();
  try {
    const opId = e.ops.rt.newOpId('apply');
    const args = {
      opId, source: 'web-proposal', name: 'alpha', tag: 'alpha', records: evidence('alpha'),
      body: '# Alpha\n\nFirst.', proposalId: 'p-1', capClaim: cap(opId),
      reservationRevisionBefore: 1, reservationRevisionAfter: 2,
    };
    await e.ops.createSkill(args);
    const first = readFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), 'utf8');
    const again = await e.ops.createSkill({ ...args, body: '# Alpha\n\nSecond, must not land.' });
    assert.equal(again.replayed, true, 'the op registry answers before the capability is re-checked');
    assert.equal(readFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), 'utf8'), first,
      'a retry is idempotent, not a second write');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a create refuses an occupied destination and freezes rather than overwriting', async () => {
  const e = env();
  try {
    seed(e, 'alpha');
    const before = readFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), 'utf8');
    const opId = e.ops.rt.newOpId('apply');
    const out = await e.ops.createSkill({
      opId, source: 'autonomous-tool', name: 'alpha', tag: 'alpha', records: evidence('alpha'),
      body: '# replacement', sourceIds: [],
    });
    // Authorization allows it (the skill is ours), but the protocol will not
    // publish onto an existing directory; that is a conflict for a human.
    assert.equal(out.ok, false);
    assert.equal(readFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), 'utf8'), before,
      'the existing skill is byte-preserved');
    assert.equal(e.ops.rt.read(opId).phase, 'CONFLICT');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── rewrite (protocol B) ─────────────────────────────────────────────────────

test('a refine rewrites only SKILL.md, keeps references/, and requires a backup', async () => {
  const e = env();
  try {
    seed(e, 'beta');
    const refBefore = readFileSync(join(e.skillsDir, 'beta', 'references', 'api.md'), 'utf8');
    const opId = e.ops.rt.newOpId('apply');
    const out = await e.ops.rewriteSkill({
      opId, source: 'web-proposal', action: 'refine', name: 'beta', tag: 'beta',
      records: evidence('beta-new'), body: null, proposalId: 'p-2', capClaim: cap(opId),
      receiptClaims: [{ receiptId: 'r1', skillName: 'beta', callId: 'c1', state: 'claimed' }],
      sourceIds: ['m_beta-new_0'],
    });
    assert.equal(out.ok, true, out.reason);
    const md = readFileSync(join(e.skillsDir, 'beta', 'SKILL.md'), 'utf8');
    assert.match(md, /## Refinement v1\.1\.0/);
    assert.equal(readState(md).lastCommittedOpId, opId);
    assert.equal(readFileSync(join(e.skillsDir, 'beta', 'references', 'api.md'), 'utf8'), refBefore,
      'a single-file protocol must not disturb the rest of the tree');

    const m = e.ops.rt.read(opId);
    assert.equal(m.phase, 'COMPLETE');
    assert.ok(m.backupPath && existsSync(m.backupPath), 'a destructive rewrite records a real backup');
    assert.equal(m.receiptClaims[0].state, 'consumed');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a rewrite whose backup fails changes nothing at all', async () => {
  const e = env();
  try {
    seed(e, 'beta');
    const before = readFileSync(join(e.skillsDir, 'beta', 'SKILL.md'), 'utf8');
    // Make the backup root unusable so backupSkill throws: a rewrite with no way
    // back must not proceed.
    //
    // This used to be `chmodSync(root, 0o500)`, which does nothing to a DIRECTORY
    // on Windows -- the backup then succeeded, the rewrite went ahead, and the
    // assertion below failed on a platform where the safety property was never
    // tested. Occupying the path with a FILE makes the mkdirSync inside
    // backupSkill fail identically everywhere (ENOTDIR/EEXIST).
    const backupRoot = join(e.workspaceDir, '.curator-backups');
    writeFileSync(backupRoot, 'not a directory\n');
    const opId = e.ops.rt.newOpId('apply');
    const out = await e.ops.rewriteSkill({
      opId, source: 'autonomous-tool', action: 'refine', name: 'beta', tag: 'beta',
      records: evidence('beta-new'), receiptClaims: [{ receiptId: 'r1', skillName: 'beta', callId: 'c1', state: 'claimed' }],
    });
    rmSync(backupRoot, { force: true });
    assert.equal(out.ok, false);
    assert.equal(readFileSync(join(e.skillsDir, 'beta', 'SKILL.md'), 'utf8'), before,
      'no backup means no rewrite');
    assert.equal(e.ops.rt.read(opId).phase, 'FAILED');
    assert.equal(e.ops.rt.read(opId).capClaim ?? null, null);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a hand edit between authorization and publish is detected, not overwritten', async () => {
  const e = env();
  try {
    seed(e, 'beta');
    const opId = e.ops.rt.newOpId('apply');
    // Interpose on the publish step by editing the file after the fingerprint was
    // taken: this is exactly the window protocol B narrows.
    const realRead = e.ops.rt.read.bind(e.ops.rt);
    let interposed = false;
    e.ops.rt.read = (id) => {
      if (!interposed && id === opId) {
        interposed = true;
        writeFileSync(join(e.skillsDir, 'beta', 'SKILL.md'), '# a human rewrote this\n');
      }
      return realRead(id);
    };
    const out = await e.ops.rewriteSkill({
      opId, source: 'autonomous-tool', action: 'refine', name: 'beta', tag: 'beta',
      records: evidence('beta-new'),
      receiptClaims: [{ receiptId: 'r1', skillName: 'beta', callId: 'c1', state: 'claimed' }],
    });
    e.ops.rt.read = realRead;
    assert.equal(out.ok, false);
    assert.equal(out.stale, true, 'the four-field recheck catches the edit it can see');
    assert.match(readFileSync(join(e.skillsDir, 'beta', 'SKILL.md'), 'utf8'), /a human rewrote this/);
    assert.equal(e.ops.rt.read(opId).phase, 'ABORTED');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── archive / restore (protocol D) ───────────────────────────────────────────

test('archive and restore round-trip through archiveIds, keeping every generation', async () => {
  const e = env();
  try {
    seed(e, 'gamma');
    const opA = e.ops.rt.newOpId('move');
    const archived = await e.ops.archiveSkill({ opId: opA, source: 'model-tool', name: 'gamma' });
    assert.equal(archived.ok, true, archived.reason);
    const archiveId = archived.receipt.archiveId;
    assert.match(archiveId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'an illegal id could never be restored');
    assert.ok(!existsSync(join(e.skillsDir, 'gamma')), 'the skill left the watched root');
    assert.ok(existsSync(join(e.archiveDir, archiveId, 'references', 'api.md')), 'the whole tree moved');

    const rows = e.ops.listArchives('gamma');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].archiveId, archiveId);

    const opR = e.ops.rt.newOpId('move');
    const restored = await e.ops.restoreSkill({ opId: opR, source: 'model-tool', archiveId });
    assert.equal(restored.ok, true, restored.reason);
    assert.ok(existsSync(join(e.skillsDir, 'gamma', 'SKILL.md')));
    assert.equal(e.ops.rt.read(opR).phase, 'COMPLETE');

    // A second archive of the same logical skill must not destroy the first.
    const opB = e.ops.rt.newOpId('move');
    const again = await e.ops.archiveSkill({ opId: opB, source: 'model-tool', name: 'gamma' });
    assert.equal(again.ok, true);
    assert.notEqual(again.receipt.archiveId, archiveId);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('restore refuses to overwrite a live skill of the same name', async () => {
  const e = env();
  try {
    seed(e, 'gamma');
    const opA = e.ops.rt.newOpId('move');
    const { receipt } = await e.ops.archiveSkill({ opId: opA, source: 'model-tool', name: 'gamma' });
    seed(e, 'gamma', 'gamma', ' rewritten by hand');
    const opR = e.ops.rt.newOpId('move');
    const out = await e.ops.restoreSkill({ opId: opR, source: 'model-tool', archiveId: receipt.archiveId });
    assert.equal(out.ok, false);
    assert.equal(out.status, 409);
    assert.match(readFileSync(join(e.skillsDir, 'gamma', 'SKILL.md'), 'utf8'), /rewritten by hand/);
    assert.equal(e.ops.rt.read(opR), null, 'a refusal this early records no manifest at all');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── rollback (protocol C) ────────────────────────────────────────────────────

test('rollback uses the artifact pinned at proposal time, not the newest backup', async () => {
  const e = env();
  try {
    seed(e, 'delta', 'delta', '\n\nGOOD CONTENT');
    // A refine creates a backup of the good version, then rewrites the skill.
    const opRefine = e.ops.rt.newOpId('apply');
    await e.ops.rewriteSkill({
      opId: opRefine, source: 'autonomous-tool', action: 'refine', name: 'delta', tag: 'delta',
      records: evidence('delta-new'),
      receiptClaims: [{ receiptId: 'r1', skillName: 'delta', callId: 'c1', state: 'claimed' }],
    });
    assert.match(readFileSync(join(e.skillsDir, 'delta', 'SKILL.md'), 'utf8'), /Refinement/);

    const sealed = e.ops.sealRollbackArtifact({ name: 'delta', proposalId: 'p-roll' });
    assert.equal(sealed.ok, true, sealed.reason);

    // A LATER backup appears (a second refine). The sealed artifact must win.
    const opRefine2 = e.ops.rt.newOpId('apply');
    await e.ops.rewriteSkill({
      opId: opRefine2, source: 'autonomous-tool', action: 'refine', name: 'delta', tag: 'delta',
      records: evidence('delta-newer'),
      receiptClaims: [{ receiptId: 'r2', skillName: 'delta', callId: 'c2', state: 'claimed' }],
    });

    const opId = e.ops.rt.newOpId('apply');
    const out = await e.ops.rollbackSkill({
      opId, name: 'delta', proposalId: 'p-roll', artifact: sealed, capClaim: cap(opId),
    });
    assert.equal(out.ok, true, out.reason);
    const md = readFileSync(join(e.skillsDir, 'delta', 'SKILL.md'), 'utf8');
    assert.match(md, /GOOD CONTENT/);
    assert.ok(!/delta-newer/.test(md), 'the pinned artifact wins over the newest backup');
    assert.equal(e.ops.rt.read(opId).phase, 'COMPLETE');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('rollback refuses an artifact whose bytes changed after sealing', async () => {
  const e = env();
  try {
    seed(e, 'delta');
    const opRefine = e.ops.rt.newOpId('apply');
    await e.ops.rewriteSkill({
      opId: opRefine, source: 'autonomous-tool', action: 'refine', name: 'delta', tag: 'delta',
      records: evidence('delta-new'),
      receiptClaims: [{ receiptId: 'r1', skillName: 'delta', callId: 'c1', state: 'claimed' }],
    });
    const sealed = e.ops.sealRollbackArtifact({ name: 'delta', proposalId: 'p-roll' });
    const before = readFileSync(join(e.skillsDir, 'delta', 'SKILL.md'), 'utf8');
    writeFileSync(sealed.artifactPath, 'tampered, not a tarball');
    const opId = e.ops.rt.newOpId('apply');
    const out = await e.ops.rollbackSkill({
      opId, name: 'delta', proposalId: 'p-roll', artifact: sealed, capClaim: cap(opId),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /sha256/);
    assert.equal(readFileSync(join(e.skillsDir, 'delta', 'SKILL.md'), 'utf8'), before,
      'a failed verification must leave the live skill untouched');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── converge: the multi-resource transaction ─────────────────────────────────

test('converge publishes the umbrella and archives every source', async () => {
  const e = env();
  try {
    seed(e, 'src-one');
    seed(e, 'src-two');
    const opId = e.ops.rt.newOpId('conv');
    const out = await e.ops.convergeSkills({
      opId, source: 'web-proposal', name: 'umbrella', tag: 'umbrella',
      records: evidence('umbrella'), body: '# Umbrella\n\nMerged.', description: 'Use when merged.',
      originals: ['src-one', 'src-two'], proposalId: 'p-3', capClaim: cap(opId),
      receiptClaims: [
        { receiptId: 'r1', skillName: 'src-one', callId: 'c1', state: 'claimed' },
        { receiptId: 'r2', skillName: 'src-two', callId: 'c2', state: 'claimed' },
      ],
      sourceIds: ['m_umbrella_0'],
    });
    assert.equal(out.ok, true, out.reason);
    assert.ok(existsSync(join(e.skillsDir, 'umbrella', 'SKILL.md')));
    for (const n of ['src-one', 'src-two']) {
      assert.ok(!existsSync(join(e.skillsDir, n)), `${n} left the active root`);
    }
    const m = e.ops.rt.read(opId);
    assert.equal(m.phase, 'COMPLETE');
    assert.deepEqual(m.resources.map((r) => r.status), ['archived', 'archived'],
      'each source records its own outcome, so an interrupted merge can be resumed precisely');
    assert.equal(out.archivedOriginals.length, 2);
    // Both sources are recoverable, never deleted.
    assert.equal(e.ops.listArchives('src-one').length, 1);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a source that changes after preparation stops the merge before any write', async () => {
  const e = env();
  try {
    seed(e, 'src-one');
    seed(e, 'src-two');
    const opId = e.ops.rt.newOpId('conv');
    const realBegin = e.ops.rt.begin.bind(e.ops.rt);
    e.ops.rt.begin = (m) => {
      const out = realBegin(m);
      // A concurrent edit to a source, after hashes were captured.
      writeFileSync(join(e.skillsDir, 'src-two', 'SKILL.md'),
        readFileSync(join(e.skillsDir, 'src-two', 'SKILL.md'), 'utf8') + '\nedited concurrently\n');
      return out;
    };
    const out = await e.ops.convergeSkills({
      opId, source: 'autonomous-tool', name: 'umbrella', tag: 'umbrella',
      records: evidence('umbrella'), body: '# Umbrella\n', originals: ['src-one', 'src-two'],
      receiptClaims: [
        { receiptId: 'r1', skillName: 'src-one', callId: 'c1', state: 'claimed' },
        { receiptId: 'r2', skillName: 'src-two', callId: 'c2', state: 'claimed' },
      ],
    });
    e.ops.rt.begin = realBegin;
    assert.equal(out.ok, false);
    assert.match(out.reason, /changed/);
    assert.ok(!existsSync(join(e.skillsDir, 'umbrella')), 'no umbrella is published');
    for (const n of ['src-one', 'src-two']) {
      assert.ok(existsSync(join(e.skillsDir, n, 'SKILL.md')), `${n} is still in place`);
    }
    assert.equal(e.ops.rt.read(opId).phase, 'CONFLICT');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a merge that cannot archive a source reports PARTIAL and keeps the live umbrella', async () => {
  const e = env();
  try {
    seed(e, 'src-one');
    seed(e, 'src-two');
    const opId = e.ops.rt.newOpId('conv');
    // Occupy the archive destination of the SECOND source so its move fails
    // after the umbrella is already live.
    const realRead = e.ops.rt.read.bind(e.ops.rt);
    e.ops.rt.read = (id) => {
      const m = realRead(id);
      if (m?.kind === 'converge' && m.phase === 'SOURCES_STAGED') {
        const blocked = m.resources[1].finalPath;
        mkdirSync(blocked, { recursive: true });
        writeFileSync(join(blocked, 'SKILL.md'), '# somebody else is here\n');
      }
      return m;
    };
    const out = await e.ops.convergeSkills({
      opId, source: 'autonomous-tool', name: 'umbrella', tag: 'umbrella',
      records: evidence('umbrella'), body: '# Umbrella\n', originals: ['src-one', 'src-two'],
      receiptClaims: [
        { receiptId: 'r1', skillName: 'src-one', callId: 'c1', state: 'claimed' },
        { receiptId: 'r2', skillName: 'src-two', callId: 'c2', state: 'claimed' },
      ],
    });
    e.ops.rt.read = realRead;
    assert.equal(out.ok, false);
    assert.equal(out.partial, true);
    assert.ok(existsSync(join(e.skillsDir, 'umbrella', 'SKILL.md')),
      'the published umbrella must survive: removing it would destroy the merge that succeeded');
    assert.equal(out.archivedOriginals.length, 1);
    assert.equal(out.archiveRefusals.length, 1);
    const m = e.ops.rt.read(opId);
    assert.equal(m.phase, 'PARTIAL');
    assert.equal(m.capClaim ?? null, null);
    assert.deepEqual(m.receiptClaims.map((r) => r.state), ['claimed', 'claimed'],
      'a frozen operation keeps its authorization so a concurrent op cannot grab the same target');
    // ...and there is a way out.
    const frozen = e.ops.rt.frozenOperations();
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].phase, 'PARTIAL');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── recovery ─────────────────────────────────────────────────────────────────

test('recovery rolls forward a published skill instead of restoring the backup over it', async () => {
  const e = env();
  try {
    seed(e, 'beta');
    const opId = e.ops.rt.newOpId('apply');
    // Simulate a power loss immediately after the rename: the file lands, and
    // NOTHING further is written to the manifest -- not even a FAILED terminal.
    // That is the state recovery actually has to deal with, and it is why a
    // manifest stuck at INTENT next to a live asset must not be rolled back.
    const realAdvance = e.ops.rt.advance.bind(e.ops.rt);
    let dead = false;
    e.ops.rt.advance = (id, patch) => {
      if (patch.phase === 'COMMITTED') dead = true;
      if (dead) throw new Error('power loss right after the rename');
      return realAdvance(id, patch);
    };
    await assert.doesNotReject(async () => {
      const out = await e.ops.rewriteSkill({
        opId, source: 'autonomous-tool', action: 'refine', name: 'beta', tag: 'beta',
        records: evidence('beta-new'), sourceIds: ['m_beta-new_0'],
        receiptClaims: [{ receiptId: 'r1', skillName: 'beta', callId: 'c1', state: 'claimed' }],
      });
      // The plugin must not propagate the failure into the harness: it reports and
      // leaves the manifest for recovery.
      assert.equal(out.ok, false);
    });
    e.ops.rt.advance = realAdvance;

    const md = readFileSync(join(e.skillsDir, 'beta', 'SKILL.md'), 'utf8');
    assert.match(md, /Refinement/, 'the rewrite did land: the crash was after the commit point');
    assert.equal(e.ops.rt.read(opId).phase, 'INTENT', 'the manifest never learned what happened');

    // A human then edits the published skill, so its hash no longer matches the
    // manifest. Recovery must still complete the bookkeeping.
    writeFileSync(join(e.skillsDir, 'beta', 'SKILL.md'),
      `${md}\n<!-- edited by hand after the crash -->\n`);
    const fresh = new SkillOperations({
      workspaceDir: e.workspaceDir, skillsDir: e.skillsDir, archiveDir: e.archiveDir,
      ownerId: OWNER, cfg: {}, logger: { warn() {} }, store: e.store,
    });
    const report = await fresh.recover();
    const action = report.actions.find((a) => a.opId === opId);
    assert.equal(action.action, 'rolled-forward',
      'op ownership decides, not the current hash; a human edit must not freeze the evidence');
    const after = fresh.rt.read(opId);
    assert.equal(after.phase, 'COMPLETE');
    assert.equal(after.result.outcome, 'degraded', 'a recovered completion says so honestly');
    assert.equal(after.receiptClaims[0].state, 'consumed', 'the mutation landed, so the receipt is spent');
    assert.ok(readFileSync(join(e.skillsDir, 'beta', 'SKILL.md'), 'utf8').includes('edited by hand'),
      'roll-forward does not touch the file');
    assert.deepEqual(e.store.stamped, ['m_beta-new_0'], 'the interrupted evidence stamp is finished');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('recovery cleans up a marker left on a source whose move never happened', async () => {
  const e = env();
  try {
    seed(e, 'gamma');
    const opId = 'op-move-interrupted';
    const archiveId = 'gamma-20260916000000-abc123';
    e.ops.rt.begin({
      kind: 'move', opId, phase: 'INTENT', createdAt: '2026-09-16T00:00:00Z',
      updatedAt: '2026-09-16T00:00:00Z', source: 'model-tool', protocol: 'D', action: 'archive',
      sourceKey: lockKey.skill('gamma'), destKey: lockKey.archive(archiveId),
      beforeTreeHash: H('1'), committedTreeHash: H('1'),
      marker: { opId, protocol: 'D', action: 'archive', logicalSkillName: 'gamma', archiveId },
      logicalSkillName: 'gamma', archiveId, configRevision: 1,
    });
    // Simulate "marker written, rename not reached".
    writeFileSync(join(e.skillsDir, 'gamma', MARKER_NAME), JSON.stringify({ opId }));
    const report = await e.ops.recover();
    assert.equal(report.actions.find((a) => a.opId === opId).action, 'aborted');
    assert.ok(!existsSync(join(e.skillsDir, 'gamma', MARKER_NAME)),
      'a stale marker must go, or the next restart would call this skill already-committed');
    assert.ok(existsSync(join(e.skillsDir, 'gamma', 'SKILL.md')), 'the skill itself is untouched');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('recovery freezes an ambiguous residue instead of deleting a side', async () => {
  const e = env();
  try {
    seed(e, 'gamma');
    const opId = 'op-both-exist';
    const archiveId = 'gamma-20260916000000-def456';
    mkdirSync(join(e.archiveDir, archiveId), { recursive: true });
    writeFileSync(join(e.archiveDir, archiveId, 'SKILL.md'), '# archived copy\n');
    e.ops.rt.begin({
      kind: 'move', opId, phase: 'INTENT', createdAt: '2026-09-16T00:00:00Z',
      updatedAt: '2026-09-16T00:00:00Z', source: 'model-tool', protocol: 'D', action: 'archive',
      sourceKey: lockKey.skill('gamma'), destKey: lockKey.archive(archiveId),
      beforeTreeHash: H('1'), committedTreeHash: H('1'),
      marker: { opId, protocol: 'D', action: 'archive', logicalSkillName: 'gamma', archiveId },
      logicalSkillName: 'gamma', archiveId, configRevision: 1,
    });
    const report = await e.ops.recover();
    assert.equal(e.ops.rt.read(opId).phase, 'CONFLICT');
    assert.ok(existsSync(join(e.skillsDir, 'gamma', 'SKILL.md')) && existsSync(join(e.archiveDir, archiveId, 'SKILL.md')),
      'both sides survive a conflict; a human decides which one is right');
    assert.equal(report.frozen.length + report.pending.filter((p) => p.verdict === 'conflict').length >= 1, true);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a frozen merge is unfrozen by an operator decision, releasing its receipts', async () => {
  const e = env();
  try {
    seed(e, 'src-one');
    seed(e, 'src-two');
    const opId = e.ops.rt.newOpId('conv');
    const realRead = e.ops.rt.read.bind(e.ops.rt);
    e.ops.rt.read = (id) => {
      const m = realRead(id);
      if (m?.kind === 'converge' && m.phase === 'SOURCES_STAGED') {
        mkdirSync(m.resources[1].finalPath, { recursive: true });
        writeFileSync(join(m.resources[1].finalPath, 'SKILL.md'), '# occupied\n');
      }
      return m;
    };
    await e.ops.convergeSkills({
      opId, source: 'autonomous-tool', name: 'umbrella', tag: 'umbrella',
      records: evidence('umbrella'), body: '# Umbrella\n', originals: ['src-one', 'src-two'],
      receiptClaims: [
        { receiptId: 'r1', skillName: 'src-one', callId: 'c1', state: 'claimed' },
        { receiptId: 'r2', skillName: 'src-two', callId: 'c2', state: 'claimed' },
      ],
    });
    e.ops.rt.read = realRead;
    const frozen = e.ops.rt.frozenOperations()[0];
    const out = await e.ops.rt.resolve({
      frozenOpId: opId, decision: 'roll-forward',
      observedConflictHash: frozen.observedConflictHash,
      capClaim: { capId: 'cap-res', purpose: 'operation-resolve', digest: H('f'), claimedByOpId: 'x', state: 'claimed' },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const after = e.ops.rt.read(opId);
    assert.equal(after.phase, 'RESOLVED_ROLLED_FORWARD');
    assert.deepEqual(after.receiptClaims.map((r) => r.state), ['consumed', 'consumed'],
      'roll-forward means the change landed, so the authorization was genuinely spent');
    assert.ok(existsSync(join(e.skillsDir, 'umbrella', 'SKILL.md')));
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('protocol selection is explicit per action', () => {
  assert.equal(protocolFor('crystallize'), 'A');
  assert.equal(protocolFor('refine'), 'B');
  assert.equal(protocolFor('fold'), 'B');
  assert.equal(protocolFor('rollback'), 'C');
  assert.equal(protocolFor('archive'), 'D');
  assert.equal(protocolFor('restore'), 'D');
  assert.equal(protocolFor('autoArchive'), 'D');
  assert.equal(protocolFor('converge'), null, 'converge is a multi-resource transaction, not one protocol');
});
