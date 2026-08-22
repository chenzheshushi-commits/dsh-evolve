/**
 * Memory domain declaration + governance defaults + skill-crystallization
 * config. Persisted through the harness storage hub (ctx.storageDomain →
 * ctx.storage), so the stock `json` backend keeps everything in plain JSON
 * under $DSH_HOME/storages — human-inspectable, git-friendly, zero deps.
 *
 * Memory schema/kinds/scopes are the Culeot/dsh-memory structure (MIT). The
 * skill-crystallization defaults (SKILL_DEFAULTS) are new to dsh-evolve.
 *
 * Uses schemastery (bundled by DSH) rather than zod, so this plugin has no
 * third-party runtime dependency beyond what the harness already ships.
 *
 * @module dsh-evolve/spec
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import z from '@deepseek-ai/schemastery';

/** Memory kinds: what a record is FOR. Drives recall filters and governance. */
export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'lesson', 'todo', 'note'];
/** Memory scopes: where a record applies. */
export const MEMORY_SCOPES = ['user', 'project'];

export function isValidKind(value) {
  return MEMORY_KINDS.includes(value);
}
export function isValidScope(value) {
  return MEMORY_SCOPES.includes(value);
}

/**
 * One durable memory record. schemastery mirror of Culeot's MemoryRecord.
 * `crystallized` (new): timestamp when this record last contributed to a
 * crystallized skill — prevents re-crystallizing the same evidence.
 */
export const MemoryRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  kind: z.union(MEMORY_KINDS).default('note'),
  tags: z.array(z.string()).default([]),
  scope: z.union(MEMORY_SCOPES).default('project'),
  project: z.string().default(''),
  importance: z.number().default(2),
  createdAt: z.string(),
  updatedAt: z.string(),
  accessedAt: z.string().default(''),
  accessCount: z.number().default(0),
  injectionCount: z.number().default(0),
  // Reinforcement counter (v0.4.1 direction-2 kernel): how many times this
  // understanding has been independently re-observed across turns. Drives
  // "the more the user shows a preference, the more confident we get". Distinct
  // from accessCount (manual recall) / injectionCount (auto-inject) — it counts
  // EVIDENCE of the same understanding recurring, and it MAY raise importance.
  observationCount: z.number().default(1),
  reinforcedAt: z.string().default(''),
  expiresAt: z.string().default(''),
  crystallizedAt: z.string().default(''),
});

/**
 * The storage domain. `version` stamps the medium; bump on schema changes.
 *
 * storage-domain validates each stored record on open via `valueSchema.parse(raw)`
 * (dsh-storage-domain index.js line ~354). schemastery 3.18.x schemas are
 * CALLABLE (`schema(value)` validates + coerces + throws) but expose no `.parse`
 * method, so open() throws "does not match its schema" the moment any record
 * exists — silently bricking the whole plugin. Bridge the two APIs by giving the
 * schema a `.parse` that delegates to calling it. (Empty stores never hit this
 * path, which is why the bug only appears once records accumulate.)
 */
function withParse(schema) {
  if (typeof schema?.parse !== 'function') {
    try {
      Object.defineProperty(schema, 'parse', {
        value: (raw) => schema(raw), configurable: true, enumerable: false, writable: true,
      });
    } catch { /* if non-configurable, leave as-is */ }
  }
  return schema;
}

export const memoryDomain = defineDomain({
  name: 'evolve_memory',
  version: 1,
  tables: {
    records: domainTable(withParse(MemoryRecordSchema)),
  },
});

/** Memory governance limits. */
export const MEMORY_DEFAULTS = {
  maxRecords: 400,
  maxContentChars: 2000,
  mergeSimilarity: 0.7,
  recencyHalfLifeDays: 90,
  recallLimit: 5,
  injectCount: 3,
  injectMaxChars: 1200,

  // ── Tiered adjudication (v0.4.0 direction 1) ────────────────────────────
  // Whether model writes may be AUTO-CONFIRMED (vs always pending). See
  // lib/adjudicator.js. Signals are model-unfalsifiable (reversibility /
  // conflict / near-dup / caller-set user-anchoring) — NEVER the kind field.
  // Set autoConfirmEnabled:false to restore v0.3.x "everything pending".
  autoConfirmEnabled: true,
  conflictSimilarity: 0.5,
  duplicateSimilarity: 0.82,
  autoMaxImportance: 3,

  // ── User-understanding kernel (v0.4.1 direction 2) ──────────────────────
  // Every N independent re-observations of the same near-duplicate memory, its
  // importance rises by 1 (capped 3). This is the "gradually trained from use"
  // core: repeated evidence of the same understanding strengthens it.
  reinforceEvery: 3,

  // ── Memory convergence ─────────────────────────────────────────────────
  // g3 hard char budget over CONFIRMED memory (0 = disabled). When exceeded the
  // store never auto-drops — memory_budget surfaces trim candidates for a human.
  memoryMaxChars: 20000,
  // g4 pre-write quality gate (used by background review to avoid noise):
  minPromoteChars: 8,        // thinner than this = low-signal, review may skip
  maxContentOverlap: 0.6,    // reworded near-dup gate (wider than mergeSimilarity)
  // g5 local→global promotion: project-scope memory reinforced >= this many
  // observations is a candidate to promote to user-scope (global).
  promoteMinObservations: 3,

  // ── Fitness readiness (v0.4.1 direction-4 / triage consumption) ─────────
  // evolve_maintain only surfaces fitness signals once >= this many outcome
  // triples are collected. Below it, "not enough data" is reported explicitly
  // (so "is there enough to run fitness yet" is observable, never silent).
  fitnessMinTurns: 30,
};

/**
 * Skill-crystallization governance (new to dsh-evolve).
 *
 * Crystallization is DETERMINISTIC (no LLM): when enough high-value evidence
 * accumulates under a shared tag, we ask the *current* model (via a queued
 * nudge, reusing the live turn — zero extra API calls) to author a SKILL.md.
 * The written file lands in ~/.dsh/skills/<name>/SKILL.md and is picked up by
 * DSH's own dsh-skill-filesystem watcher (call/manage/hot-reload for free).
 */
export const SKILL_DEFAULTS = {
  // Minimum count of importance>=2 lesson/decision records sharing a tag
  // before we nudge the model to crystallize a skill for that tag.
  crystallizeMinEvidence: 3,
  // Minimum combined importance across the evidence set (3 lessons of imp2 = 6).
  crystallizeMinImportance: 6,
  // Only these kinds are crystallization evidence (procedural knowledge).
  crystallizeKinds: ['lesson', 'decision'],
  // Skills dir DSH's skill-filesystem watches (user-dsh root).
  // Empty => resolved at runtime to <DSH_HOME>/skills.
  skillsDir: '',

  // ── Evolution / refine (v0.2.0) ─────────────────────────────────────────
  // Once a tag is crystallized, if this many NEW (not-yet-folded-in) evidence
  // records accumulate under it, suggest refine_skill (improve in place, bump
  // version) instead of a fresh crystallize. Zero LLM — reuses the live turn.
  refineMinNewEvidence: 2,

  // ── Curator lifecycle (v0.2.0) ──────────────────────────────────────────
  // An active crystallized skill unused for this many days is reported 'stale'.
  curatorStaleDays: 30,
  // A stale skill unused for this many days total may be auto-archive-suggested
  // (moved out of the watched root; reversible). Must be >= curatorStaleDays.
  curatorArchiveDays: 60,
  // If true, the turn/end curator MAY auto-archive skills past curatorArchiveDays
  // (still reversible via restore_skill). Default false = suggest only, human acts.
  curatorAutoArchive: false,
  // Legacy alias kept for back-compat with any external caller.
  curatorIdleDays: 30,

  // ── Retrieval (v0.2.0) ──────────────────────────────────────────────────
  // Enable the FTS5 BM25 index fused with bigram-Jaccard via RRF. If node:sqlite
  // or FTS5 is unavailable, recall silently falls back to bigram-only.
  ftsEnabled: true,

  // ── Tier 1 always-on snapshot (v0.3.0) ──────────────────────────────────
  // Mirror of the always-on snapshot: on each turn/start, inject a small
  // always-present snapshot of the user's durable preferences/facts so they
  // take effect immediately (not after 50 steps of recall). Zero LLM — pure
  // filter + sort + truncate, deduped so an unchanged snapshot isn't re-sent.
  tier1Enabled: true,
  // Char budget for the Tier 1 snapshot. Default 2200 characters.
  tier1MaxChars: 2200,
  // Only these kinds + this scope + min importance qualify for Tier 1.
  tier1Kinds: ['preference', 'fact'],
  tier1Scope: 'user',
  tier1MinImportance: 2,

  // ── LLM refinement pass (v0.3.0, opt-in, model-follows-main) ─────────────
  // When true, crystallize_skill / refine_skill route the raw evidence through
  // ONE auxiliary ctx.llm.stream() call to distill it into a structured SKILL.md
  // body (dedupe, group, write as steps/pitfalls) — closing the quality gap to
  // the reference design skills. When false (or the LLM call fails/unavailable), falls back to
  // the deterministic string assembly (zero token). Efficiency-consistent with
  // the reference design: single call, on-demand (only at crystallize/refine, maybe 0×/session),
  // reuses the provider's warm prefix cache, never in a per-step/per-turn path.
  refineLLM: true,
  // Model for the refine pass. Empty string => FOLLOW DSH's current main model
  // (agent.session.requestHeader().config), auto-tracking main-model changes.
  // A visual settings dropdown lets the user pick another configured model.
  refineProvider: '',
  refineModel: '',
  // Max tokens for the single refine call (bounds the auxiliary cost).
  refineMaxTokens: 4000,

  // ── Outcome triage (v0.3.0, option B, zero-token) ───────────────────────
  // Record (skillsLoaded, errors, success) tuples per turn into a sidecar JSONL
  // — raw fuel for a FUTURE fitness/GEPA step. Pure data recorder: no LLM, no
  // main-path injection, reuses existing tool/call + agent/error + turn/end
  // signals (no new hook). Records only turns that load an evolve skill or error.
  triageEnabled: true,

  // ── Background review (v0.4.0 direction 3) ──────────────────────────────
  // After every turn (throttled), an ISOLATED LLM pass replays the turn's
  // conversation snapshot and proposes durable memories, routed through the
  // tiered adjudicator (auto/pending). NEVER touches the main prompt cache.
  // Set reviewEnabled:false to fully disable (no snapshot collection, no call).
  reviewEnabled: true,
  // Run the review at most once every N turns (turn-count stamp, NOT a timer —
  // honors the edge-plugin "no setInterval" rule). 
  reviewEveryTurns: 5,
  // Model for the review pass. Empty => FOLLOW the current main model (same
  // precedence as refineProvider/refineModel). A stronger model can be pinned
  // here so weak main models don't limit review quality (model-agnostic rule).
  reviewProvider: '',
  reviewModel: '',
  // Bounds the single review call's output + the snapshot it reads.
  reviewMaxTokens: 1200,
  reviewMaxSnapshotChars: 12000,

  // ── Convergence / anti-bloat (v0.4.0 direction 4) ───────────────────────
  // Detect near-duplicate skills to merge + refinement-bloated skills to fold.
  // DETECTION (turn/end nudge) is on by default; the MERGE/FOLD actions are
  // separate opt-in tools (converge_skill/fold_skill), never auto-run — mirrors
  // a detection-on / mutation-opt-in stance. Set convergeSuggest:false to
  // silence the nudge.
  convergeSuggest: true,
  // Bigram-Jaccard similarity >= this flags two skills as merge candidates.
  convergeMergeSimilarity: 0.55,
  // A skill with >= this many appended "## Refinement vN" sections is flagged
  // as bloated (fold candidate).
  convergeMaxRefinements: 4,
};

export function clampImportance(value) {
  const n = Math.round(Number(value ?? 2));
  return Math.min(3, Math.max(1, Number.isFinite(n) ? n : 2));
}
