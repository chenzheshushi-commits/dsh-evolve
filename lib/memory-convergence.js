/**
 * Memory convergence: keep the MEMORY store from
 * turning into a noise pile. Three deterministic (zero-LLM) mechanisms:
 *
 *   1. CHAR BUDGET: confirmed memory has a character budget. When exceeded we do
 *      NOT silently drop — we return an "over budget" status with the
 *      lowest-value / oldest trim candidates so the model/human can merge or
 *      forget. Returning a list to act on beats silent truncation: nothing is
 *      lost without a decision.
 *
 *   2. NEAR-DUP / THIN GATE: before a write lands, reject content that is too
 *      THIN (minPromoteChars) or too close to an existing memory beyond the
 *      plain merge threshold (maxContentOverlap). This catches "same thing,
 *      reworded" redundancy that exact-merge misses.
 *
 *   3. LOCAL→GLOBAL PROMOTION: a project-scope (local) memory that has been
 *      reinforced enough AND is general (not tied to one project's specifics) is
 *      a candidate to promote to user-scope (global). Detection only —
 *      promotion is an explicit action.
 *
 * All functions are pure/read-only over a record array; the store applies them.
 *
 * @module dsh-evolve/memory-convergence
 */
import { tokenSetBigram, jaccard } from './search.js';

/**
 * g3. Character-budget status over a set of records (typically confirmed).
 * @param records  records to measure (each has .content, .importance, etc.)
 * @param maxChars budget cap
 * @returns { used, max, overBudget, overBy, trimCandidates } — trimCandidates
 *   are the lowest-importance, least-reinforced, oldest records to consider
 *   merging/forgetting (NEVER auto-dropped here — caller/human decides).
 */
export function budgetStatus(records, maxChars) {
  const used = records.reduce((s, r) => s + String(r.content ?? '').length, 0);
  const overBudget = used > maxChars;
  const overBy = overBudget ? used - maxChars : 0;
  let trimCandidates = [];
  if (overBudget) {
    trimCandidates = [...records]
      .sort((a, b) => (
        (a.importance - b.importance)
        || ((a.observationCount ?? 1) - (b.observationCount ?? 1))
        || String(a.updatedAt).localeCompare(String(b.updatedAt))
      ))
      .slice(0, 10)
      .map((r) => ({
        id: r.id, importance: r.importance, observationCount: r.observationCount ?? 1,
        content: String(r.content).replace(/\s+/g, ' ').slice(0, 80),
      }));
  }
  return { used, max: maxChars, overBudget, overBy, trimCandidates };
}

/**
 * g4. Assess a candidate write BEFORE it lands: is it too thin, or a near-dup
 * (reworded) of an existing same-kind+scope memory beyond the merge threshold?
 * @param candidate {content, kind, scope}
 * @param existing  array of existing records
 * @param cfg {minPromoteChars, maxContentOverlap}
 * @returns { verdict:'ok'|'thin'|'near-duplicate', reason, similarTo? }
 *   'thin'          → below minPromoteChars, likely low-signal; caller may skip.
 *   'near-duplicate'→ overlaps an existing memory >= maxContentOverlap; the
 *                     store's reinforcement merge will fold it (so it's not a new
 *                     row) — this verdict lets callers SKIP creating noise.
 */
export function assessWriteQuality(candidate, existing, cfg = {}) {
  const minChars = cfg.minPromoteChars ?? 8;
  const maxOverlap = cfg.maxContentOverlap ?? 0.6;
  const content = String(candidate.content ?? '').trim();
  if (content.length < minChars) {
    return { verdict: 'thin', reason: `content shorter than ${minChars} chars (low signal)` };
  }
  const incoming = tokenSetBigram(content);
  let best = { sim: 0, rec: null };
  for (const rec of existing) {
    if (rec.scope !== candidate.scope || rec.kind !== candidate.kind) continue;
    const sim = jaccard(incoming, tokenSetBigram(String(rec.content ?? '')));
    if (sim > best.sim) best = { sim, rec };
  }
  if (best.rec && best.sim >= maxOverlap) {
    return {
      verdict: 'near-duplicate',
      reason: `overlaps existing ${best.rec.kind} at ${best.sim.toFixed(2)} (reworded redundancy)`,
      similarTo: best.rec.id,
    };
  }
  return { verdict: 'ok', reason: 'novel enough to store' };
}

/**
 * g5. Find project-scope memories worth promoting to user-scope (global): well
 * reinforced (observationCount >= promoteMinObservations) and not obviously
 * project-specific. Detection only. Returns promotion candidates.
 * @param records array
 * @param cfg {promoteMinObservations}
 */
export function findPromotionCandidates(records, cfg = {}) {
  const minObs = cfg.promoteMinObservations ?? 3;
  return records
    .filter((r) => r.scope === 'project'
      && !r.tags?.includes('pending')
      && (r.observationCount ?? 1) >= minObs
      && (r.kind === 'preference' || r.kind === 'fact' || r.kind === 'lesson'))
    .map((r) => ({
      id: r.id, kind: r.kind, observationCount: r.observationCount ?? 1,
      content: String(r.content).replace(/\s+/g, ' ').slice(0, 80),
    }))
    .sort((a, b) => b.observationCount - a.observationCount);
}
