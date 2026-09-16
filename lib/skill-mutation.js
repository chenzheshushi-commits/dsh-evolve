/**
 * The ONE write throat for every mutation of a live/archived SKILL.md.
 *
 * Nothing in a tool handler, web handler or turn/end hook may call the low-level
 * skills.js mutators directly. That was the v0.5.2 hole: the two model tools
 * could grow a gate while skillOps.fold/converge, rollback and auto-archive kept
 * bypassing it entirely.
 *
 * The fixed order grows in v0.6.0 as the later phases land:
 *   1. structured ownership (here)
 *   2. proposal/authorization (P6; injected policy, fail-closed)
 *   3. baseHash comparison (P6)
 *   4. size cap (P7)
 *   5. secret scan (P3)
 *   6. backup for content rewrites (here; fail-closed)
 *   7. mutation / atomic publish (skills.js; S7)
 *   8. receipt + audit (receipt here; durable operation audit in P6)
 *
 * `skill_style` is deliberately outside this throat: it writes an overlay in
 * evolve-workspace/skill-style/, never touches SKILL.md, and clearing it is a
 * complete rollback.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  writeCrystallizedSkill, refineCrystallizedSkill, foldSkillBody,
  archiveSkill, restoreSkill, restoreFromBackup, backupSkill,
} from './skills.js';
import { classifyOwnership, OWNERSHIP } from './skill-ownership.js';
import { firstSecretReason, secretIncident, MAX_SECRET_SCAN_CHARS } from './secret-scan.js';
import { canonicalSkillHashes } from './skill-proposals.js';

export const SKILL_MUTATION_ACTIONS = Object.freeze([
  'crystallize', 'refine', 'fold', 'converge',
  'archive', 'restore', 'rollback',
]);

const ACTIONS = new Set(SKILL_MUTATION_ACTIONS);
const MANUAL_SOURCES = new Set(['model-tool', 'web-human', 'web-prune']);

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readSkillAt(root, name) {
  const file = join(root, name, 'SKILL.md');
  if (!existsSync(file)) return { exists: false, file, md: null, hash: null };
  const md = readFileSync(file, 'utf8');
  return { exists: true, file, md, hash: hashText(md) };
}

function mutationRefused(action, target, reason, detail = {}) {
  return {
    ok: false,
    action,
    target,
    reason,
    ...detail,
  };
}

/**
 * Ownership decision for a file that is about to be mutated.
 *
 * - owned by this installation: always eligible for the later gates
 * - legacy/unclaimed: manual sources only (keeps v0.5.x assets operable); never
 *   turn/end auto paths
 * - foreign/malformed: hands off, without exception
 */
function ownershipGate(snapshot, ownerId, source) {
  if (!snapshot.exists) return { ok: false, reason: 'skill not found' };
  const verdict = classifyOwnership(snapshot.md, ownerId);
  if (verdict.status === OWNERSHIP.OWNED) return { ok: true, verdict };
  if (verdict.status === OWNERSHIP.LEGACY_UNCLAIMED && MANUAL_SOURCES.has(source)) {
    return { ok: true, verdict, legacy: true };
  }
  return {
    ok: false,
    reason: `ownership refused (${verdict.status}): ${verdict.reason}`,
    verdict,
  };
}

function finalReceipt({ action, target, source, beforeHash, result, extra = {} }) {
  const succeeded = result && (
    result.name || result.refined || result.folded || result.archived
    || result.restored || result.merged || result.converged
  );
  return {
    ...result,
    ok: Boolean(succeeded),
    mutation: {
      action,
      target,
      source,
      status: succeeded ? 'applied' : 'skipped',
      beforeHash: beforeHash ?? null,
      at: new Date().toISOString(),
      ...extra,
    },
  };
}

/**
 * Apply one skill mutation through the central choke point.
 *
 * Required common fields:
 *   action, source, skillsDir, archiveDir, ownerId
 *
 * payload by action:
 *   crystallize { name, tag, records, body, description }
 *   refine      { name, tag, records, body }
 *   fold        { name, body }
 *   converge    { name, tag, records, body, description, originals[] }
 *   archive/restore/rollback { name }
 *
 * Synchronous by design: there is no await between the final authorization
 * decision and the filesystem mutation. LLM work happens before entering here.
 *
 * `dryRun: true` stops immediately after the last gate and returns
 * `{ ok: true, authorized: true }` without touching the disk. That is how the
 * durable transaction layer (skill-operations.js) uses one identical gate: it
 * needs the verdict BEFORE it records an intent and publishes through a protocol
 * that has a real commit point. Two copies of the authorization order would
 * inevitably drift, and the drift would be the security hole.
 */
export function applySkillMutation({
  action,
  source,
  skillsDir,
  archiveDir,
  ownerId,
  logger = { warn() {} },
  payload = {},
  policy = null,
  onSecretIncident = null,
  config = {},
  expectedBaseHashes = null,
  dryRun = false,
}) {
  const target = payload.name ?? null;
  if (!ACTIONS.has(action)) return mutationRefused(action, target, 'unknown mutation action');
  if (!source) return mutationRefused(action, target, 'mutation source is required');
  if (!skillsDir || !archiveDir) return mutationRefused(action, target, 'skill roots are required');
  if (!ownerId) return mutationRefused(action, target, 'installation ownerId is unavailable');

  // Creation is the only action whose destination does not need to exist. If it
  // does exist, it still has to be ours; the low-level writer repeats that check
  // as defence in depth.
  let before = target ? readSkillAt(action === 'restore' ? archiveDir : skillsDir, target)
    : { exists: false, hash: null };

  if (action !== 'crystallize' && action !== 'converge') {
    const own = ownershipGate(before, ownerId, source);
    if (!own.ok) return mutationRefused(action, target, own.reason, { ownership: own.verdict ?? null });
  } else if (before.exists) {
    const own = ownershipGate(before, ownerId, source);
    if (!own.ok) return mutationRefused(action, target, own.reason, { ownership: own.verdict ?? null });
  }

  // A composite converge mutates every original too. Check ALL of them before
  // writing the umbrella, so one foreign input cannot produce a half-merge.
  if (action === 'converge') {
    const originals = Array.isArray(payload.originals) ? payload.originals : [];
    if (originals.length < 2) return mutationRefused(action, target, 'need at least 2 originals');
    for (const name of originals) {
      const snap = readSkillAt(skillsDir, name);
      const own = ownershipGate(snap, ownerId, source);
      if (!own.ok) {
        return mutationRefused(action, target, `original "${name}" refused: ${own.reason}`,
          { ownership: own.verdict ?? null });
      }
    }
  }

  // Proposal-side double hash: compare the exact base observed at proposal
  // creation. Content and semantic state are independent; either change is stale.
  if (expectedBaseHashes) {
    for (const [name, expected] of Object.entries(expectedBaseHashes)) {
      const snap = readSkillAt(skillsDir, name);
      if (!snap.exists) return mutationRefused(action, target, `stale: ${name} missing`);
      const got = canonicalSkillHashes(snap.md);
      if (got.contentHash !== expected.contentHash || got.stateHash !== expected.stateHash) {
        return mutationRefused(action, target, `stale: ${name} changed`, { stale: true, name, expected, got });
      }
    }
  }

  // S4 size caps: automatic paths have a tighter ceiling. If an existing skill
  // is already over the ceiling, only a strictly smaller rewrite may proceed.
  if (typeof payload.body === 'string') {
    const cap = source === 'turn-end-auto' ? Number(config.skillAutoMaxChars ?? 10000)
      : Number(config.skillMaxChars ?? 40000);
    const oldLen = before.md?.length ?? 0;
    const newLen = payload.body.length;
    if (newLen > cap && !(oldLen > cap && newLen < oldLen)) {
      return mutationRefused(action, target,
        `size cap: ${newLen} chars exceeds ${cap}; an over-limit rewrite must be strictly shorter`);
    }
  }

  // Later phases inject the proposal/hash/capability policy here. It is fail-
  // closed: an installed policy that throws or does not explicitly allow cannot
  // accidentally open the gate.
  if (policy) {
    try {
      const verdict = policy({ action, source, target, beforeHash: before.hash, payload });
      if (!verdict || verdict.allowed !== true) {
        return mutationRefused(action, target, verdict?.reason ?? 'mutation policy refused');
      }
    } catch (e) {
      return mutationRefused(action, target, `mutation policy failed closed: ${e?.message ?? e}`);
    }
  }

  // Secret scan is after authorization/baseHash/size policy and before backup or
  // publish. Scan every free-text face separately so a clean body cannot smuggle
  // a token in description/tag/meta. The final rendered SKILL.md is represented by
  // the concatenation of all persisted parts; skills.js adds only fixed template
  // text around these values.
  const secretFaces = [
    ['body', payload.body],
    ['description', payload.description],
    ['tag', payload.tag],
    ['meta', payload.meta == null ? '' : JSON.stringify(payload.meta)],
    ['records', JSON.stringify((payload.records ?? []).map((r) => ({
      content: r?.content, tags: r?.tags,
    })))],
  ];
  for (const [face, value] of secretFaces) {
    const faceText = typeof value === 'string' ? value : String(value ?? '');
    // Unlike memory/audit text, truncating a SKILL body can make it invalid or
    // misleading. Refuse an unscannable face instead of scanning a prefix and
    // persisting an unchecked suffix.
    if (faceText.length > MAX_SECRET_SCAN_CHARS) {
      return mutationRefused(action, target,
        `${face} exceeds the complete secret-scan limit (${MAX_SECRET_SCAN_CHARS} chars)`);
    }
    const reason = firstSecretReason(faceText);
    if (!reason) continue;
    const incident = secretIncident(faceText, {
      source: 'skill-mutation', action, target, face,
      sourceIds: (payload.records ?? []).map((r) => r?.id).filter(Boolean),
    });
    try { onSecretIncident?.(incident); } catch { /* incident reporting never exposes or unblocks */ }
    return mutationRefused(action, target, `${reason} in ${face}`, { incident });
  }

  try {
    // Everything above is authorization. A dry run stops here: the caller has the
    // verdict and will publish through a durable protocol instead.
    if (dryRun) {
      return {
        ok: true,
        // Both bits, deliberately. `ok` alone is what a normal caller checks, and a
        // caller that forgot it asked for a dry run would read `ok: true` as "the
        // change landed" -- so the verdict carries an explicit marker that no write
        // happened. The transaction layer asserts on this before it publishes.
        dryRun: true,
        authorized: true,
        action,
        target,
        beforeHash: before.hash ?? null,
        mutation: { action, target, source, status: 'authorized', beforeHash: before.hash ?? null, at: new Date().toISOString() },
      };
    }
    let result;
    if (action === 'crystallize') {
      result = writeCrystallizedSkill(
        skillsDir, payload.name, payload.tag, payload.records ?? [], logger,
        payload.body, payload.description, { ownerId },
      );
    } else if (action === 'refine') {
      backupSkill(skillsDir, archiveDir, payload.name, 'refine');
      result = refineCrystallizedSkill(
        skillsDir, payload.name, payload.tag, payload.records ?? [], logger,
        payload.body, { ownerId },
      );
    } else if (action === 'fold') {
      backupSkill(skillsDir, archiveDir, payload.name, 'fold');
      result = foldSkillBody(skillsDir, payload.name, payload.body, logger, { ownerId });
    } else if (action === 'archive') {
      result = archiveSkill(skillsDir, archiveDir, payload.name, logger, { ownerId });
    } else if (action === 'restore') {
      result = restoreSkill(skillsDir, archiveDir, payload.name, logger);
    } else if (action === 'rollback') {
      // restoreFromBackup removes the active directory before extracting, so its
      // ownership gate above is non-negotiable.
      result = restoreFromBackup(skillsDir, archiveDir, payload.name, logger);
    } else if (action === 'converge') {
      const created = writeCrystallizedSkill(
        skillsDir, payload.name, payload.tag, payload.records ?? [], logger,
        payload.body, payload.description, { ownerId },
      );
      if (!created) return mutationRefused(action, target, 'umbrella write failed');
      const archived = [];
      const refused = [];
      for (const name of payload.originals) {
        const r = archiveSkill(skillsDir, archiveDir, name, logger, { ownerId });
        if (r?.archived) archived.push(name);
        else refused.push({ name, reason: r?.reason ?? 'archive failed' });
      }
      result = {
        merged: refused.length === 0,
        converged: created.name,
        name: created.name,
        path: created.path,
        archivedOriginals: archived,
        archiveRefusals: refused,
      };
    }
    return finalReceipt({
      action,
      target,
      source,
      beforeHash: before.hash,
      result: result ?? {},
      extra: action === 'converge' ? { originals: [...payload.originals] } : {},
    });
  } catch (e) {
    logger.warn?.(`skill mutation ${action}/${target ?? '-'} refused or failed: ${e?.message ?? e}`);
    return mutationRefused(action, target,
      `mutation failed before publish: ${e?.message ?? e}`,
      { beforeHash: before.hash ?? null });
  }
}
