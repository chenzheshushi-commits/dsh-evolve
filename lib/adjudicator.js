/**
 * Tiered adjudication (v0.4.0 direction 1): decide whether a model-written
 * memory can be AUTO-CONFIRMED or must stay PENDING for human review.
 *
 * WHY: v0.3.x marks every model write pending → the user must confirm even
 * blatantly-obvious ones ("user prefers Chinese", an explicit correction).
 * This module lets obvious, low-risk, reversible writes through automatically
 * while still trapping anything risky.
 *
 * ⚠️ IRONCLAD (v0.2.1 rejected the wrong path, never repeat): auto-confirm
 * MUST NOT key off the `kind` field. `kind` is model-self-reported; letting a
 * self-reported field decide its own exemption hands the approval gate back to
 * the audited party = no gate at all. Every signal used here is one the model
 * cannot cheaply self-flatter:
 *   - reversibility     : importance < 3 (high-importance = treat as less reversible)
 *   - conflict          : semantic contradiction with an already-confirmed record
 *   - near-duplicate    : high overlap with confirmed = already-known info
 *   - user-anchored     : the write is traceable to a literal user utterance
 *                         (caller passes anchoredToUser=true only when it can
 *                          point at a user message span; the model does not set it)
 *
 * This is a PURE module: no IO, no LLM, no store mutation. It reads a candidate
 * record + the current confirmed set and returns a decision. The store applies
 * it. Direction 3 (background review) and direction 4 (convergence) reuse the
 * same adjudicator so "when is a change safe to auto-apply" lives in ONE place.
 *
 * @module @local/dsh-evolve/adjudicator
 */
import { tokenSetBigram, jaccard } from './search.js';

/** Decision outcomes. `auto` → confirm without human; `pending` → human review. */
export const DECISION_AUTO = 'auto';
export const DECISION_PENDING = 'pending';

/**
 * Default adjudication thresholds. All overridable via plugin config so the
 * whole feature is tunable and — critically — can be turned fully conservative
 * (autoConfirmEnabled:false) to restore v0.3.x "everything pending" behavior.
 */
export const ADJUDICATOR_DEFAULTS = {
  // Master switch. false = never auto-confirm (v0.3.x behavior). Default true
  // so the feature is on, but every auto path is visible + reversible.
  autoConfirmEnabled: true,
  // >= this bigram-Jaccard vs a CONFIRMED record of same kind+scope with OPPOSITE
  // sentiment → treat as conflict → force pending (never auto-overwrite a
  // decision/preference the human already blessed).
  conflictSimilarity: 0.5,
  // >= this overlap with a confirmed record → near-duplicate (already-known);
  // safe to auto-confirm (it adds nothing risky).
  duplicateSimilarity: 0.82,
  // importance strictly below this may auto-confirm; at/above stays pending
  // (high-importance writes are treated as less reversible → human eyes).
  autoMaxImportance: 3,
};

/**
 * Lightweight opposite-sentiment heuristic for conflict detection. Deterministic,
 * language-agnostic-ish (handles common CN/EN negation/preference markers). This
 * is intentionally conservative: it only fires "conflict" when two records are
 * topically similar AND one negates/reverses the other. False negatives (missing
 * a subtle conflict) are acceptable — they just fall through to the normal path;
 * false positives merely force a harmless extra human confirm.
 */
function looksContradictory(a, b) {
  const negs = ['not', "don't", 'do not', 'never', 'no longer', 'stop', 'avoid', "shouldn't",
    '不', '别', '不要', '不再', '停止', '避免', '不用', '改成', '改为', '换成'];
  const has = (s) => negs.some((n) => s.includes(n));
  const an = has(a);
  const bn = has(b);
  // One negates and the other doesn't → likely a reversal of the same topic.
  return an !== bn;
}

/**
 * Decide the fate of a candidate memory write.
 *
 * @param candidate {content, kind, scope, importance, anchoredToUser?}
 *   anchoredToUser: OPTIONAL boolean the CALLER sets (not the model) when the
 *   write is traceable to a literal user utterance this turn.
 * @param confirmedRecords  array of already-confirmed records (the trusted set)
 * @param config            merged ADJUDICATOR_DEFAULTS
 * @returns {decision, reason, signals} — decision is 'auto' | 'pending'
 */
export function adjudicate(candidate, confirmedRecords, config = {}) {
  const cfg = { ...ADJUDICATOR_DEFAULTS, ...config };
  const signals = {
    reversible: null, conflict: false, nearDuplicate: false,
    anchoredToUser: candidate.anchoredToUser === true,
    autoConfirmEnabled: cfg.autoConfirmEnabled !== false,
  };

  // Master switch off → always pending (restores v0.3.x behavior).
  if (cfg.autoConfirmEnabled === false) {
    return { decision: DECISION_PENDING, reason: 'auto-confirm disabled by config', signals };
  }

  const importance = Number(candidate.importance ?? 2);
  signals.reversible = importance < cfg.autoMaxImportance;

  const content = String(candidate.content ?? '').trim();
  if (content === '') {
    return { decision: DECISION_PENDING, reason: 'empty content', signals };
  }
  const incoming = tokenSetBigram(content);

  // Scan confirmed records of the SAME kind+scope for conflict / near-dup.
  let maxOverlap = 0;
  for (const rec of confirmedRecords) {
    if (rec.scope !== candidate.scope || rec.kind !== candidate.kind) continue;
    const sim = jaccard(incoming, tokenSetBigram(String(rec.content ?? '')));
    if (sim > maxOverlap) maxOverlap = sim;
    // Conflict: topically similar to a confirmed record but sentiment-reversed.
    if (sim >= cfg.conflictSimilarity && looksContradictory(content, String(rec.content ?? ''))) {
      signals.conflict = true;
      return {
        decision: DECISION_PENDING,
        reason: `conflicts with confirmed ${rec.kind} (sim ${sim.toFixed(2)}) — human must adjudicate`,
        signals,
      };
    }
  }
  signals.nearDuplicate = maxOverlap >= cfg.duplicateSimilarity;

  // High-importance (less reversible) → always human eyes, even if anchored.
  if (!signals.reversible) {
    return {
      decision: DECISION_PENDING,
      reason: `importance ${importance} >= ${cfg.autoMaxImportance} (treated as less reversible)`,
      signals,
    };
  }

  // Reversible AND (anchored to a literal user utterance OR already-known dup)
  // → safe to auto-confirm. Both signals are caller/store-derived, not model
  // self-report.
  if (signals.anchoredToUser) {
    return { decision: DECISION_AUTO, reason: 'reversible + anchored to a user utterance', signals };
  }
  if (signals.nearDuplicate) {
    return { decision: DECISION_AUTO, reason: `reversible + near-duplicate of confirmed (overlap ${maxOverlap.toFixed(2)})`, signals };
  }

  // Default conservative: reversible but neither anchored nor known → pending.
  // "When unsure, pending" — the plugin's standing rule.
  return { decision: DECISION_PENDING, reason: 'reversible but not anchored/known — defaulting to review', signals };
}
