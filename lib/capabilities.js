/**
 * One-time, same-origin capabilities for privileged Web actions.
 *
 * What this is: CSRF protection, replay protection, and an audit anchor. What it
 * is NOT: proof that a human clicked. A local model can reach the loopback API
 * itself, so claiming otherwise would be a lie we then designed against. Genuine
 * human authorization only exists on the ApprovalService path, which runs inside
 * the turn that asked for it.
 *
 * Two rules make the binding real:
 *
 *   - the digest is computed SERVER-side from the authoritative object. If the
 *     client submitted a digest it could pick a weak one, and "the capability
 *     matches the target" would mean nothing.
 *   - it is recomputed at consume time. A capability minted for one state of a
 *     proposal must not still apply after that proposal changed.
 */

import { createHash, randomUUID } from 'node:crypto';

/**
 * Which fields each purpose binds to. Adding a purpose here is what makes it
 * exist: mint, consume and the route table all read this one table, so a new
 * action cannot accidentally ship with a weaker binding than its siblings.
 *
 * `skill-rollback` is deliberately absent. A rollback deletes the live directory
 * before extracting, so it may only ever run as a reviewed proposal -- there is
 * no direct-mutation endpoint for it to authorize.
 */
export const ACTION_CAP_SPECS = Object.freeze({
  'proposal-apply': (t) => ({ proposalId: t.proposalId, proposalHash: t.proposalHash, baseHashes: t.baseHashes }),
  'proposal-reject': (t) => ({ proposalId: t.proposalId, proposalHash: t.proposalHash, baseHashes: t.baseHashes }),
  'rollback-proposal-create': (t) => ({
    logicalSkillName: t.logicalSkillName,
    selectedArtifactId: t.selectedArtifactId,
    artifactSha256: t.artifactSha256,
    currentContentHash: t.currentContentHash,
    currentStateHash: t.currentStateHash,
  }),
  'skill-archive': (t) => ({
    name: t.name, contentHash: t.contentHash, sourceTreeHash: t.sourceTreeHash,
  }),
  'skill-restore': (t) => ({
    archiveId: t.archiveId, logicalSkillName: t.logicalSkillName, archivedTreeHash: t.archivedTreeHash,
  }),
  'legacy-claim': (t) => ({ name: t.name, contentHash: t.contentHash, stateHash: t.stateHash }),
  'operation-resolve': (t) => ({
    resolvesOpId: t.resolvesOpId, resolvedKind: t.resolvedKind,
    observedConflictHash: t.observedConflictHash, decision: t.decision,
  }),
  'memory-discard': (t) => ({ ids: [...(t.ids ?? [])].sort() }),
  'memory-restore-rejected': (t) => ({ ids: [...(t.ids ?? [])].sort() }),
  'quarantine-apply': (t) => ({
    incidentId: t.incidentId, candidateId: t.candidateId, contentHash: t.contentHash,
    scannerVersion: t.scannerVersion ?? null,
    normalizationVersion: t.normalizationVersion ?? null,
    incidentRevision: t.incidentRevision ?? null,
    sourceIds: [...(t.sourceIds ?? [])].sort(),
    // A multiset, not a set: two identical matches in one field are two
    // occurrences, so approving one false positive cannot silently wave through
    // a second copy of the same secret.
    canonicalOccurrences: [...(t.canonicalOccurrences ?? [])]
      .map((o) => ({
        field: o.field ?? null, rule: o.rule ?? null, ordinal: o.ordinal ?? null,
        start: o.start ?? null, end: o.end ?? null, matchFingerprint: o.matchFingerprint ?? null,
      }))
      .sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))),
  }),
});

export const CAPABILITY_PURPOSES = Object.freeze(Object.keys(ACTION_CAP_SPECS));

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

export function buildCanonicalDigest(purpose, target) {
  const fn = ACTION_CAP_SPECS[purpose];
  if (!fn) throw new Error(`unknown capability purpose: ${purpose}`);
  return createHash('sha256').update(JSON.stringify(canonical(fn(target ?? {})))).digest('hex');
}

export class CapabilityStore {
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  mint({ purpose, target, sessionKey, fetchSite }) {
    const capId = `cap_${randomUUID()}`;
    const digest = buildCanonicalDigest(purpose, target);
    const expiresAt = this.now() + this.ttlMs;
    this.map.set(capId, { capId, purpose, digest, sessionKey, fetchSite, expiresAt, consumedBy: null });
    return { capId, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Spend a capability, or explain precisely why not.
   *
   * The digest is rebuilt from the target the caller passes now, so a target that
   * changed since mint no longer matches. Being right at mint time is not enough.
   */
  consume({ capId, purpose, target, sessionKey, fetchSite, opId }) {
    const c = this.map.get(capId);
    if (!c || c.consumedBy) return { ok: false, code: 401, error: 'capability-consumed-or-unknown' };
    if (c.expiresAt <= this.now()) return { ok: false, code: 401, error: 'capability-expired' };
    if (c.purpose !== purpose) return { ok: false, code: 403, error: 'capability-wrong-purpose' };
    let digest;
    try { digest = buildCanonicalDigest(purpose, target); } catch {
      return { ok: false, code: 403, error: 'capability-target-or-session-mismatch' };
    }
    if (c.digest !== digest || c.sessionKey !== sessionKey || c.fetchSite !== fetchSite) {
      return { ok: false, code: 403, error: 'capability-target-or-session-mismatch' };
    }
    // Claimed synchronously, before any await can interleave: a second request
    // arriving during a slow apply must lose here rather than run in parallel.
    c.consumedBy = opId ?? `op_${randomUUID()}`;
    return { ok: true, capId, purpose, digest, claimedByOpId: c.consumedBy };
  }

  /** The manifest form of a spent capability. */
  claimFor(capId, opId) {
    const c = this.map.get(capId);
    if (!c) return null;
    return { capId: c.capId, purpose: c.purpose, digest: c.digest, claimedByOpId: opId, state: 'claimed' };
  }

  /** Return an unspent capability to the pool after a failure before commit. */
  release(capId) {
    const c = this.map.get(capId);
    if (!c) return false;
    c.consumedBy = null;
    return true;
  }
}
