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
 * @module dsh-evolve/adjudicator
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
  // v0.5.0: superseded by approvalMode (below) but kept for back-compat — a stored
  // autoConfirmEnabled:false still maps to manual via resolveApprovalMode().
  autoConfirmEnabled: true,
  // v0.5.0: ingestion autonomy tier — the product-level "how much can it decide on
  // its own" dial. manual = everything pending (human confirms all); balanced =
  // conservative auto (anchored OR near-duplicate, else pending) — the default;
  // autonomous = auto-confirm any reversible, non-conflicting write (skips the
  // "must be anchored/known" gate) while STILL forcing conflict/high-importance to
  // pending. Never key auto off `kind` (that was the rejected v0.2.1 path).
  approvalMode: 'balanced',
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

/** The only legal ingestion-autonomy tiers. */
export const APPROVAL_MODES = ['manual', 'balanced', 'autonomous'];

/**
 * Resolve the effective approval mode from a (possibly legacy / possibly hostile)
 * config. This is the SINGLE place tier is decided — set-config, adjudicate, and
 * the settings read path all go through it, so an illegal value can never silently
 * mean something different in two places.
 *
 * Precedence (designed so a legacy autoConfirmEnabled:false is never silently
 * upgraded to auto by the new default):
 *   1. explicit manual/autonomous → wins outright (newest intent);
 *   2. legacy autoConfirmEnabled:false → 'manual' (back-compat: "I turned it off");
 *   3. explicit balanced → 'balanced';
 *   4. anything else (absent / illegal like 'yolo') → 'balanced' (safe default).
 *
 * Note step 2 precedes step 3 so that a config carrying BOTH the default
 * approvalMode:'balanced' AND a user's stored autoConfirmEnabled:false still
 * resolves to manual — the explicit "off" wins over the filled-in default.
 */
export function resolveApprovalMode(config = {}) {
  const m = config.approvalMode;
  if (m === 'manual' || m === 'autonomous') return m;
  if (config.autoConfirmEnabled === false) return 'manual';
  if (m === 'balanced') return 'balanced';
  return 'balanced';
}

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
  // Resolve tier from the RAW config, not the defaults-merged cfg: otherwise the
  // default approvalMode:'balanced' would mask a user's legacy autoConfirmEnabled:
  // false (which must still mean manual). resolveApprovalMode only trusts an
  // EXPLICIT approvalMode, else falls back to the legacy flag, else balanced.
  const mode = resolveApprovalMode(config);
  const signals = {
    reversible: null, conflict: false, nearDuplicate: false,
    anchoredToUser: candidate.anchoredToUser === true,
    autoConfirmEnabled: cfg.autoConfirmEnabled !== false,
    approvalMode: mode,
  };

  // manual tier → always pending (also the legacy autoConfirmEnabled:false path,
  // folded in by resolveApprovalMode). Human confirms everything.
  if (mode === 'manual') {
    return { decision: DECISION_PENDING, reason: 'manual approval mode — every write awaits human confirm', signals };
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

  // High-importance (less reversible) → always human eyes, even in autonomous.
  if (!signals.reversible) {
    return {
      decision: DECISION_PENDING,
      reason: `importance ${importance} >= ${cfg.autoMaxImportance} (treated as less reversible)`,
      signals,
    };
  }

  // ── Past this point the write is REVERSIBLE and NON-CONFLICTING ──────────────
  // (conflict already returned pending above; high-importance already returned
  // pending above). This structural position — NOT a redundant `if (conflict)` —
  // is what protects autonomous from auto-confirming a conflict (评审 C2). Any
  // auto decision below is provably on a reversible, scan-passed candidate.

  // autonomous tier → auto-confirm reversible, non-conflicting writes even when
  // NOT anchored/known. This is the "skip the conservative default" tier the user
  // opted into. (Write rate/volume is bounded separately at the review layer —
  // §3.5 reviewMaxAutoPerTurn + budget downgrade; see index.js.)
  if (mode === 'autonomous') {
    return { decision: DECISION_AUTO, reason: 'autonomous mode — reversible + non-conflicting', signals };
  }

  // ── balanced tier (default) ─────────────────────────────────────────────────
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
