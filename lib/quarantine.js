/**
 * Secret incidents: review and regenerate, without ever holding the secret.
 *
 * The raw body is deliberately never persisted. So "regenerate a candidate" can
 * not mean "release the old bytes for another look" -- it means building a fresh
 * proposal skeleton from the source memory ids, which are safe to keep.
 *
 * The capability that approves an apply binds to a canonical occurrence multiset
 * (field, rule, ordinal, offsets, per-match fingerprint) plus the scanner and
 * normalization versions. Each piece is there for a specific failure:
 *
 *   - a MULTISET, not a set: two identical matches in one field are two
 *     occurrences, so approving one false positive cannot wave through a second
 *     copy of the same secret hiding behind an identical fingerprint.
 *   - scannerVersion / normalizationVersion: an approval decided under one
 *     scanner must not silently authorize an apply after the scanner changed --
 *     the new scanner may see different occurrences in the same text.
 *   - incidentRevision: the incident file can be rewritten (more sources found).
 *     An approval for revision 1 must not apply to revision 2.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { SECRET_PATTERNS } from './secret-scan.js';

/**
 * Bumped when the scanner's pattern table changes in a way that could change
 * which occurrences are found. Derived from the table itself rather than a
 * hand-maintained constant, because a hand-maintained one drifts silently: a new
 * vendor pattern would change the findings while the version still claimed '1'.
 */
export const SCANNER_VERSION = createHash('sha256')
  .update(SECRET_PATTERNS.map((p) => `${p.name}:${p.re.source}`).join('\u0000'))
  .digest('hex').slice(0, 12);

/**
 * Bumped when the text normalization ahead of scanning changes. Currently the
 * scanner clips to MAX_SECRET_SCAN_CHARS and does nothing else, so this is a
 * literal -- but it is a separate axis from the pattern table and must stay one,
 * since a normalization change also changes offsets.
 */
export const NORMALIZATION_VERSION = 'clip-1';

/** How many regenerate previews one incident may produce, ever. */
const MAX_PREVIEWS_PER_INCIDENT = 5;
/** How many live candidates may exist at once, across all incidents. */
const MAX_LIVE_CANDIDATES = 50;

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  }
  return v;
}

/**
 * Occurrences in a stable, comparable order.
 *
 * Sorted so the same findings always produce the same digest regardless of the
 * order the scanner reported them, and `ordinal` distinguishes repeated matches
 * within one field so the list is a multiset rather than a set.
 */
export function canonicalOccurrences(occurrences = []) {
  const perField = new Map();
  return [...occurrences]
    .map((o) => ({
      field: o.field ?? null,
      rule: o.rule ?? o.patternName ?? null,
      start: Number.isFinite(o.start) ? o.start : null,
      end: Number.isFinite(o.end) ? o.end : null,
      matchFingerprint: o.matchFingerprint ?? o.sha256 ?? null,
    }))
    .sort((a, b) => {
      const f = String(a.field).localeCompare(String(b.field));
      if (f !== 0) return f;
      if ((a.start ?? 0) !== (b.start ?? 0)) return (a.start ?? 0) - (b.start ?? 0);
      if ((a.end ?? 0) !== (b.end ?? 0)) return (a.end ?? 0) - (b.end ?? 0);
      return String(a.rule).localeCompare(String(b.rule));
    })
    .map((o) => {
      // Ordinal is assigned AFTER sorting, so it is a property of position in the
      // canonical order rather than of scanner output order.
      const key = `${o.field}\u0000${o.rule}\u0000${o.matchFingerprint}`;
      const n = (perField.get(key) ?? 0);
      perField.set(key, n + 1);
      return { ...o, ordinal: n };
    });
}

export class QuarantineService {
  constructor({ workspaceDir, proposalStore, ttlMs = 10 * 60 * 1000, now = () => Date.now() }) {
    this.dir = join(workspaceDir, 'secret-incidents');
    this.proposals = proposalStore;
    this.ttlMs = ttlMs;
    this.now = now;
    this.candidates = new Map();
    /** incidentId -> previews issued. Capacity control, and it never resets. */
    this.previewCounts = new Map();
  }

  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const x = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
          return {
            incidentId: x.incidentId,
            patternName: x.patternName,
            maskedSnippet: x.maskedSnippet,
            sourceIds: x.sourceIds ?? [],
            at: x.at,
            // Carried through so the UI can show, and the capability can bind to,
            // the exact findings this incident was raised for.
            occurrences: canonicalOccurrences(x.occurrences ?? []),
            incidentRevision: Number(x.incidentRevision ?? 1),
            scannerVersion: x.scannerVersion ?? null,
            normalizationVersion: x.normalizationVersion ?? null,
          };
        } catch { return null; }
      })
      .filter(Boolean);
  }

  /**
   * The digest an approval is bound to.
   *
   * Exposed so the route, the capability and any test all compute it the same
   * way. Three copies of this logic would drift, and the drift would be the hole.
   */
  candidateDigestTarget(candidate) {
    return {
      incidentId: candidate.incidentId,
      candidateId: candidate.candidateId,
      contentHash: candidate.contentHash,
      scannerVersion: candidate.scannerVersion,
      normalizationVersion: candidate.normalizationVersion,
      incidentRevision: candidate.incidentRevision,
      sourceIds: [...(candidate.sourceIds ?? [])].sort(),
      canonicalOccurrences: candidate.canonicalOccurrences ?? [],
    };
  }

  regenerate(id) {
    const inc = this.list().find((x) => x.incidentId === id);
    if (!inc) return { ok: false, status: 404, error: 'incident-not-found' };

    // Capacity limits before any work: an unbounded preview endpoint is a way to
    // grow memory from outside, and repeated regeneration of one incident is
    // never legitimate -- the answer does not change.
    this.#expireStale();
    const issued = this.previewCounts.get(id) ?? 0;
    if (issued >= MAX_PREVIEWS_PER_INCIDENT) {
      return { ok: false, status: 429, error: 'preview-limit-reached',
        detail: `this incident has already produced ${issued} previews` };
    }
    if (this.candidates.size >= MAX_LIVE_CANDIDATES) {
      return { ok: false, status: 429, error: 'too-many-live-candidates' };
    }

    const candidateId = `qc_${this.now().toString(36)}_${createHash('sha256')
      .update(`${id}:${issued}:${this.now()}`).digest('hex').slice(0, 8)}`;
    const expiresAt = this.now() + this.ttlMs;
    // The raw body was intentionally never persisted. Regeneration is therefore a
    // new proposal skeleton from source ids, not a release of old secret bytes.
    const maskedPreview = `Regenerate a new skill proposal from source memories: ${inc.sourceIds.join(', ')}`;
    const candidate = {
      candidateId,
      incidentId: id,
      contentHash: createHash('sha256').update(maskedPreview).digest('hex'),
      maskedPreview,
      expiresAt,
      // The versions the DECISION is made under, read from the scanner rather
      // than hardcoded, so a scanner change invalidates outstanding approvals.
      scannerVersion: SCANNER_VERSION,
      normalizationVersion: NORMALIZATION_VERSION,
      incidentRevision: inc.incidentRevision,
      sourceIds: inc.sourceIds,
      canonicalOccurrences: inc.occurrences,
    };
    this.candidates.set(candidateId, candidate);
    this.previewCounts.set(id, issued + 1);
    return {
      ok: true, ...candidate,
      expiresAt: new Date(expiresAt).toISOString(),
      previewsRemaining: MAX_PREVIEWS_PER_INCIDENT - (issued + 1),
    };
  }

  apply(id, candidateId) {
    const c = this.candidates.get(candidateId);
    if (!c || c.incidentId !== id || c.expiresAt <= this.now()) {
      return { ok: false, status: 409, error: 'candidate-expired-or-mismatch' };
    }
    // The scanner may have changed between preview and apply (a plugin upgrade
    // mid-session). The approval was made under the old one, so refuse rather
        // than apply a decision to findings nobody reviewed.
    if (c.scannerVersion !== SCANNER_VERSION || c.normalizationVersion !== NORMALIZATION_VERSION) {
      this.candidates.delete(candidateId);
      return { ok: false, status: 409, error: 'scanner-version-changed',
        detail: 'the secret scanner changed after this candidate was reviewed; regenerate it' };
    }
    // And the incident itself may have been rewritten with more sources.
    const inc = this.list().find((x) => x.incidentId === id);
    if (!inc) return { ok: false, status: 404, error: 'incident-not-found' };
    if (Number(inc.incidentRevision ?? 1) !== c.incidentRevision) {
      this.candidates.delete(candidateId);
      return { ok: false, status: 409, error: 'incident-revised',
        detail: 'the incident changed after this candidate was reviewed; regenerate it' };
    }
    // Occurrences are compared canonically: a re-scan that found one more copy of
    // the same secret must not be waved through by an older approval.
    const before = JSON.stringify(canonical(c.canonicalOccurrences ?? []));
    const after = JSON.stringify(canonical(inc.occurrences ?? []));
    if (before !== after) {
      this.candidates.delete(candidateId);
      return { ok: false, status: 409, error: 'occurrences-changed',
        detail: 'the findings changed after this candidate was reviewed; regenerate it' };
    }

    this.candidates.delete(candidateId);
    const p = this.proposals.create({
      action: 'crystallize',
      targetSkill: `regenerated-${id.slice(-8)}`,
      tag: 'quarantine-regenerated',
      body: c.maskedPreview,
      sourceIds: c.sourceIds,
      meta: { regeneratedFromIncident: id },
    });
    return { ok: true, newProposalId: p.id };
  }

  /** Drop expired candidates so the map cannot grow without bound. */
  #expireStale() {
    const t = this.now();
    for (const [k, v] of this.candidates) {
      if (v.expiresAt <= t) this.candidates.delete(k);
    }
  }
}
