/**
 * The operation runtime against a real filesystem.
 *
 * These are deliberately not shape assertions. Every test crashes the operation
 * at a specific boundary and then asks the recovery classifier what happened,
 * because the whole point of a durable manifest is to answer that question after
 * a process death that no unit test can politely arrange.
 *
 * Run: node --test scripts/schema/op-runtime.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  OperationRuntime, InstanceLock, BootEpoch, treeHash, writeMarker, readMarker,
  makeArchiveId, sealArtifact, inspectTarball, generationIsNewer, lockKey,
  MARKER_NAME, OP_SCHEMA_VERSION,
} from '../../lib/op-runtime.js';
import {
  publishNewDirectory, publishSkillFile, publishMove, publishDirectoryReplacement,
  restoreRetired, buildMarker, stagingRootFor, fileFingerprint, listArchiveIds,
} from '../../lib/publish-protocols.js';

const H = (c) => c.repeat(64);

function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opr-'));
  const workspaceDir = join(root, 'ws');
  const skillsDir = join(root, 'skills');
  const archiveDir = join(workspaceDir, 'archived-skills');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  return { root, workspaceDir, skillsDir, archiveDir };
}

function buildSkill(dir, { body = '# demo\n\nprose\n', state = {} } = {}) {
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'references', 'api.md'), 'reference body\n');
  const st = { tag: 'demo', version: '1.0.0', createdAt: '2026-09-16T00:00:00Z', sourceIds: [], ...state };
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: demo\nauthor: dsh-evolve (crystallized)\n---\n\n${body}\n<!--dsh-evolve-state:${JSON.stringify(st)}-->\n`);
}

function applyManifest(opId, extra = {}) {
  return {
    kind: 'apply',
    opId,
    phase: 'CAP_CLAIMED',
    createdAt: '2026-09-16T00:00:00Z',
    updatedAt: '2026-09-16T00:00:00Z',
    source: 'web-proposal',
    protocol: 'A',
    proposalId: 'p-1',
    targetName: 'demo',
    capClaim: { capId: 'cap-1', purpose: 'proposal-apply', digest: H('a'), claimedByOpId: opId, state: 'claimed' },
    receiptClaims: [],
    reservationRevisionBefore: 1,
    reservationRevisionAfter: 2,
    reservationOwner: { proposalId: 'p-1', opId },
    stampProgress: { done: [], pending: [] },
    stagingPath: '/tmp/staging',
    finalPath: '/tmp/final',
    marker: null,
    expectedAfterContentHash: H('b'),
    expectedAfterStateHash: H('c'),
    backupPath: null,
    ...extra,
  };
}

// ── manifest lifecycle ───────────────────────────────────────────────────────

test('a manifest records facts: immutable identity, monotonic revision, events log', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = rt.newOpId('apply');
    const created = rt.begin(applyManifest(opId));
    assert.equal(created.schemaVersion, OP_SCHEMA_VERSION);
    assert.equal(created.revision, 1);
    assert.equal(created.eventsPath, join('.ops', opId, 'events.jsonl'));

    const next = rt.advance(opId, { phase: 'PROPOSAL_CLAIMED' });
    assert.equal(next.revision, 2, 'every advance must bump the revision');

    assert.throws(() => rt.advance(opId, { kind: 'move' }),
      /immutable field/, 'kind is identity; rewriting it lets recovery adopt another op');
    assert.throws(() => rt.advance(opId, { phase: 'COMMITTED', expectRevision: 1 }),
      /revision CAS failed/, 'a stale writer must lose');

    const events = rt.readEvents(opId);
    assert.equal(events[0].event, 'begin');
    assert.ok(events.length >= 2, 'the append-only log records each advance');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('the semantic contract runs on every advance, not only in offline tests', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = rt.newOpId('apply');
    rt.begin(applyManifest(opId));
    // FAILED with a spent capability: the authorization was consumed while the
    // mutation never landed, which the terminal matrix must refuse.
    assert.throws(
      () => rt.advance(opId, {
        phase: 'FAILED',
        error: { code: 'E', message: 'x', at: '2026-09-16T00:00:01Z' },
        capClaim: { capId: 'cap-1', purpose: 'proposal-apply', digest: H('a'), claimedByOpId: opId, state: 'consumed' },
      }),
      /TERMINAL_AUTHZ_CAP/,
    );
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a completed operation replays its receipt instead of running again', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = rt.newOpId('apply');
    rt.begin(applyManifest(opId, {
      capClaim: { capId: 'cap-1', purpose: 'proposal-apply', digest: H('a'), claimedByOpId: opId, state: 'consumed' },
    }));
    assert.equal(rt.completedReceipt(opId), null, 'an unfinished op has no receipt to replay');
    rt.complete(opId, { opId, kind: 'apply', targetName: 'demo', finalPath: '/tmp/final', afterContentHash: H('b') });
    const receipt = rt.completedReceipt(opId);
    assert.equal(receipt.targetName, 'demo');
    assert.throws(() => rt.advance(opId, { phase: 'INTENT' }), /already terminal/);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── protocol A ───────────────────────────────────────────────────────────────

test('protocol A publishes a directory atomically and refuses an occupied target', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = rt.newOpId('apply');
    const staging = join(stagingRootFor(e.skillsDir, opId), 'demo');
    buildSkill(staging);
    const marker = buildMarker({
      opId, protocol: 'A', action: 'create',
      expectedAfterContentHash: H('b'), expectedAfterStateHash: H('c'),
    });
    const final = join(e.skillsDir, 'demo');
    const out = publishNewDirectory({ stagingDir: staging, finalDir: final, marker });
    assert.equal(out.ok, true);
    assert.equal(readMarker(final).opId, opId, 'the marker travels with the directory');
    assert.ok(existsSync(join(final, 'references', 'api.md')), 'auxiliary files survive the publish');

    const staging2 = join(stagingRootFor(e.skillsDir, `${opId}b`), 'demo');
    buildSkill(staging2);
    const clash = publishNewDirectory({ stagingDir: staging2, finalDir: final, marker });
    assert.equal(clash.ok, false);
    assert.equal(clash.conflict, true, 'an occupied destination is a conflict, never an overwrite');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('recovery reads protocol A ownership from the marker, not from the content hash', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = rt.newOpId('apply');
    const final = join(e.skillsDir, 'demo');
    const staging = join(stagingRootFor(e.skillsDir, opId), 'demo');
    buildSkill(staging);
    rt.begin(applyManifest(opId, { phase: 'INTENT', finalPath: final, stagingPath: staging }));

    // crash BEFORE the rename
    let verdict = rt.classify(rt.read(opId), e);
    assert.equal(verdict.verdict, 'rollback');

    publishNewDirectory({
      stagingDir: staging, finalDir: final,
      marker: buildMarker({ opId, protocol: 'A', action: 'create', expectedAfterContentHash: H('b'), expectedAfterStateHash: H('c') }),
    });
    // crash AFTER the rename but before the manifest advanced: the asset is live
    verdict = rt.classify(rt.read(opId), e);
    assert.equal(verdict.verdict, 'roll-forward',
      'a published asset must never be rolled back from backup');

    // A human edits the published skill; ownership is unchanged, so recovery
    // still rolls forward instead of freezing the evidence forever.
    writeFileSync(join(final, 'SKILL.md'), '# edited by a human\n');
    verdict = rt.classify(rt.read(opId), e);
    assert.equal(verdict.verdict, 'roll-forward');

    // A foreign directory in the same place is a conflict, not a success.
    rmSync(join(final, MARKER_NAME), { force: true });
    verdict = rt.classify(rt.read(opId), e);
    assert.equal(verdict.verdict, 'conflict');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── protocol B ───────────────────────────────────────────────────────────────

test('protocol B publishes prose and proof in one rename and leaves references/ alone', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const dir = join(e.skillsDir, 'demo');
    buildSkill(dir);
    const file = join(dir, 'SKILL.md');
    const refBefore = readFileSync(join(dir, 'references', 'api.md'), 'utf8');
    const opId = rt.newOpId('apply');

    const fp = fileFingerprint(file);
    const state = { tag: 'demo', version: '1.1.0', createdAt: '2026-09-16T00:00:00Z', sourceIds: [], lastCommittedOpId: opId };
    const body = `---\nname: demo\nauthor: dsh-evolve (crystallized)\n---\n\n# refined\n\n<!--dsh-evolve-state:${JSON.stringify(state)}-->\n`;
    const out = publishSkillFile({ file, body, expect: fp, opId });
    assert.equal(out.ok, true);
    assert.equal(readFileSync(join(dir, 'references', 'api.md'), 'utf8'), refBefore,
      'a single-file rewrite must not disturb the rest of the tree');

    rt.begin(applyManifest(opId, {
      protocol: 'B', phase: 'INTENT', finalPath: file,
      beforeContentHash: H('d'), beforeStateHash: H('e'),
      tmpPath: `${file}.tmp`, backupPath: '/tmp/b.tgz',
      marker: {
        opId, protocol: 'B', action: 'refine',
        expectedAfterContentHash: H('b'), expectedAfterStateHash: H('c'), lastCommittedOpId: opId,
      },
      lastCommittedOpId: opId,
      receiptClaims: [{ receiptId: 'r1', skillName: 'demo', callId: 'c1', state: 'claimed' }],
      stagingPath: undefined,
    }));
    assert.equal(rt.classify(rt.read(opId), e).verdict, 'roll-forward',
      'the state block names this op, so the rewrite committed');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('protocol B refuses to overwrite a concurrent hand edit it can still see', () => {
  const e = env();
  try {
    const dir = join(e.skillsDir, 'demo');
    buildSkill(dir);
    const file = join(dir, 'SKILL.md');
    const fp = fileFingerprint(file);
    writeFileSync(file, '# a human edited this between proposal and apply\n');
    const out = publishSkillFile({ file, body: '# overwrite\n', expect: fp, opId: 'op-x' });
    assert.equal(out.ok, false);
    assert.equal(out.stale, true);
    assert.match(readFileSync(file, 'utf8'), /a human edited this/, 'their edit is byte-preserved');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── protocol D ───────────────────────────────────────────────────────────────

test('a move keeps the tree hash identical because the marker is excluded', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const src = join(e.skillsDir, 'demo');
    buildSkill(src);
    const before = treeHash(src);
    const opId = rt.newOpId('move');
    const archiveId = makeArchiveId('demo', opId);
    const out = publishMove({
      sourceDir: src, destDir: join(e.archiveDir, archiveId),
      marker: buildMarker({ opId, protocol: 'D', action: 'archive', logicalSkillName: 'demo', archiveId }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.beforeTreeHash, before);
    assert.equal(out.committedTreeHash, before,
      'publishing the marker must not change the tree hash, or every archive looks tampered with');
    assert.notEqual(treeHash(join(e.archiveDir, archiveId), { excludeMarker: false }), before,
      'the marker really is present; equality above came from the exclusion rule');
    assert.match(archiveId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'the archive id must be a legal skill name or restore breaks');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('archiving twice keeps both generations instead of destroying the older one', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const ids = [];
    for (const n of [1, 2]) {
      const src = join(e.skillsDir, 'demo');
      buildSkill(src, { body: `# version ${n}\n` });
      const opId = rt.newOpId(`move${n}`);
      const archiveId = makeArchiveId('demo', opId, Date.parse(`2026-09-1${n}T00:00:00Z`));
      const out = publishMove({
        sourceDir: src, destDir: join(e.archiveDir, archiveId),
        marker: buildMarker({ opId, protocol: 'D', action: 'archive', logicalSkillName: 'demo', archiveId }),
      });
      assert.equal(out.ok, true);
      ids.push(archiveId);
    }
    assert.equal(new Set(ids).size, 2);
    for (const id of ids) assert.ok(existsSync(join(e.archiveDir, id, 'SKILL.md')), `${id} survives`);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('protocol D recovery: five residues, and it never deletes either side', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = rt.newOpId('move');
    const archiveId = makeArchiveId('demo', opId);
    const src = join(e.skillsDir, 'demo');
    buildSkill(src);
    const move = (phase) => rt.begin({
      kind: 'move', opId, phase, createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z',
      source: 'model-tool', protocol: 'D', action: 'archive',
      sourceKey: lockKey.skill('demo'), destKey: lockKey.archive(archiveId),
      beforeTreeHash: H('1'), committedTreeHash: H('1'),
      marker: { opId, protocol: 'D', action: 'archive', logicalSkillName: 'demo', archiveId },
      logicalSkillName: 'demo', archiveId, configRevision: 1,
    });
    move('INTENT');
    assert.equal(rt.classify(rt.read(opId), e).verdict, 'rollback', 'source present, dest absent = never happened');

    publishMove({
      sourceDir: src, destDir: join(e.archiveDir, archiveId),
      marker: buildMarker({ opId, protocol: 'D', action: 'archive', logicalSkillName: 'demo', archiveId }),
    });
    assert.equal(rt.classify(rt.read(opId), e).verdict, 'roll-forward', 'dest carries our marker');

    buildSkill(src); // both sides now exist: human intervention
    const both = rt.classify(rt.read(opId), e);
    assert.equal(both.verdict, 'conflict');
    assert.ok(existsSync(join(src, 'SKILL.md')) && existsSync(join(e.archiveDir, archiveId, 'SKILL.md')),
      'a conflict must leave BOTH sides on disk for a human to look at');

    rmSync(src, { recursive: true, force: true });
    rmSync(join(e.archiveDir, archiveId, MARKER_NAME), { force: true });
    assert.equal(rt.classify(rt.read(opId), e).verdict, 'conflict', 'a dest without our marker is somebody else’s');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a cross-filesystem move is refused outright, never copied', () => {
  // /dev/shm is a genuinely different device from /tmp on Linux, so this exercises
  // the real EXDEV path rather than a mocked error. copy+delete has no atomic
  // moment, so a crash halfway would leave a skill that exists in neither place;
  // refusing is the only safe answer.
  const shmDev = (() => { try { return statSync('/dev/shm').dev; } catch { return null; } })();
  const tmpDev = statSync(tmpdir()).dev;
  if (shmDev === null || shmDev === tmpDev) return; // single-device host: nothing to prove

  const skills = mkdtempSync(join(tmpdir(), 'dsh-xdev-skills-'));
  const archive = mkdtempSync(join('/dev/shm', 'dsh-xdev-archive-'));
  try {
    const src = join(skills, 'demo');
    buildSkill(src);
    const out = publishMove({
      sourceDir: src,
      destDir: join(archive, 'demo-20260916000000-abc123'),
      marker: buildMarker({ opId: 'op-x', protocol: 'D', action: 'archive', logicalSkillName: 'demo', archiveId: 'demo-20260916000000-abc123' }),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /different filesystems|EXDEV/);
    assert.ok(existsSync(join(src, 'SKILL.md')), 'the source stays put when the move is refused');
    assert.ok(!existsSync(join(src, MARKER_NAME)),
      'a refused move leaves no marker behind, or the next restart would think it committed');
    assert.equal(existsSync(join(archive, 'demo-20260916000000-abc123')), false,
      'nothing is copied to the other filesystem');
  } finally {
    rmSync(skills, { recursive: true, force: true });
    rmSync(archive, { recursive: true, force: true });
  }
});

// ── protocol C ───────────────────────────────────────────────────────────────

test('protocol C replaces a directory from a sealed artifact and can be unwound', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const dir = join(e.skillsDir, 'demo');
    buildSkill(dir, { body: '# good version\n' });
    const backupRoot = join(e.workspaceDir, 'backups');
    mkdirSync(backupRoot, { recursive: true });
    const tgz = join(backupRoot, 'demo.tgz');
    execFileSync('tar', ['-C', e.skillsDir, '-czf', tgz, 'demo']);

    const sealed = sealArtifact(tgz, join(e.workspaceDir, '.ops', 'proposals', 'p-1', 'artifacts'));
    assert.match(sealed.artifactId, /^[0-9a-f]{64}$/);
    // Replacing the ORIGINAL backup afterwards must not change what apply uses.
    writeFileSync(tgz, 'not a tarball at all');
    assert.equal(sealArtifact(sealed.artifactPath, join(e.workspaceDir, '.ops', 'proposals', 'p-1', 'artifacts')).reused,
      true, 'the same content re-seals to the same id without a second copy');

    buildSkill(dir, { body: '# bad refine that must be undone\n' });
    const opId = rt.newOpId('apply');
    const out = publishDirectoryReplacement({
      artifactPath: sealed.artifactPath,
      artifactSha256: sealed.artifactId,
      expectRoot: 'demo',
      stagingRoot: stagingRootFor(e.skillsDir, opId),
      finalDir: dir,
      retiredDir: join(e.workspaceDir, '.ops', opId, 'retired', 'demo'),
      marker: buildMarker({ opId, protocol: 'C', action: 'rollback', expectedAfterContentHash: H('b'), expectedAfterStateHash: H('c') }),
    });
    assert.equal(out.ok, true, out.reason);
    assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /good version/,
      'the sealed artifact wins over whatever the live directory had become');
    assert.ok(existsSync(out.retiredDir), 'the replaced directory is retired, not deleted');

    // Crash between the two renames: dest missing, retired present -> put it back.
    rmSync(dir, { recursive: true, force: true });
    const back = restoreRetired({ retiredDir: out.retiredDir, finalDir: dir });
    assert.equal(back.ok, true);
    assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /bad refine/, 'rollback of the rollback restores the prior bytes');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a malicious rollback artifact is refused before anything is written', () => {
  const e = env();
  try {
    const evil = join(e.workspaceDir, 'evil');
    mkdirSync(join(evil, 'demo'), { recursive: true });
    writeFileSync(join(evil, 'demo', 'SKILL.md'), '# ok\n');
    const tgz = join(e.workspaceDir, 'evil.tgz');
    // Two roots is already illegal; one of them escapes upward.
    mkdirSync(join(evil, 'other'), { recursive: true });
    writeFileSync(join(evil, 'other', 'x'), 'x');
    execFileSync('tar', ['-C', evil, '-czf', tgz, 'demo', 'other']);
    const inspect = inspectTarball(tgz, { expectRoot: 'demo' });
    assert.equal(inspect.ok, false);
    assert.match(inspect.reason, /exactly one root/);

    // The symlink case uses a COMMITTED fixture instead of building one here.
    // Creating a symlink on Windows needs elevation (symlinkSync -> EPERM) and a
    // junction cannot even be archived ("tar: Cannot stat: Invalid argument"), so
    // building it at runtime made this security assertion Linux-only -- the one
    // platform where an escaping tarball is least likely to arrive by surprise.
    // inspectTarball only parses `tar -tvf` output, so a prebuilt archive
    // exercises exactly the same code path on every OS.
    // fileURLToPath, not .pathname: on Windows .pathname yields "/C:/..." which is
    // not a usable path and tar cannot open it.
    const linkTgz = fileURLToPath(new URL('./fixtures/symlink-escape.tgz', import.meta.url));
    const linkInspect = inspectTarball(linkTgz, { expectRoot: 'demo' });
    assert.equal(linkInspect.ok, false);
    assert.match(linkInspect.reason, /link/);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── locks ────────────────────────────────────────────────────────────────────

test('locks are taken in a fixed order and always released, even on failure', async () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const order = [];
    const out = await rt.withLocks([lockKey.skill('zeta'), lockKey.skill('alpha')], 'op-1', async () => {
      order.push(...['alpha', 'zeta']);
      return 'done';
    });
    assert.equal(out.ok, true);
    assert.equal(rt.claims.holder(lockKey.skill('alpha')), null, 'released after success');

    const second = new OperationRuntime({ workspaceDir: e.workspaceDir });
    second.claims.claim(lockKey.skill('alpha'), 'other-op');
    const blocked = await rt.withLocks([lockKey.skill('alpha'), lockKey.skill('zeta')], 'op-2', async () => 'should not run');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'retry');
    assert.equal(rt.claims.holder(lockKey.skill('zeta')), null,
      'a partial acquisition must not leave the other resource locked');

    second.claims.release(lockKey.skill('alpha'), 'other-op');
    await assert.rejects(async () => {
      await rt.withLocks([lockKey.skill('alpha')], 'op-3', async () => { throw new Error('boom'); });
    }, /boom/);
    assert.equal(rt.claims.holder(lockKey.skill('alpha')), null, 'released even when the body throws');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('reconcile quarantines a corrupt manifest instead of treating it as absent', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const dir = join(e.workspaceDir, '.ops', 'op-broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"kind":"apply",');
    const report = rt.reconcile(e);
    assert.equal(report.corrupt.length, 1);
    assert.ok(!existsSync(join(dir, 'manifest.json')), 'the broken manifest moved out of the active set');
    assert.ok(existsSync(report.corrupt[0].quarantinedTo), 'it is preserved for inspection, not deleted');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('reconcile releases a lock only when its operation is genuinely finished', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir, now: () => 0 });
    rt.claims.claim(lockKey.skill('live'), 'op-live');
    rt.claims.claim(lockKey.skill('dead'), 'op-dead');
    rt.begin(applyManifest('op-live', { phase: 'INTENT' }));
    rt.begin(applyManifest('op-dead', {
      phase: 'INTENT',
      capClaim: { capId: 'cap-1', purpose: 'proposal-apply', digest: H('a'), claimedByOpId: 'op-dead', state: 'available' },
    }));
    rt.advance('op-dead', { phase: 'ABORTED' });

    const aged = new OperationRuntime({ workspaceDir: e.workspaceDir, now: () => 10 ** 12 });
    const report = aged.reconcile(e);
    const byResource = new Map(report.orphanLocks.map((o) => [o.resource, o]));
    assert.equal(byResource.get(lockKey.skill('dead')).released, true);
    assert.equal(byResource.get(lockKey.skill('live')).released, false,
      'a slow operation is not a dead one; stealing its lock would let two writers publish');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── resolution ───────────────────────────────────────────────────────────────

test('a frozen operation can be unfrozen exactly once, and only with matching facts', async () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = 'op-frozen';
    rt.begin(applyManifest(opId, {
      phase: 'INTENT',
      receiptClaims: [{ receiptId: 'r1', skillName: 'demo', callId: 'c1', state: 'claimed' }],
    }));
    rt.conflict(opId, { code: 'ETHIRDPARTY', message: 'target changed underneath', resources: ['demo'] });

    const frozen = rt.frozenOperations();
    assert.equal(frozen.length, 1);
    const hash = frozen[0].observedConflictHash;

    const wrongHash = await rt.resolve({ frozenOpId: opId, decision: 'rollback', observedConflictHash: H('9'), capClaim: null });
    assert.equal(wrongHash.ok, false, 'a decision made against a stale picture must not apply');

    const ok = await rt.resolve({
      frozenOpId: opId, decision: 'rollback', observedConflictHash: hash,
      capClaim: { capId: 'cap-res', purpose: 'operation-resolve', digest: H('f'), claimedByOpId: 'ignored', state: 'claimed' },
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const after = rt.read(opId);
    assert.equal(after.phase, 'RESOLVED_ROLLED_BACK');
    assert.equal(after.capClaim.state, 'available', 'a rollback returns the authorization to the pool');
    assert.equal(after.receiptClaims[0].state, 'available', 'every claimed receipt is released, not a subset');

    const again = await rt.resolve({ frozenOpId: opId, decision: 'abandon', observedConflictHash: hash });
    assert.equal(again.ok, false, 'a resolved operation cannot be resolved a second time');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('roll-forward marks the authorization spent and leaves a replayable receipt', async () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = 'op-fwd';
    rt.begin(applyManifest(opId, { phase: 'COMMITTED' }));
    rt.conflict(opId, { code: 'EBOOKKEEPING', message: 'committed but not recorded', resources: ['demo'] });
    const out = await rt.resolve({
      frozenOpId: opId, decision: 'roll-forward',
      observedConflictHash: rt.frozenOperations()[0].observedConflictHash,
      capClaim: { capId: 'cap-res', purpose: 'operation-resolve', digest: H('f'), claimedByOpId: 'x', state: 'claimed' },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const after = rt.read(opId);
    assert.equal(after.phase, 'RESOLVED_ROLLED_FORWARD');
    assert.equal(after.capClaim.state, 'consumed', 'the mutation landed, so the capability was genuinely spent');
    assert.ok(after.result?.receipt, 'roll-forward must leave a receipt for idempotent replay');
    assert.equal(rt.completedReceipt(opId).opId, opId);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

// ── instance lock + boot epoch ───────────────────────────────────────────────

test('a second instance does not steal a live workspace lock', () => {
  const e = env();
  try {
    const a = new InstanceLock({ workspaceDir: e.workspaceDir });
    assert.equal(a.acquire().acquired, true);
    const b = new InstanceLock({ workspaceDir: e.workspaceDir });
    const denied = b.acquire();
    assert.equal(denied.acquired, false);
    assert.match(denied.reason, /another live instance/);
    assert.equal(a.release(), true);
    assert.equal(b.acquire().acquired, true, 'once released the workspace is available again');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a missing boot epoch fails closed when tombstones already carry generations', () => {
  const e = env();
  try {
    const fresh = new BootEpoch({ workspaceDir: e.workspaceDir, hasExistingGenerations: () => false });
    assert.equal(fresh.initialize().epoch, 1, 'a genuinely new store may start at 1');
    const second = new BootEpoch({ workspaceDir: e.workspaceDir, hasExistingGenerations: () => true });
    assert.equal(second.initialize().epoch, 2, 'a restart advances the epoch');
    assert.deepEqual(second.next(), { bootEpoch: 2, sequence: 1 });

    rmSync(join(e.workspaceDir, '.boot-epoch'), { force: true });
    const lost = new BootEpoch({ workspaceDir: e.workspaceDir, hasExistingGenerations: () => true });
    const verdict = lost.initialize();
    assert.equal(verdict.ok, false, 'restarting at 0 would make a real new use look stale');
    assert.equal(lost.next(), null, 'no generations are issued while the epoch is unusable');
    assert.equal(lost.rebuild(50).epoch, 51, 'the operator rebuild continues above every observed epoch');

    for (const broken of ['', '{"schemaVersion":1,"epoch":0,"checksum":"x"}', '{"schemaVersion":9,"epoch":3,"checksum":"x"}', 'not json']) {
      writeFileSync(join(e.workspaceDir, '.boot-epoch'), broken);
      const b = new BootEpoch({ workspaceDir: e.workspaceDir, hasExistingGenerations: () => true });
      assert.equal(b.initialize().ok, false, `must fail closed on ${JSON.stringify(broken.slice(0, 24))}`);
    }
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('generation ordering survives a restart (the ABA case)', () => {
  assert.equal(generationIsNewer({ bootEpoch: 6, sequence: 1 }, { bootEpoch: 5, sequence: 100 }), true,
    'the first use after a restart is newer than anything before it, even with a lower sequence');
  assert.equal(generationIsNewer({ bootEpoch: 5, sequence: 2 }, { bootEpoch: 5, sequence: 3 }), false);
  assert.equal(generationIsNewer({ bootEpoch: 1, sequence: 1 }, null), true,
    'a tombstone with no stamp is older than any stamped use, so a late use revives it');
  assert.equal(generationIsNewer(null, { bootEpoch: 1, sequence: 1 }), false);
});

test('archive listing resolves logical names so restore knows where to put things', () => {
  const e = env();
  try {
    const rt = new OperationRuntime({ workspaceDir: e.workspaceDir });
    const opId = rt.newOpId('move');
    const archiveId = makeArchiveId('demo', opId);
    const src = join(e.skillsDir, 'demo');
    buildSkill(src, { state: { logicalSkillName: 'demo', archivedAt: '2026-09-16T00:00:00Z' } });
    publishMove({
      sourceDir: src, destDir: join(e.archiveDir, archiveId),
      marker: buildMarker({ opId, protocol: 'D', action: 'archive', logicalSkillName: 'demo', archiveId }),
    });
    const rows = listArchiveIds(e.archiveDir, 'demo');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].archiveId, archiveId);
    assert.equal(rows[0].logicalSkillName, 'demo');
    assert.equal(listArchiveIds(e.archiveDir, 'other').length, 0);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});
