/**
 * Skill mutations as durable transactions.
 *
 * applySkillMutation() is the authorization throat: it decides whether a change
 * is allowed. This module is the transaction layer underneath it: it decides how
 * the change reaches the disk and what happens if the process dies halfway.
 *
 * Every entry point here follows the same shape:
 *
 *   look up the op registry first  ->  a retry of a finished op replays its
 *                                      receipt and never re-runs the mutation
 *   take the locks in a fixed order
 *   authorize through applySkillMutation with `dryRun` (no writes yet)
 *   record a durable INTENT with the exact expected result
 *   back up, when the change is destructive
 *   publish through one protocol      <- the single commit point
 *   record COMMITTED, then the bookkeeping
 *
 * Two rules matter more than the rest:
 *
 *   - after the commit point nothing rolls back. Bookkeeping is completed by
 *     rolling forward, because the asset is already live and a "rollback" would
 *     destroy work the user may have edited since.
 *   - an outcome that cannot be classified becomes CONFLICT, not a guess. A
 *     frozen operation keeps its authorization claimed and waits for a human;
 *     resolve() is the way out.
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  OperationRuntime, lockKey, makeArchiveId, treeHash, sealArtifact, readMarker,
  removeMarker, memberManifestOf, inspectTarball,
} from './op-runtime.js';
import {
  publishNewDirectory, publishSkillFile, publishMove, publishDirectoryReplacement,
  restoreRetired, buildMarker, stagingRootFor, fileFingerprint, stageExistingSkill,
  cleanStaging, listArchiveIds, assertSameFilesystem,
} from './publish-protocols.js';
import { applySkillMutation } from './skill-mutation.js';
import {
  renderSkillMd, renderRefinedSkill, renderFoldedSkill, backupSkill, readState,
} from './skills.js';
import { canonicalSkillHashes } from './skill-proposals.js';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const nowIso = () => new Date().toISOString();

/** Rendered SKILL.md bytes carry the committing op id inside their state block. */
function stampLastCommittedOpId(md, opId) {
  const re = /<!--dsh-evolve-state:(.*?)-->/s;
  const m = re.exec(md);
  if (!m) return md;
  let state;
  try { state = JSON.parse(m[1]); } catch { return md; }
  state.lastCommittedOpId = opId;
  return md.replace(re, `<!--dsh-evolve-state:${JSON.stringify(state)}-->`);
}

function hashesOf(md) {
  const { contentHash, stateHash } = canonicalSkillHashes(md);
  return { contentHash, stateHash };
}

/** Which publish protocol an action uses. */
export function protocolFor(action) {
  return {
    crystallize: 'A', converge: null, refine: 'B', fold: 'B',
    rollback: 'C', archive: 'D', restore: 'D', autoArchive: 'D',
  }[action] ?? null;
}

export class SkillOperations {
  constructor({
    workspaceDir, skillsDir, archiveDir, ownerId, cfg = {}, logger = { warn() {} },
    runtime = null, store = null, reservations = null, usageReceipts = null,
    onSecretIncident = null, configRevision = 1,
  }) {
    this.workspaceDir = workspaceDir;
    this.skillsDir = skillsDir;
    this.archiveDir = archiveDir;
    this.ownerId = ownerId;
    this.cfg = cfg;
    this.logger = logger;
    this.store = store;
    this.reservations = reservations;
    this.usageReceipts = usageReceipts;
    this.onSecretIncident = onSecretIncident;
    this.configRevision = configRevision;
    this.rt = runtime ?? new OperationRuntime({ workspaceDir, logger });
    // Skill writes are unavailable rather than unsafe when staging cannot be
    // atomic. Reporting that at startup beats discovering it mid-publish.
    this.fsVerdict = assertSameFilesystem(dirname(skillsDir), skillsDir);
    this.archiveFsVerdict = assertSameFilesystem(archiveDir, skillsDir);
  }

  /** True when both staging and the archive can be reached by an atomic rename. */
  get writable() { return this.fsVerdict.ok && this.archiveFsVerdict.ok; }

  get unwritableReason() {
    if (!this.fsVerdict.ok) return this.fsVerdict.reason;
    if (!this.archiveFsVerdict.ok) return this.archiveFsVerdict.reason;
    return null;
  }

  skillDir(name) { return join(this.skillsDir, name); }

  skillFile(name) { return join(this.skillDir(name), 'SKILL.md'); }

  readSkill(name) {
    const file = this.skillFile(name);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8');
  }

  /** Authorize without writing: the same gate, asked to stop before the disk. */
  #authorize({ action, source, payload, expectedBaseHashes = null }) {
    const verdict = applySkillMutation({
      action,
      source,
      skillsDir: this.skillsDir,
      archiveDir: this.archiveDir,
      ownerId: this.ownerId,
      logger: this.logger,
      payload,
      config: this.cfg,
      onSecretIncident: this.onSecretIncident,
      expectedBaseHashes,
      dryRun: true,
    });
    // A verdict that approved AND wrote would mean this layer is about to publish
    // on top of a mutation that already happened -- a double write, and the WAL
    // would describe only half of it. Crash rather than continue: silently
    // publishing twice is far worse than a loud failure here.
    if (verdict.ok === true && verdict.dryRun !== true) {
      throw new Error(`authorization for "${action}" returned an approval without the `
        + 'dryRun marker; refusing to publish because the gate may already have written');
    }
    return verdict;
  }

  #opsDir(opId) { return join(this.workspaceDir, '.ops', opId); }

  #stagingRoot(opId) { return stagingRootFor(this.skillsDir, opId); }

  // ── protocol A: create a new skill directory ───────────────────────────────

  /**
   * Publish a brand-new skill.
   *
   * @param {object} args
   * @param {'web-proposal'|'autonomous-tool'|'model-tool'} args.source
   */
  async createSkill({
    opId, source, name, tag, records = [], body, description, proposalId = null,
    capClaim = null, receiptClaims = [], expectedBaseHashes = null, sourceIds = [],
    reservationKey = null, reservationRevisionBefore = 0, reservationRevisionAfter = null,
  }) {
    if (!this.writable) return { ok: false, status: 503, reason: this.unwritableReason };
    const replay = this.rt.completedReceipt(opId);
    if (replay) return { ok: true, status: 200, replayed: true, receipt: replay };

    const authz = this.#authorize({ action: 'crystallize', source, payload: { name, tag, records, body, description }, expectedBaseHashes });
    if (!authz.ok) return { ok: false, status: authz.stale ? 409 : 403, reason: authz.reason, incident: authz.incident };

    const md = renderSkillMd(name, tag, records, body, description, this.ownerId);
    const finalDir = this.skillDir(name);
    const stagingDir = join(this.#stagingRoot(opId), name);

    return this.#runLocked({
      opId, resources: [lockKey.skill(name)], targetName: name,
      manifest: () => {
        const stamped = stampLastCommittedOpId(md, opId);
        const h = hashesOf(stamped);
        const common = {
          opId,
          phase: 'INTENT',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          source,
          protocol: 'A',
          targetName: name,
          stagingPath: stagingDir,
          finalPath: finalDir,
          marker: buildMarker({
            opId, protocol: 'A', action: 'create',
            expectedAfterContentHash: h.contentHash, expectedAfterStateHash: h.stateHash,
          }),
          expectedAfterContentHash: h.contentHash,
          expectedAfterStateHash: h.stateHash,
          stampProgress: { done: [], pending: [...sourceIds] },
        };
        if (source === 'web-proposal') {
          return {
            ...common,
            kind: 'apply',
            proposalId,
            capClaim,
            receiptClaims,
            reservationRevisionBefore,
            reservationRevisionAfter: reservationRevisionAfter ?? reservationRevisionBefore,
            reservationOwner: proposalId ? { proposalId, opId } : null,
            backupPath: null,
          };
        }
        return {
          ...common,
          kind: 'direct',
          action: 'create',
          sourceIds: [...sourceIds],
          reservationKey: reservationKey ?? sha256(`create\0${name}\0${[...sourceIds].sort().join('\0')}`),
          reservationRevisionBefore,
          // A direct create writes the reservation sidecar itself, so its revision
          // must strictly advance; the contract rejects a no-op pair here.
          reservationRevisionAfter: reservationRevisionAfter ?? reservationRevisionBefore + 1,
          reservationOwner: null,
          configRevision: this.configRevision,
        };
      },
      publish: (manifest) => {
        mkdirSync(stagingDir, { recursive: true });
        writeFileDurable(join(stagingDir, 'SKILL.md'), stampLastCommittedOpId(md, opId));
        return publishNewDirectory({ stagingDir, finalDir, marker: manifest.marker, logger: this.logger });
      },
      receipt: (manifest, published) => ({
        opId, kind: manifest.kind, targetName: name,
        finalPath: finalDir, afterContentHash: manifest.expectedAfterContentHash,
        archiveId: null,
      }),
      finish: async () => { await this.#stampEvidence(sourceIds, opId); },
    });
  }

  // ── protocol B: rewrite one SKILL.md ───────────────────────────────────────

  async rewriteSkill({
    opId, source, action, name, tag = null, records = [], body = null, proposalId = null,
    capClaim = null, receiptClaims = [], expectedBaseHashes = null, sourceIds = [],
  }) {
    if (!this.writable) return { ok: false, status: 503, reason: this.unwritableReason };
    const replay = this.rt.completedReceipt(opId);
    if (replay) return { ok: true, status: 200, replayed: true, receipt: replay };

    const file = this.skillFile(name);
    if (!existsSync(file)) return { ok: false, status: 404, reason: `skill "${name}" not found` };

    const planned = action === 'refine'
      ? renderRefinedSkill(this.skillsDir, name, tag, records, body, { ownerId: this.ownerId, logger: this.logger })
      : renderFoldedSkill(this.skillsDir, name, body, { ownerId: this.ownerId, logger: this.logger });
    if (!planned || planned.refined === false || planned.folded === false) {
      return { ok: false, status: 409, reason: planned?.reason ?? 'nothing to rewrite' };
    }
    const authz = this.#authorize({ action, source, payload: { name, tag, records, body: planned.md }, expectedBaseHashes });
    if (!authz.ok) return { ok: false, status: authz.stale ? 409 : 403, reason: authz.reason, incident: authz.incident };

    const beforeMd = readFileSync(file, 'utf8');
    const beforeHashes = hashesOf(beforeMd);
    const stamped = stampLastCommittedOpId(planned.md, opId);
    const afterHashes = hashesOf(stamped);
    const fingerprint = fileFingerprint(file);
    let backupPath = null;

    return this.#runLocked({
      opId, resources: [lockKey.skill(name)], targetName: name,
      manifest: () => {
        const marker = {
          opId, protocol: 'B', action,
          expectedAfterContentHash: afterHashes.contentHash,
          expectedAfterStateHash: afterHashes.stateHash,
          lastCommittedOpId: opId,
        };
        const common = {
          opId,
          phase: 'INTENT',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          source,
          protocol: 'B',
          targetName: name,
          beforeContentHash: beforeHashes.contentHash,
          beforeStateHash: beforeHashes.stateHash,
          expectedAfterContentHash: afterHashes.contentHash,
          expectedAfterStateHash: afterHashes.stateHash,
          tmpPath: `${file}.tmp`,
          finalPath: file,
          backupPath: 'pending',
          marker,
          lastCommittedOpId: opId,
          receiptClaims,
          stampProgress: { done: [], pending: [...sourceIds] },
        };
        if (source === 'web-proposal') {
          return {
            ...common,
            kind: 'apply',
            proposalId,
            capClaim,
            reservationRevisionBefore: 0,
            reservationRevisionAfter: 0,
            reservationOwner: proposalId ? { proposalId, opId } : null,
          };
        }
        return { ...common, kind: 'direct', action, configRevision: this.configRevision };
      },
      // A rewrite destroys the previous prose, so a missing backup is fatal: an
      // LLM rewrite with no way back is exactly what rollback exists for.
      beforePublish: (manifest) => {
        backupPath = backupSkill(this.skillsDir, this.archiveDir, name, action);
        if (!backupPath) throw new Error('backup produced no artifact; refusing to rewrite without one');
        this.rt.advance(opId, { backupPath });
        return true;
      },
      publish: () => publishSkillFile({ file, body: stamped, expect: fingerprint, opId, logger: this.logger }),
      receipt: (manifest) => ({
        opId, kind: manifest.kind, targetName: name,
        finalPath: file, afterContentHash: afterHashes.contentHash, archiveId: null,
      }),
      finish: async () => { await this.#stampEvidence(sourceIds, opId); },
    });
  }

  // ── protocol D: archive / restore / autoArchive ────────────────────────────

  async archiveSkill({ opId, source, name, capClaim = null, action = 'archive' }) {
    if (!this.writable) return { ok: false, status: 503, reason: this.unwritableReason };
    const replay = this.rt.completedReceipt(opId);
    if (replay) return { ok: true, status: 200, replayed: true, receipt: replay };

    const authz = this.#authorize({ action: 'archive', source, payload: { name } });
    if (!authz.ok) return { ok: false, status: 403, reason: authz.reason };

    const sourceDir = this.skillDir(name);
    // The destination id is fixed inside the lock, so the key we lock and the
    // path we write are always the same one (plan 0K.2).
    const archiveId = makeArchiveId(name, opId);
    const destDir = join(this.archiveDir, archiveId);
    // The archive directory is named by archiveId, so the skill's own name has to
    // be recorded inside it or restore would have nowhere to put it back. Stamped
    // BEFORE hashing, so the move itself still changes nothing.
    this.#stampArchiveIdentity(name, { logicalSkillName: name, archiveId, archivedAt: nowIso() });
    const before = treeHash(sourceDir);

    return this.#runLocked({
      opId, resources: [lockKey.skill(name), lockKey.archive(archiveId)], targetName: name,
      manifest: () => ({
        kind: 'move',
        opId,
        phase: 'INTENT',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source,
        protocol: 'D',
        action,
        sourceKey: lockKey.skill(name),
        destKey: lockKey.archive(archiveId),
        beforeTreeHash: before,
        committedTreeHash: before,
        marker: buildMarker({ opId, protocol: 'D', action, logicalSkillName: name, archiveId }),
        logicalSkillName: name,
        archiveId,
        configRevision: this.configRevision,
        ...(source === 'web-proposal' ? { capClaim } : {}),
      }),
      // Archive is a reversible move that changes no bytes, so a tar backup is a
      // convenience and its failure must not block the operation (plan 0L.3).
      beforePublish: () => {
        try { backupSkill(this.skillsDir, this.archiveDir, name, 'archive'); } catch (e) {
          this.logger.warn?.(`[dsh-evolve] archive backup for ${name} failed (${e?.message ?? e}); `
            + 'continuing because the move is reversible');
        }
        return true;
      },
      publish: (manifest) => publishMove({ sourceDir, destDir, marker: manifest.marker, logger: this.logger }),
      receipt: (manifest) => ({
        opId, kind: 'move', targetName: name, finalPath: destDir, archiveId, afterContentHash: null,
      }),
    });
  }

  async restoreSkill({ opId, source, archiveId, capClaim = null }) {
    if (!this.writable) return { ok: false, status: 503, reason: this.unwritableReason };
    const replay = this.rt.completedReceipt(opId);
    if (replay) return { ok: true, status: 200, replayed: true, receipt: replay };

    const sourceDir = join(this.archiveDir, archiveId);
    if (!existsSync(join(sourceDir, 'SKILL.md'))) {
      return { ok: false, status: 404, reason: `archived skill "${archiveId}" not found` };
    }
    const state = readState(readFileSync(join(sourceDir, 'SKILL.md'), 'utf8')) ?? {};
    const logicalSkillName = state.logicalSkillName ?? archiveId;
    const destDir = this.skillDir(logicalSkillName);
    if (existsSync(destDir)) {
      return { ok: false, status: 409, reason: `an active skill "${logicalSkillName}" already exists; refusing to overwrite it` };
    }
    const before = treeHash(sourceDir);

    return this.#runLocked({
      opId, resources: [lockKey.archive(archiveId), lockKey.skill(logicalSkillName)], targetName: logicalSkillName,
      manifest: () => ({
        kind: 'move',
        opId,
        phase: 'INTENT',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source,
        protocol: 'D',
        action: 'restore',
        sourceKey: lockKey.archive(archiveId),
        destKey: lockKey.skill(logicalSkillName),
        beforeTreeHash: before,
        committedTreeHash: before,
        marker: buildMarker({ opId, protocol: 'D', action: 'restore', logicalSkillName, archiveId }),
        logicalSkillName,
        archiveId,
        configRevision: this.configRevision,
        ...(source === 'web-proposal' ? { capClaim } : {}),
      }),
      publish: (manifest) => publishMove({ sourceDir, destDir, marker: manifest.marker, logger: this.logger }),
      receipt: () => ({
        opId, kind: 'move', targetName: logicalSkillName, finalPath: destDir, archiveId, afterContentHash: null,
      }),
    });
  }

  // ── protocol C: rollback from a sealed artifact ────────────────────────────

  /**
   * Seal the backup a rollback proposal will use.
   *
   * restoreFromBackup used to pick "the newest tarball" at execution time, so a
   * refine happening between proposal and apply silently changed which version
   * came back. The proposal must therefore pin the artifact by content hash, and
   * the bytes must be copied into proposal-owned storage so replacing the
   * original file afterwards cannot affect the result (plan 0I.3/0J.3).
   */
  sealRollbackArtifact({ name, proposalId }) {
    const backupsRoot = join(this.archiveDir, '..', '.curator-backups');
    if (!existsSync(backupsRoot)) return { ok: false, reason: 'no backups exist for this skill' };
    let candidates = [];
    try {
      candidates = readdirSync(backupsRoot)
        .map((d) => ({ dir: d, file: join(backupsRoot, d, `${name}.tgz`) }))
        .filter((c) => existsSync(c.file))
        .sort((a, b) => (a.dir < b.dir ? 1 : -1));
    } catch { candidates = []; }
    if (candidates.length === 0) return { ok: false, reason: `no backup found for "${name}"` };
    const inspect = inspectTarball(candidates[0].file, { expectRoot: name });
    if (!inspect.ok) return { ok: false, reason: inspect.reason };
    const sealed = sealArtifact(candidates[0].file, join(this.workspaceDir, '.ops', 'proposals', proposalId, 'artifacts'));
    const probeRoot = join(this.#stagingRoot(`probe-${proposalId}`));
    let memberManifest = [];
    let restoredHashes = { contentHash: null, stateHash: null };
    try {
      mkdirSync(probeRoot, { recursive: true });
      execFileSync('tar', ['-C', probeRoot, '-xzf', sealed.artifactPath], { stdio: 'ignore' });
      memberManifest = memberManifestOf(join(probeRoot, name), name);
      const md = readFileSync(join(probeRoot, name, 'SKILL.md'), 'utf8');
      restoredHashes = hashesOf(md);
    } finally {
      cleanStaging(join(dirname(this.skillsDir), '.evolve-ops', `probe-${proposalId}`));
    }
    return {
      ok: true,
      artifactId: sealed.artifactId,
      artifactSha256: sealed.artifactId,
      artifactPath: sealed.artifactPath,
      memberManifest,
      expectedRestoredContentHash: restoredHashes.contentHash,
      expectedRestoredStateHash: restoredHashes.stateHash,
      backupDir: candidates[0].dir,
    };
  }

  async rollbackSkill({
    opId, source = 'web-proposal', name, proposalId, artifact, capClaim = null,
  }) {
    if (!this.writable) return { ok: false, status: 503, reason: this.unwritableReason };
    const replay = this.rt.completedReceipt(opId);
    if (replay) return { ok: true, status: 200, replayed: true, receipt: replay };

    const authz = this.#authorize({ action: 'rollback', source, payload: { name } });
    if (!authz.ok) return { ok: false, status: 403, reason: authz.reason };
    if (!artifact?.artifactId) return { ok: false, status: 400, reason: 'rollback needs a sealed artifact' };
    if (!existsSync(artifact.artifactPath)) {
      return { ok: false, status: 409, reason: 'the sealed rollback artifact is missing' };
    }

    const finalDir = this.skillDir(name);
    const retiredDir = join(this.#opsDir(opId), 'retired', name);
    const stagingRoot = this.#stagingRoot(opId);

    return this.#runLocked({
      opId, resources: [lockKey.skill(name)], targetName: name,
      manifest: () => ({
        kind: 'apply',
        opId,
        phase: 'INTENT',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: 'web-proposal',
        protocol: 'C',
        proposalId,
        targetName: name,
        capClaim,
        receiptClaims: [],
        reservationRevisionBefore: 0,
        reservationRevisionAfter: 0,
        reservationOwner: proposalId ? { proposalId, opId } : null,
        stampProgress: { done: [], pending: [] },
        artifactId: artifact.artifactId,
        artifactSha256: artifact.artifactSha256,
        artifactPath: artifact.artifactPath,
        memberManifest: artifact.memberManifest ?? [],
        retiredPath: retiredDir,
        stagingPath: stagingRoot,
        finalPath: finalDir,
        marker: buildMarker({
          opId, protocol: 'C', action: 'rollback',
          expectedAfterContentHash: artifact.expectedRestoredContentHash,
          expectedAfterStateHash: artifact.expectedRestoredStateHash,
        }),
        expectedRestoredContentHash: artifact.expectedRestoredContentHash,
        expectedRestoredStateHash: artifact.expectedRestoredStateHash,
      }),
      publish: (manifest) => publishDirectoryReplacement({
        artifactPath: artifact.artifactPath,
        artifactSha256: artifact.artifactSha256,
        expectRoot: name,
        stagingRoot,
        finalDir,
        retiredDir,
        marker: manifest.marker,
        memberManifest: artifact.memberManifest ?? null,
        logger: this.logger,
      }),
      receipt: (manifest) => ({
        opId, kind: 'apply', targetName: name, finalPath: finalDir,
        afterContentHash: artifact.expectedRestoredContentHash, archiveId: null,
      }),
    });
  }

  // ── converge: a genuine multi-resource transaction ─────────────────────────

  /**
   * Merge several skills into one umbrella.
   *
   * This is the only operation that touches several resources, so it is the only
   * one that can end up genuinely half-done. The rules that make that safe:
   *
   *   - every lock is taken up front, in name order, before anything is read
   *   - every source is hashed and backed up BEFORE the umbrella is published
   *   - the umbrella rename is the commit point; after it, sources are archived
   *     one at a time and each one's status is recorded as it lands
   *   - a source that cannot be archived does NOT roll back the umbrella. The
   *     operation reports PARTIAL and waits for a human, because deleting a live
   *     umbrella to "clean up" would destroy the merge that already succeeded.
   */
  async convergeSkills({
    opId, source, name, tag, records = [], body, description, originals = [],
    proposalId = null, capClaim = null, receiptClaims = [], sourceIds = [],
  }) {
    if (!this.writable) return { ok: false, status: 503, reason: this.unwritableReason };
    const replay = this.rt.completedReceipt(opId);
    if (replay) return { ok: true, status: 200, replayed: true, receipt: replay };
    if (originals.length < 2) return { ok: false, status: 400, reason: 'converge needs at least 2 sources' };
    if (originals.includes(name)) return { ok: false, status: 400, reason: 'the umbrella cannot also be a source' };

    const authz = this.#authorize({ action: 'converge', source, payload: { name, tag, records, body, description, originals } });
    if (!authz.ok) return { ok: false, status: 403, reason: authz.reason, incident: authz.incident };

    const md = stampLastCommittedOpId(renderSkillMd(name, tag, records, body, description, this.ownerId), opId);
    const umbrellaHashes = hashesOf(md);
    const finalDir = this.skillDir(name);
    const stagingDir = join(this.#stagingRoot(opId), name);

    const resources = originals.map((srcName) => {
      const dir = this.skillDir(srcName);
      const skillMd = existsSync(join(dir, 'SKILL.md')) ? readFileSync(join(dir, 'SKILL.md'), 'utf8') : null;
      const h = skillMd ? hashesOf(skillMd) : { contentHash: null, stateHash: null };
      const archiveId = makeArchiveId(srcName, `${opId}-${srcName}`);
      return {
        role: 'source',
        name: srcName,
        beforePath: dir,
        stagingPath: join(this.#stagingRoot(opId), srcName),
        finalPath: join(this.archiveDir, archiveId),
        archiveId,
        beforeContentHash: h.contentHash,
        beforeStateHash: h.stateHash,
        afterContentHash: null,
        afterStateHash: null,
        backupPath: null,
        status: 'pending',
      };
    });
    const missing = resources.filter((r) => r.beforeContentHash === null).map((r) => r.name);
    if (missing.length) return { ok: false, status: 404, reason: `source skills missing: ${missing.join(', ')}` };

    const locks = [
      lockKey.skill(name),
      ...resources.map((r) => lockKey.skill(r.name)),
      ...resources.map((r) => lockKey.archive(r.archiveId)),
    ];

    const held = await this.rt.withLocks(locks, opId, async () => {
      const manifest = this.rt.begin({
        kind: 'converge',
        opId,
        phase: 'PREPARED',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source,
        proposalId,
        targetName: name,
        target: {
          role: 'target',
          name,
          beforePath: null,
          stagingPath: stagingDir,
          finalPath: finalDir,
          archiveId: null,
          beforeContentHash: null,
          beforeStateHash: null,
          afterContentHash: umbrellaHashes.contentHash,
          afterStateHash: umbrellaHashes.stateHash,
          backupPath: null,
          status: 'pending',
        },
        resources,
        receiptClaims,
        configRevision: this.configRevision,
        ...(source === 'web-proposal' ? { capClaim } : {}),
      });

      try {
        // Every source is re-verified and backed up before ANY change: a merge
        // that discovers a problem after publishing has no clean way back.
        const staged = [];
        for (const r of resources) {
          const current = readFileSync(join(r.beforePath, 'SKILL.md'), 'utf8');
          if (hashesOf(current).contentHash !== r.beforeContentHash) {
            this.rt.conflict(opId, {
              code: 'ESTALE', message: `source "${r.name}" changed after the merge was prepared`, resources: [r.name],
            });
            return { ok: false, status: 409, reason: `source "${r.name}" changed; nothing was modified` };
          }
          let backupPath = null;
          try { backupPath = backupSkill(this.skillsDir, this.archiveDir, r.name, 'converge'); } catch (e) {
            this.#fail(opId, `backup of "${r.name}" failed: ${e?.message ?? e}`);
            return { ok: false, status: 500, reason: `backup of "${r.name}" failed; nothing was modified` };
          }
          if (!backupPath) {
            this.#fail(opId, `backup of "${r.name}" produced no artifact`);
            return { ok: false, status: 500, reason: `backup of "${r.name}" produced no artifact; nothing was modified` };
          }
          staged.push({ ...r, backupPath, status: 'staged' });
        }
        this.rt.advance(opId, { phase: 'SOURCES_STAGED', resources: staged });

        mkdirSync(stagingDir, { recursive: true });
        writeFileDurable(join(stagingDir, 'SKILL.md'), md);
        const manifestNow = this.rt.read(opId);
        const published = publishNewDirectory({
          stagingDir,
          finalDir,
          marker: buildMarker({
            opId, protocol: 'A', action: 'converge',
            expectedAfterContentHash: umbrellaHashes.contentHash,
            expectedAfterStateHash: umbrellaHashes.stateHash,
          }),
          logger: this.logger,
        });
        if (!published.ok) {
          if (published.conflict) {
            this.rt.conflict(opId, { code: 'EOCCUPIED', message: published.reason, resources: [name] });
            return { ok: false, status: 409, reason: published.reason };
          }
          this.#fail(opId, published.reason);
          return { ok: false, status: 500, reason: published.reason };
        }
        // ← commit point. From here the umbrella is live and must not be removed.
        this.rt.advance(opId, {
          phase: 'COMMITTED',
          target: { ...manifestNow.target, status: 'committed' },
        });

        const archived = [];
        const failed = [];
        let progress = staged;
        for (const r of staged) {
          const moved = publishMove({
            sourceDir: r.beforePath,
            destDir: r.finalPath,
            marker: buildMarker({
              opId, protocol: 'D', action: 'archive', logicalSkillName: r.name, archiveId: r.archiveId,
            }),
            logger: this.logger,
          });
          progress = progress.map((x) => (x.name === r.name
            ? { ...x, status: moved.ok ? 'archived' : 'staged' } : x));
          // Each source's status is durable as it lands, so a crash while
          // archiving the second source can be resumed precisely.
          this.rt.advance(opId, { resources: progress });
          if (moved.ok) archived.push(r.name);
          else failed.push({ name: r.name, reason: moved.reason });
        }

        if (failed.length) {
          this.rt.conflict(opId, {
            code: 'EPARTIAL',
            message: `umbrella "${name}" is live but ${failed.length} source(s) could not be archived: `
              + failed.map((f) => `${f.name} (${f.reason})`).join('; '),
            resources: failed.map((f) => f.name),
          }, { partial: true });
          return {
            ok: false, status: 409, partial: true, umbrella: name,
            archivedOriginals: archived, archiveRefusals: failed,
            reason: 'the merge is published but archiving is incomplete; an operator decision is required',
          };
        }

        this.rt.advance(opId, { phase: 'ARCHIVE_FINALIZED' });
        await this.#stampEvidence(sourceIds, opId);
        this.#consumeAuthorization(opId);
        const receipt = {
          opId, kind: 'converge', targetName: name, finalPath: finalDir,
          afterContentHash: umbrellaHashes.contentHash, archiveId: null,
        };
        this.rt.complete(opId, receipt);
        cleanStaging(join(dirname(this.skillsDir), '.evolve-ops', opId));
        return { ok: true, status: 200, umbrella: name, path: finalDir, archivedOriginals: archived, receipt };
      } catch (e) {
        this.#freezeOnUnknownFailure(opId, e);
        return { ok: false, status: 500, reason: `converge failed: ${e?.message ?? e}` };
      }
    });
    return held.ok ? held.value : { ok: false, status: 409, reason: held.reason };
  }

  // ── shared transaction skeleton ────────────────────────────────────────────

  async #runLocked({ opId, resources, targetName, manifest, beforePublish = null, publish, receipt, finish = null }) {
    const held = await this.rt.withLocks(resources, opId, async () => {
      const built = this.rt.begin(manifest());
      try {
        if (beforePublish) beforePublish(built);
        const published = publish(this.rt.read(opId));
        if (!published.ok) {
          if (published.stale) {
            this.#abort(opId, published.reason);
            return { ok: false, status: 409, stale: true, reason: published.reason };
          }
          if (published.conflict) {
            this.rt.conflict(opId, { code: 'EOCCUPIED', message: published.reason, resources: [targetName] });
            return { ok: false, status: 409, reason: published.reason };
          }
          this.#fail(opId, published.reason);
          return { ok: false, status: 500, reason: published.reason };
        }
        // ← commit point passed: only roll forward from here.
        const patch = { phase: 'COMMITTED' };
        if (published.committedTreeHash) patch.committedTreeHash = published.committedTreeHash;
        this.rt.advance(opId, patch);
        if (finish) await finish();
        const rec = receipt(this.rt.read(opId), published);
        this.#consumeAuthorization(opId);
        this.rt.complete(opId, rec);
        cleanStaging(join(dirname(this.skillsDir), '.evolve-ops', opId));
        return { ok: true, status: 200, receipt: rec, ...published };
      } catch (e) {
        this.#freezeOnUnknownFailure(opId, e);
        return { ok: false, status: 500, reason: `${e?.message ?? e}` };
      }
    });
    return held.ok ? held.value : { ok: false, status: 409, reason: held.reason, holder: held.holder };
  }

  /**
   * Mark the authorization spent, but only for a mutation that landed.
   *
   * The terminal matrix requires 'consumed' at COMPLETE and 'available' at
   * ABORTED/FAILED, precisely so a failed attempt can be retried without the
   * user minting a new capability.
   */
  #consumeAuthorization(opId) {
    const m = this.rt.read(opId);
    if (m === null) return;
    const patch = {};
    if (m.capClaim && m.capClaim.state === 'claimed') patch.capClaim = { ...m.capClaim, state: 'consumed' };
    if (Array.isArray(m.receiptClaims) && m.receiptClaims.some((r) => r.state === 'claimed')) {
      patch.receiptClaims = m.receiptClaims.map((r) => (r.state === 'claimed' ? { ...r, state: 'consumed' } : r));
      for (const r of m.receiptClaims) {
        if (r.state === 'claimed') { try { this.usageReceipts?.consume?.(r.receiptId, opId); } catch { /* already spent */ } }
      }
    }
    if (Object.keys(patch).length) this.rt.advance(opId, patch);
  }

  /**
   * Hand the authorization back before a non-committing terminal.
   *
   * This is the other half of the matrix and it is a usability rule as much as a
   * safety one: if a failed attempt left the capability 'consumed', the user
   * would have to mint a new one to retry something that never happened.
   * CONFLICT/PARTIAL deliberately do NOT come here -- a frozen operation keeps
   * its claim so nothing else can touch the same target while a human decides.
   */
  #releaseAuthorization(opId) {
    const m = this.rt.read(opId);
    if (m === null) return;
    const patch = {};
    if (m.capClaim && m.capClaim.state === 'claimed') patch.capClaim = { ...m.capClaim, state: 'available' };
    if (Array.isArray(m.receiptClaims) && m.receiptClaims.some((r) => r.state === 'claimed')) {
      patch.receiptClaims = m.receiptClaims.map((r) => (r.state === 'claimed' ? { ...r, state: 'available' } : r));
    }
    if (Object.keys(patch).length) {
      try { this.rt.advance(opId, patch); } catch { /* already terminal */ }
    }
  }

  /** ABORTED with the authorization returned to the pool. */
  #abort(opId, reason) {
    this.#releaseAuthorization(opId);
    this.rt.abort(opId, reason);
  }

  /** FAILED with the authorization returned to the pool. */
  #fail(opId, reason) {
    this.#releaseAuthorization(opId);
    this.rt.fail(opId, reason);
  }

  /**
   * An unexpected throw after the manifest exists is not a plain failure: we do
   * not know whether the commit point was crossed, so the operation freezes for
   * a human instead of guessing (and possibly overwriting a live asset).
   */
  #freezeOnUnknownFailure(opId, error) {
    const m = this.rt.read(opId);
    const message = String(error?.message ?? error).slice(0, 400);
    if (m === null) return;
    if (m.phase === 'COMMITTED' || m.phase === 'ARCHIVE_FINALIZED') {
      try {
        this.rt.conflict(opId, { code: 'EBOOKKEEPING', message: `committed but bookkeeping failed: ${message}`, resources: [m.targetName ?? 'unknown'] });
      } catch { /* already terminal */ }
      return;
    }
    try { this.#fail(opId, message); } catch { /* already terminal */ }
  }

  /**
   * Record the skill's logical identity in its own state block before archiving.
   *
   * The archive directory is named by archiveId (a timestamped name, so two
   * archives of the same skill can coexist and every one stays a legal skill
   * name). That means the directory name no longer tells restore where the skill
   * belongs, so the logical name has to live inside the file.
   */
  #stampArchiveIdentity(name, fields) {
    const file = this.skillFile(name);
    if (!existsSync(file)) return false;
    const md = readFileSync(file, 'utf8');
    const re = /<!--dsh-evolve-state:(.*?)-->/s;
    const m = re.exec(md);
    if (!m) return false;
    let state;
    try { state = JSON.parse(m[1]); } catch { return false; }
    writeFileDurable(file, md.replace(re, `<!--dsh-evolve-state:${JSON.stringify({ ...state, ...fields })}-->`));
    return true;
  }

  /** Idempotent evidence stamping, recorded so a crash can resume it. */
  async #stampEvidence(sourceIds, opId) {
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || !this.store) return;
    const done = [];
    for (const id of sourceIds) {
      try {
        await this.store.markCrystallized([id]);
        done.push(id);
      } catch { /* a missing record is not a reason to lose the merge */ }
    }
    try {
      this.rt.advance(opId, {
        stampProgress: { done, pending: sourceIds.filter((id) => !done.includes(id)) },
      });
    } catch { /* the manifest may already be terminal */ }
  }

  // ── recovery driver ────────────────────────────────────────────────────────

  /**
   * Finish what a crash interrupted.
   *
   * Roll-forward completes bookkeeping for something already published.
   * Rollback only ever touches operations that provably never committed.
   * Anything else is frozen for a human; nothing is deleted on a guess.
   */
  async recover() {
    const report = this.rt.reconcile({ skillsDir: this.skillsDir, archiveDir: this.archiveDir });
    const actions = [];
    for (const entry of report.pending) {
      const m = this.rt.read(entry.opId);
      if (m === null) continue;
      try {
        if (entry.verdict === 'roll-forward') {
          if (m.phase !== 'COMMITTED') this.rt.advance(entry.opId, { phase: 'COMMITTED' });
          const sourceIds = m.stampProgress?.pending ?? [];
          if (sourceIds.length) await this.#stampEvidence(sourceIds, entry.opId);
          this.#consumeAuthorization(entry.opId);
          this.rt.complete(entry.opId, {
            opId: entry.opId, kind: m.kind, targetName: m.targetName ?? m.logicalSkillName ?? 'unknown',
            finalPath: m.finalPath ?? null, afterContentHash: m.expectedAfterContentHash ?? null,
            archiveId: m.archiveId ?? null,
          }, { outcome: 'degraded' });
          actions.push({ opId: entry.opId, action: 'rolled-forward' });
        } else if (entry.verdict === 'rollback') {
          // Only clean up a marker we know we wrote on a source we did not move.
          if (m.kind === 'move' && m.sourceKey?.startsWith('skill.')) {
            const dir = this.skillDir(m.sourceKey.slice('skill.'.length));
            const marker = readMarker(dir);
            if (marker?.opId === entry.opId) removeMarker(dir);
          }
          if (m.protocol === 'B' && m.tmpPath && existsSync(m.tmpPath)) rmSync(m.tmpPath, { force: true });
          this.rt.abort(entry.opId, entry.reason);
          actions.push({ opId: entry.opId, action: 'aborted' });
        } else if (entry.verdict === 'restore-retired') {
          const back = restoreRetired({ retiredDir: m.retiredPath, finalDir: m.finalPath });
          if (back.ok) {
            this.rt.abort(entry.opId, 'restored the retired directory after an interrupted replacement');
            actions.push({ opId: entry.opId, action: 'retired-restored' });
          } else {
            this.rt.conflict(entry.opId, { code: 'ERETIRED', message: back.reason, resources: [m.targetName ?? 'unknown'] });
            actions.push({ opId: entry.opId, action: 'frozen' });
          }
        } else if (entry.verdict === 'release-reservation') {
          try { this.reservations?.release?.(m.proposalId); } catch { /* nothing held */ }
          this.rt.abort(entry.opId, 'released the reservation of an unfinished proposal creation');
          actions.push({ opId: entry.opId, action: 'reservation-released' });
        } else {
          actions.push({ opId: entry.opId, action: 'frozen', reason: entry.reason });
        }
      } catch (e) {
        actions.push({ opId: entry.opId, action: 'recovery-failed', reason: String(e?.message ?? e) });
      }
    }
    return { ...report, actions };
  }

  /** Archived skills, for the settings page and the restore endpoint. */
  listArchives(logicalSkillName = null) {
    return listArchiveIds(this.archiveDir, logicalSkillName);
  }
}

/** Same-directory temp + fsync + rename: a reader sees old or complete bytes. */
function writeFileDurable(file, body) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
