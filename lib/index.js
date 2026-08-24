/**
 * dsh-evolve — self-evolving memory + skill crystallization for DSH.
 *
 * v0.2.0 closes the three gaps identified in the first release:
 *   1. CURATOR is now a real lifecycle state machine (active→stale→archived)
 *      with reversible archive (moves skills out of the watched root so the
 *      catalog shrinks) + restore + a lifecycle report — not report-only.
 *   2. EVOLUTION is real: refine_skill improves an existing SKILL.md in place
 *      (append versioned refinement, bump semver, changelog) preserving human
 *      edits — not overwrite-only. Zero LLM (reuses the live turn).
 *   3. RETRIEVAL fuses bigram-Jaccard with an FTS5 BM25 index via RRF (better
 *      on long / ASCII-heavy / fuzzy queries) while keeping precise short-CJK
 *      recall — not a lossy replacement, no vectors, no embeddings.
 *
 * Contracts honored (unchanged):
 *   - Zero LLM calls from the plugin (recall/scoring/fusion are pure math;
 *     authoring/refining reuse the live turn via a queued nudge).
 *   - Never writes custom session-log events (immune to SessionFormatUnsupportedError).
 *   - apply() never throws into boot; hooks never break the agent loop.
 *
 * @module dsh-evolve
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  memoryDomain, MEMORY_DEFAULTS, SKILL_DEFAULTS, MEMORY_KINDS, MEMORY_SCOPES,
} from './spec.js';
import { MemoryStore } from './store.js';
import { hasMeaningfulQuery } from './search.js';
import { createFtsIndex } from './fts.js';
import {
  proposeSkillName, findSkillByTag,
  writeCrystallizedSkill, refineCrystallizedSkill, foldSkillBody,
  archiveSkill, restoreSkill, listSkillStates, countCrystallizedSkills, noteSkillUse,
  restoreFromBackup, backupSkill,
} from './skills.js';
import { refineWithLLM } from './llm-refine.js';
import { runReview, TurnSnapshotCollector } from './review.js';
import { convergenceReport, findMergeCandidates, readEvolveSkills, readEvolveSkill, buildMergeInput, bodyBeforeRefinements } from './converge.js';
import { setStyle, getStyle, clearStyle, listStyled, deriveStyleFromProfile } from './style.js';
import { OutcomeTriage, triageSidecarPath } from './triage.js';
import { makeEvolveRoutes } from './web-routes.js';
import { authorizePruneAction } from './prune-authz.js';
import { memoryHeat, skillHeat } from './heat.js';
import { buildPlan, PlanRegistry, applyPlan, memoryEtag, skillEtag, appendAudit } from './prune-plan.js';
import { createIdleTrigger } from './idle-trigger.js';
import z from '@deepseek-ai/schemastery';

/** schemastery schema for the web-editable settings section (v0.3.0). */
const zEvolveSettings = z.object({
  refineLLM: z.boolean().default(true),
  refineProvider: z.string().default(''),
  refineModel: z.string().default(''),
  tier1Enabled: z.boolean().default(true),
});

export const name = 'dsh-evolve';
// 'llm' is required for the opt-in LLM refine pass + model enumeration. cordis 4.x
// forbids ctx.get('llm') unless declared here (throws "cannot get property without
// inject"). Both web and headless profiles provide the llm service (verified), so
// injecting it does not block headless boot.
export const inject = ['tools', 'storageDomain', 'systemPrompt', 'llm'];

function resolveDshHome() {
  const raw = process.env.DSH_HOME;
  if (raw && raw.trim() !== '') {
    const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(homedir(), '.dsh');
}

function queryFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
    if (text) return text;
  }
  return '';
}

function renderInjection(hits, maxChars) {
  const lines = ['相关记忆（context, 不是用户在说话）:'];
  for (const { record } of hits) {
    lines.push(`- [${record.kind}/imp${record.importance}] ${record.content.replace(/\n/g, ' ')}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return text;
}

function errorFingerprint(error) {
  if (!error) return '';
  const code = error.code ?? error.name ?? '';
  const msg = String(error.message ?? error).slice(0, 120);
  return `${code}:${msg}`.trim();
}

const jsonOutput = () => ({
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** DSH UI display card for a tool call (title + kind hint). */
const present = (title, kind, rawInput) => ({
  card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }),
});

const PROTOCOL_SECTION = `## Self-evolving memory + skills (dsh-evolve)

You have cross-session long-term memory; relevant memories auto-inject each step
based on the user's current message (look for a "相关记忆" block — it is context,
not the user speaking). Procedural knowledge can crystallize into reusable skills,
and those skills IMPROVE over time (refine) and are curated (archived when stale).

Memory rules:
- At task START, memory_recall with keywords before diving in; memory_index for the big picture.
- DURING work, memory_remember anything needed in LATER sessions: facts, preferences,
  decisions+rationale, lessons ("never do X again"), cross-session todos. Quality over noise.
- TIERED review (not everything needs human confirm): the write goes through a deterministic
  gate. Obvious, reversible, USER-ANCHORED writes may AUTO-confirm; anything risky/uncertain
  (high-importance, conflicting, or your own inference) stays PENDING for human review.
- **Set anchoredToUser:true when the memory is directly traceable to something the USER said
  this turn** (their explicit statement / correction / stated preference) — NOT your own
  conclusion. This is how obvious user-stated facts skip the review queue. Honest use reduces
  the human's confirm burden; never set it true to sneak your own inferences past review.
- Pending memories are searchable but NOT auto-injected — the human owns what becomes always-on.
  Auto-confirmed ones are visible + revocable via memory_auto_review.
- When the user corrects you, or the same mistake recurs, memory_remember it as
  kind=lesson, importance=3.
- Write lessons DIALECTICALLY, never absolute: (1) what went wrong + how to avoid; (2) the
  CONDITIONS that caused it (would it work under different conditions? note the boundary);
  (3) what actually worked — keep the salvageable part. Prefer "under condition A, X failed
  because B; the C part worked" over "X is impossible".
- kind: fact / preference / decision / lesson / todo / note. importance: 1 nice / 2 useful /
  3 critical (eviction-proof). scope: user (everywhere) or project (this project).
- Re-observing the SAME understanding reinforces it (observationCount rises, importance may
  rise) — so DO record a recurring user preference again; the system strengthens it, it won't
  just duplicate.

Skill lifecycle (crystallize → refine → curate):
- CRYSTALLIZE (crystallize_skill): when several high-value lessons/decisions share a tag and
  NO skill exists for it yet, author a new SKILL.md. Only for genuinely reusable procedures.
- REFINE (refine_skill): when a tag ALREADY has a crystallized skill and new evidence
  accumulated, improve it IN PLACE — a new versioned "Refinement" section is appended, the
  version bumps, your prose edits are preserved. Prefer refine over re-crystallizing.
- CURATE (skill_curator / archive_skill / restore_skill / skill_rollback): the system reports
  active/stale/archived skills. Archiving moves a stale skill out of the active catalog (reversible
  via restore_skill); it NEVER deletes. A tar.gz backup is taken before every archive/refine, so
  skill_rollback can undo a bad refine or accidental archive. Suggest archiving only truly obsolete skills.
- Skills are loaded/managed by the harness's own skill system — treat crystallized/refined
  ones as normal skills afterward.
- The LLM refinement pass (settings: dsh-evolve) is OPTIONAL. When ON, crystallize/refine route the
  raw evidence through one auxiliary model call (follows the current main model unless overridden in
  settings) to produce a structured SKILL.md. When OFF, they use deterministic assembly (zero tokens).

Tier 1 always-on snapshot: durable user preferences/facts (kind=preference/fact, scope=user,
importance>=2) are injected at the START of every turn (look for a 【dsh-evolve】用户长期偏好/事实
block) so they take effect immediately — the always-on snapshot. Keep these few and high-signal.

Approval gate: model writes are pending; a human confirms via memory_confirm (one) or
memory_confirm_batch (many / all pending). memory_stats.pendingQueue is the review list.

Observability (read-only): memory_stats shows totals, kind/scope breakdown, the pending-confirm
queue (memories awaiting human approval), and which memories are most accessed (manual recall)
vs most injected (auto-fed into context — the real decision-influence signal). skill_stats shows
the crystallized-skill lifecycle counts. Use them to review what the memory/skill system is doing.`;

/** Plugin entry. Never throws — memory/skill plugin must not brick the harness. */
export async function apply(ctx, config = {}) {
  const cfg = { ...MEMORY_DEFAULTS, ...SKILL_DEFAULTS, ...config };
  const dshHome = resolveDshHome();
  try {
    return await _applyInner(ctx, cfg, dshHome);
  } catch (e) {
    // The host plugin loader swallows apply() throws and the plugin's own logger
    // is filtered, so a failure here would brick memory+skills SILENTLY. Persist
    // the stack to the workspace so the cause is always inspectable post-mortem.
    const detail = String(e?.stack ?? e?.message ?? e);
    try { writeFileSync(join(dshHome, 'evolve-workspace', 'last-apply-error.log'), `${new Date().toISOString()}\n${detail}\n`); } catch { /* ignore */ }
    ctx.logger?.warn?.(`[dsh-evolve] apply failed (memory/skills disabled): ${e?.message ?? e}`);
  }
}

async function _applyInner(ctx, cfg, dshHome) {
  const workspaceDir = join(dshHome, 'evolve-workspace');
  const skillsDir = cfg.skillsDir && cfg.skillsDir.trim() !== '' ? cfg.skillsDir : join(dshHome, 'skills');
  // Archive lives OUTSIDE the DSH-watched skills root, so archived skills stop
  // being discovered by skill-filesystem (the catalog shrinks). Reversible.
  const archiveDir = join(workspaceDir, 'archived-skills');

  // Scaffold workspace + git (best-effort; memory still works without git).
  try {
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    if (!existsSync(join(workspaceDir, '.git'))) {
      try { execFileSync('git', ['init', '-q'], { cwd: workspaceDir, stdio: 'ignore' }); } catch { /* git optional */ }
    }
  } catch (e) {
    ctx.logger?.warn?.(`[dsh-evolve] scaffold failed (continuing): ${e?.message ?? e}`);
  }

  // Open the memory storage domain (reuse if already open).
  let domain;
  try {
    const existing = ctx.storageDomain.get(memoryDomain.name);
    domain = existing ?? await ctx.storageDomain.open(memoryDomain);
    if (!existing) ctx.effect(() => () => { void domain.close?.(); });
  } catch (e) {
    // Domain open can fail on stored-record schema drift; this disables memory
    // silently (host logger is filtered), so persist the cause to the workspace.
    const detail = String(e?.stack ?? e?.message ?? e);
    try { writeFileSync(join(dshHome, 'evolve-workspace', 'last-apply-error.log'), `${new Date().toISOString()} storage domain open failed\n${detail}\n`); } catch { /* ignore */ }
    ctx.logger?.warn?.(`[dsh-evolve] storage domain open failed (memory disabled): ${e?.message ?? e}`);
    return;
  }
  const table = domain.table('records');

  // Derived FTS5 index (NullFts if unavailable). Backfilled inside the store ctor.
  const fts = await createFtsIndex(ctx.logger ?? undefined, cfg.ftsEnabled !== false);
  if (fts?.available && typeof fts.close === 'function') ctx.effect(() => () => { fts.close(); });

  // Surface background git checkpoints as a visible one-liner on the next step.
  let checkpointPending = false;
  const store = new MemoryStore(table, {
    workspaceDir, config: cfg, logger: ctx.logger ?? undefined, fts,
    onCommit: () => { checkpointPending = true; },
  });
  // Flush any pending injection counters on dispose (last chance before the
  // domain closes) — the "ride on real writes" path handles the common case.
  ctx.effect(() => () => { void store.flushInjections?.(); });

  // Outcome triage (option B): zero-token per-turn (skillsLoaded, errors, success)
  // recorder for future fitness/GEPA fuel. Reuses existing hooks; records only.
  const triage = cfg.triageEnabled === false ? null : new OutcomeTriage(triageSidecarPath(workspaceDir), ctx.logger ?? undefined);

  // Background review (v0.4.0 direction 3): per-turn snapshot collector +
  // throttle state. Collector accumulates this turn's conversation text in
  // memory (never injected); turn/end runs an isolated LLM review at most every
  // reviewEveryTurns turns. Null when disabled (reviewEnabled:false) → the whole
  // feature is inert (no collection, no review), restoring pre-0.4.0 behavior.
  const reviewCollector = cfg.reviewEnabled === false ? null
    : new TurnSnapshotCollector({ maxChars: cfg.reviewMaxSnapshotChars ?? 12000 });
  let lastReviewedTurn = 0;
  // Skill style overlays (v0.4.0 direction 2B) pending injection: when the model
  // loads one of our skills that has a style overlay attached, we queue the
  // overlay text here and inject it on the next pre-step (so the skill's output
  // adopts the user's style). Deduped per skill name within a session.
  const pendingStyleOverlays = new Map(); // skillName -> overlay text
  const injectedStyleFor = new Set();

  // ── System-prompt protocol section ─────────────────────────────────────
  ctx.systemPrompt.section({ name: 'evolve-protocol', order: 110, text: PROTOCOL_SECTION });

  // ── Model tools: memory ────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Save a cross-session memory. Model writes are reviewed by a deterministic gate: obvious, reversible, user-anchored writes may be auto-confirmed; anything risky/uncertain stays pending for human review. kind: fact/preference/decision/lesson/todo/note; importance 1-3; scope user/project; tags: short lowercase words.',
    parameters: {
      content: { type: 'string', required: true, description: 'The memory content (plaintext, <=2000 chars).' },
      kind: { type: 'string', description: `One of: ${MEMORY_KINDS.join(', ')}.` },
      importance: { type: 'number', description: '1 nice-to-know, 2 useful, 3 critical (eviction-proof).' },
      scope: { type: 'string', description: `One of: ${MEMORY_SCOPES.join(', ')}.` },
      tags: { type: 'array', items: { type: 'string' }, description: 'Short lowercase anchor words for recall + crystallization.' },
      anchoredToUser: { type: 'boolean', description: 'Set true ONLY when this memory is directly traceable to something the USER said this turn (their explicit statement/correction/preference) — NOT your own inference. Honest use lets obvious user-stated facts auto-confirm; misuse just wastes a review. Never set true to bypass review of your own conclusions.' },
    },
    output: jsonOutput(),
    async execute(args) {
      const rec = await store.remember({
        content: args.content, kind: args.kind, importance: args.importance,
        scope: args.scope, tags: args.tags, anchoredToUser: args.anchoredToUser === true,
      });
      if (!rec) return { saved: false };
      const isPending = Array.isArray(rec.tags) && rec.tags.includes('pending');
      const isAuto = Array.isArray(rec.tags) && rec.tags.includes('auto-confirmed');
      const status = isPending ? 'pending' : (isAuto ? 'auto-confirmed' : 'confirmed');
      const note = isPending
        ? `已存记忆(待人工确认): ${rec.kind}/imp${rec.importance} — ${rec.content.slice(0, 40)}`
        : `已存记忆(${isAuto ? '自动确认·可在 memory_auto_review 撤销' : '已确认'}): ${rec.kind}/imp${rec.importance} — ${rec.content.slice(0, 40)}`;
      return { saved: true, status, note, record: rec };
    },
    presentCall: (args) => present('💾 存记忆', 'other', args.content),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Recall stored memories by keyword (deterministic bigram + BM25 fusion; a miss means nothing matched). Includes pending memories so you can evaluate them.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword query.' },
      limit: { type: 'number', description: 'Max results (default 5).' },
    },
    output: jsonOutput(),
    async execute(args) {
      const hits = await store.recall(args.query, args.limit, { touch: true, includePending: true });
      return hits.map((h) => ({ ...h.record, score: Number(h.score.toFixed(4)) }));
    },
    presentCall: (args) => present('🔎 检索记忆', 'search', args.query),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_index',
    description: 'List stored memories (optionally filtered) to see the big picture. Every memory is plaintext and inspectable.',
    parameters: {
      kind: { type: 'string', description: `Filter by kind: ${MEMORY_KINDS.join(', ')}.` },
      scope: { type: 'string', description: `Filter by scope: ${MEMORY_SCOPES.join(', ')}.` },
      pending: { type: 'boolean', description: 'true = only unconfirmed, false = only confirmed.' },
    },
    output: jsonOutput(),
    async execute(args) {
      return store.list({ kind: args.kind, scope: args.scope, pending: args.pending });
    },
    presentCall: () => present('📇 记忆索引', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_confirm',
    description: 'Human-owned: confirm a pending memory so it becomes eligible for auto-injection. Only call when the user explicitly asks to confirm/approve a memory; never self-promote.',
    parameters: { id: { type: 'string', required: true, description: 'Memory id from memory_index/memory_recall.' } },
    output: jsonOutput(),
    async execute(args) { return (await store.confirm(args.id)) ?? { confirmed: false }; },
    presentCall: (args) => present('✅ 确认记忆(人工授权)', 'other', args.id),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_auto_review',
    description: 'Review and undo AUTO-CONFIRMED memories (the ones the tiered gate let through without asking). action=list shows recently auto-confirmed records; action=revoke sends one back to pending (or drop=true deletes it). This is the human override that makes auto-confirm safe — every auto write stays visible and reversible here.',
    parameters: {
      action: { type: 'string', description: 'list (default) or revoke.' },
      id: { type: 'string', description: 'Memory id to revoke (required when action=revoke).' },
      drop: { type: 'boolean', description: 'When revoking: true deletes the record; false (default) sends it back to pending for review.' },
    },
    output: jsonOutput(),
    async execute(args) {
      if (args.action === 'revoke') {
        if (!args.id) return { error: 'id required for revoke' };
        return store.revokeAutoConfirm(args.id, { drop: args.drop === true });
      }
      const items = store.listAutoConfirmed();
      return { count: items.length, autoConfirmed: items };
    },
    presentCall: (args) => present(args.action === 'revoke' ? '↩️ 撤销自动确认' : '📋 自动确认审阅', 'other', args.id ?? ''),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_profile',
    description: 'Show the agent\'s evolving understanding of WHO this user is — the auto-grown user profile (confirmed scope=user preferences/facts, grouped by kind). This is the "auto USER.md": background review proposes these from what the user says, the tiered gate confirms them, and they inject on every turn. Read-only; use it to see what the agent has learned about the user.',
    parameters: {},
    output: jsonOutput(),
    async execute() { return store.profileView(); },
    presentCall: () => present('👤 用户画像（系统对你的理解）', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_budget',
    description: 'Show the memory char-budget status (v0.4.0 anti-bloat): total confirmed-memory chars vs the cap, and — when over budget — the lowest-value/least-reinforced/oldest trim candidates to merge or forget. Never auto-drops; this is the "over-limit returns a list" surface . Read-only.',
    parameters: {},
    output: jsonOutput(),
    async execute() { return store.memoryBudgetStatus(); },
    presentCall: () => present('📏 记忆字符预算', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_promote',
    description: 'Local→global memory promotion (v0.4.0): action=list shows project-scope memories reinforced enough to promote to user-scope (global); action=promote moves one to user scope. Promoting makes a well-established project insight apply everywhere. Reversible by re-scoping.',
    parameters: {
      action: { type: 'string', description: 'list (default) | promote.' },
      id: { type: 'string', description: 'Memory id to promote (required for promote).' },
    },
    output: jsonOutput(),
    async execute(args) {
      if (args.action === 'promote') {
        if (!args.id) return { error: 'id required for promote' };
        return store.promoteToGlobal(args.id);
      }
      const candidates = store.promotionCandidates();
      return { count: candidates.length, candidates };
    },
    presentCall: (args) => present(args.action === 'promote' ? '⬆️ 记忆升级为全局' : '📋 全局升级候选', 'other', args.id ?? ''),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one memory by id. importance-3 memories require confirm=true.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id.' },
      confirm: { type: 'boolean', description: 'Required true to delete an importance-3 memory.' },
    },
    output: jsonOutput(),
    async execute(args) { return store.forget(args.id, args.confirm); },
    presentCall: (args) => present('🗑️ 删除记忆', 'other', args.id),
  }));

  // ── Model tools: skill crystallize / refine ────────────────────────────
  // Locate an existing evolve-owned skill BY TAG via its state block — never by
  // recomputing a name from the tag (names may be LLM-authored/readable now).
  const skillDirForTag = (tag) => findSkillByTag(skillsDir, tag);
  const skillExists = (tag) => skillDirForTag(tag) !== null;

  /** Confirmed, non-crystallized procedural evidence for a tag (any amount). */
  const freshEvidence = (tag) => store.list({ pending: false })
    .filter((r) => r.tags.includes(tag) && cfg.crystallizeKinds.includes(r.kind) && !r.crystallizedAt);

  ctx.tools.register(defineTool({
    name: 'crystallize_skill',
    description: 'Author a NEW reusable SKILL.md from accumulated lesson/decision memories sharing a tag (written to the harness skills dir, hot-loaded). If a skill for this tag already exists, use refine_skill instead.',
    parameters: {
      tag: { type: 'string', required: true, description: 'The memory tag whose lessons/decisions to crystallize.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const existing = skillDirForTag(args.tag);
      if (existing) {
        return { crystallized: false, reason: `skill "${existing}" already exists for tag "${args.tag}"; use refine_skill to improve it in place` };
      }
      const records = freshEvidence(args.tag);
      if (records.length === 0) {
        return { crystallized: false, reason: `no fresh confirmed lesson/decision memories tagged "${args.tag}" (already crystallized or none confirmed)` };
      }
      // Opt-in LLM distillation (model follows main; falls back to deterministic on any failure).
      // Returns {name?, description?, body} or null.
      const rawText = records.map((r) => `- [${r.kind}/imp${r.importance}] ${r.content}`).join('\n');
      const distilled = await refineWithLLM(ctx, exec, { rawText, kind: 'crystallize', tag: args.tag, cfg, logger: ctx.logger });
      // Readable name: LLM-proposed (sanitized) > readable tag skeleton > skill-<hash>,
      // deduped against existing dirs. Hash only as a last-resort collision breaker.
      const skillName = proposeSkillName(skillsDir, args.tag, distilled?.name);
      const res = writeCrystallizedSkill(
        skillsDir, skillName, args.tag, records, ctx.logger ?? undefined,
        distilled?.body, distilled?.description,
      );
      if (!res) return { crystallized: false, reason: 'write skipped (name owned by a non-evolve skill) or failed' };
      await store.markCrystallized(records.map((r) => r.id));
      return {
        crystallized: true, skill: res.name, version: res.version, path: res.path, fromRecords: records.length,
        llmDistilled: Boolean(distilled),
        note: `🧬 已把 ${records.length} 条"${args.tag}"经验结晶为 skill「${res.name}」v${res.version}${distilled ? '（LLM 精炼）' : '（确定性拼接）'}，写入 ${res.path}，DSH 将自动热加载`,
      };
    },
    presentCall: (args) => present(`🧬 结晶 skill: ${args.tag}`, 'create', args.tag),
  }));

  ctx.tools.register(defineTool({
    name: 'refine_skill',
    description: 'IMPROVE an existing crystallized skill in place with newly-accumulated evidence for its tag: appends a versioned "Refinement" section, bumps the version, updates the changelog — WITHOUT overwriting human edits. Zero extra LLM. Use this instead of re-crystallizing when the skill already exists.',
    parameters: {
      tag: { type: 'string', required: true, description: 'The memory tag whose skill to refine (must already be crystallized).' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const skillName = skillDirForTag(args.tag);
      if (!skillName) {
        return { refined: false, reason: `no skill for tag "${args.tag}" yet; use crystallize_skill first` };
      }
      const records = freshEvidence(args.tag);
      if (records.length === 0) {
        return { refined: false, reason: `no new confirmed lesson/decision memories tagged "${args.tag}" to fold in` };
      }
      // tar.gz safety net before mutating the skill (pre-run backup, enables rollback).
      try { backupSkill(skillsDir, archiveDir, skillName, 'refine'); } catch { /* best-effort */ }
      // Opt-in LLM distillation of the new evidence (model follows main; graceful fallback).
      const rawText = records.map((r) => `- [${r.kind}/imp${r.importance}] ${r.content}`).join('\n');
      const distilled = await refineWithLLM(ctx, exec, { rawText, kind: 'refine', tag: args.tag, cfg, logger: ctx.logger });
      const res = refineCrystallizedSkill(skillsDir, skillName, args.tag, records, ctx.logger ?? undefined, distilled?.body);
      if (!res) return { refined: false, reason: 'refine failed (I/O)' };
      if (res.refined === false) return res;
      await store.markCrystallized(records.map((r) => r.id));
      return {
        refined: true, skill: res.name, version: res.version, path: res.path, added: res.added,
        llmDistilled: Boolean(distilled),
        note: `🧬 已用 ${res.added} 条新"${args.tag}"经验精炼 skill「${res.name}」→ v${res.version}${distilled ? '（LLM 精炼）' : ''}（追加 Refinement 段，保留人工编辑）`,
      };
    },
    presentCall: (args) => present(`🧬 精炼 skill: ${args.tag}`, 'edit', args.tag),
  }));

  // ── Model tools: curator lifecycle ─────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'skill_curator',
    description: 'Lifecycle report for crystallized skills: active / stale (idle >= staleDays) / archived, with versions + idle age. Never mutates; use to decide what to archive or refine.',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      const states = listSkillStates(skillsDir, archiveDir, { staleDays: cfg.curatorStaleDays });
      return {
        ...states,
        crystallizedActive: countCrystallizedSkills(skillsDir),
        archiveDays: cfg.curatorArchiveDays,
        autoArchive: cfg.curatorAutoArchive === true,
      };
    },
    presentCall: () => present('🧹 skill 生命周期报告', 'read'),
  }));

  // ── Model tools: observability (v0.2.1) ────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: 'Current-snapshot memory statistics: totals, by-kind/scope breakdown, pending-confirm queue, and the memories most accessed (manual recall) and most injected (auto-fed into context — the real decision-influence signal). No time-window data (this plugin keeps no event log by design).',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      return store.stats({ topN: 5 });
    },
    presentCall: () => present('📊 记忆统计', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'skill_stats',
    description: 'Current-snapshot crystallized-skill statistics: active/stale/archived counts, per-skill version + refinement count + idle age, plus zero-token outcome triage (per-skill load/success/error counts recorded across turns). Read-only; never mutates.',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      const states = listSkillStates(skillsDir, archiveDir, { staleDays: cfg.curatorStaleDays });
      return {
        counts: states.counts,
        staleDays: cfg.curatorStaleDays,
        archiveDays: cfg.curatorArchiveDays,
        autoArchive: cfg.curatorAutoArchive === true,
        active: states.active,
        stale: states.stale,
        archived: states.archived,
        triage: triage ? triage.summary() : { disabled: true },
      };
    },
    presentCall: () => present('📊 skill 统计', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'archive_skill',
    description: 'Archive a stale/obsolete crystallized skill: move it OUT of the active skills dir into the evolve archive so it stops appearing in the skill catalog. REVERSIBLE (restore_skill) and never deletes. Only archives evolve-owned skills.',
    parameters: { name: { type: 'string', required: true, description: 'The crystallized skill name (from skill_curator).' } },
    output: jsonOutput(),
    async execute(args) {
      const res = archiveSkill(skillsDir, archiveDir, args.name, ctx.logger ?? undefined);
      if (res.archived) res.note = `📦 已归档 skill「${res.name}」→ ${res.to}（移出活动目录，可 restore_skill 恢复；未删除）`;
      return res;
    },
    presentCall: (args) => present(`📦 归档 skill: ${args.name}`, 'other', args.name),
  }));

  ctx.tools.register(defineTool({
    name: 'restore_skill',
    description: 'Restore a previously archived crystallized skill back into the active skills dir (re-discovered by the harness).',
    parameters: { name: { type: 'string', required: true, description: 'The archived skill name (from skill_curator).' } },
    output: jsonOutput(),
    async execute(args) {
      const res = restoreSkill(skillsDir, archiveDir, args.name, ctx.logger ?? undefined);
      if (res.restored) res.note = `♻️ 已恢复 skill「${res.name}」→ ${res.to}（重新进入活动目录）`;
      return res;
    },
    presentCall: (args) => present(`♻️ 恢复 skill: ${args.name}`, 'other', args.name),
  }));

  ctx.tools.register(defineTool({
    name: 'skill_rollback',
    description: 'Restore a crystallized skill from its most-recent tar.gz backup (taken automatically before each archive/refine). Use to undo a bad refine or an accidental archive when a plain restore is not enough.',
    parameters: { name: { type: 'string', required: true, description: 'The crystallized skill name to roll back.' } },
    output: jsonOutput(),
    async execute(args) {
      const res = restoreFromBackup(skillsDir, archiveDir, args.name, ctx.logger ?? undefined);
      if (res.restored) res.note = `⏮️ 已从备份回滚 skill「${res.name}」（来源 ${res.from}）`;
      return res;
    },
    presentCall: (args) => present(`⏮️ 回滚 skill: ${args.name}`, 'other', args.name),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_confirm_batch',
    description: 'Confirm MULTIPLE pending memories at once (the human-approval convenience entry). Pass explicit ids, or omit ids to confirm the whole pending queue. Only a human should invoke this — it is the approval gate.',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Memory ids to confirm. Omit to confirm ALL pending memories.' },
    },
    output: jsonOutput(),
    async execute(args) {
      const pending = store.list({ pending: true });
      const targetIds = Array.isArray(args.ids) && args.ids.length > 0
        ? args.ids
        : pending.map((r) => r.id);
      const confirmed = [];
      for (const id of targetIds) {
        try { const r = await store.confirm(id); if (r) confirmed.push(id); } catch { /* skip */ }
      }
      return {
        confirmed: confirmed.length, ids: confirmed,
        remainingPending: store.list({ pending: true }).length,
        note: `✅ 已批量确认 ${confirmed.length} 条 pending 记忆`,
      };
    },
    presentCall: (args) => present(`✅ 批量确认记忆${Array.isArray(args.ids) && args.ids.length ? `（${args.ids.length}）` : '（全部）'}`, 'other'),
  }));

  // ── Convergence tools (v0.4.0 direction 4): merge + fold (anti-bloat) ────
  ctx.tools.register(defineTool({
    name: 'converge_skill',
    description: 'CONVERGE two or more near-duplicate crystallized skills into ONE umbrella skill (anti-bloat). Reads their bodies, distills a merged skill (LLM if enabled, else concatenated), writes the new skill, and ARCHIVES the originals (reversible via restore_skill — never deleted). Use when converge suggestions flag high-overlap skills. Only merges evolve-owned skills.',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, required: true, description: 'The 2+ existing skill directory names to merge.' },
      into: { type: 'string', description: 'Optional name/tag for the merged umbrella skill (defaults to a combined tag).' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const names = Array.isArray(args.names) ? args.names.filter((n) => typeof n === 'string') : [];
      if (names.length < 2) return { merged: false, reason: 'need at least 2 skill names to merge' };
      const skills = names.map((n) => readEvolveSkill(skillsDir, n)).filter(Boolean);
      if (skills.length < 2) return { merged: false, reason: 'fewer than 2 of the named skills are evolve-owned/readable; refusing (never touch human skills)' };
      const bodies = skills.map((s) => ({ name: s.name, body: bodyBeforeRefinements(s.md) ?? s.md }));
      const mergeInput = buildMergeInput(bodies);
      const mergedTag = args.into || `merged-${skills.map((s) => s.state?.tag ?? s.name).join('-')}`.slice(0, 60);
      // Opt-in LLM distillation of the umbrella body; deterministic fallback = concat.
      const distilled = await refineWithLLM(ctx, exec, { rawText: mergeInput, kind: 'crystallize', tag: mergedTag, cfg, logger: ctx.logger });
      const body = distilled?.body ?? mergeInput;
      const skillName = proposeSkillName(skillsDir, mergedTag, distilled?.name);
      // Synthesize an evidence record so provenance/state block are well-formed.
      const evidence = [{ id: `merge_${Date.now().toString(36)}`, kind: 'decision', importance: 2, content: `Merged from: ${names.join(', ')}`, tags: [mergedTag] }];
      const res = writeCrystallizedSkill(skillsDir, skillName, mergedTag, evidence, ctx.logger ?? undefined, body, distilled?.description);
      if (!res) return { merged: false, reason: 'write of umbrella skill failed (name owned by non-evolve skill?)' };
      // Archive the originals (reversible; never delete).
      const archived = [];
      for (const s of skills) {
        const r = archiveSkill(skillsDir, archiveDir, s.name, ctx.logger ?? undefined);
        if (r.archived) archived.push(s.name);
      }
      return {
        merged: true, umbrella: res.name, path: res.path, archivedOriginals: archived,
        llmDistilled: Boolean(distilled),
        note: `🧭 已合并 ${skills.length} 个 skill 为「${res.name}」${distilled ? '（LLM 揉合）' : '（确定性拼接）'}，原 skill 已归档(可 restore_skill 恢复，未删除)：${archived.join('、')}`,
      };
    },
    presentCall: (args) => present(`🧭 合并 skill: ${Array.isArray(args.names) ? args.names.join('+') : ''}`, 'create'),
  }));

  ctx.tools.register(defineTool({
    name: 'fold_skill',
    description: 'FOLD a refinement-bloated skill\'s appended "## Refinement vN" sections back into one clean body (anti-bloat), bumping the version. Backs up first (tar.gz, restorable via skill_rollback). Requires LLM refine enabled; without it, no-ops rather than risk a lossy fold. Only folds evolve-owned skills.',
    parameters: {
      name: { type: 'string', required: true, description: 'The skill directory name to fold.' },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const skill = readEvolveSkill(skillsDir, args.name);
      if (!skill) return { folded: false, reason: `"${args.name}" is not an evolve-owned skill` };
      if (bodyBeforeRefinements(skill.md) === null) return { folded: false, reason: 'no refinement sections to fold' };
      const distilled = await refineWithLLM(ctx, exec, { rawText: skill.md, kind: 'refine', tag: skill.state?.tag ?? args.name, cfg, logger: ctx.logger });
      if (!distilled?.body) return { folded: false, reason: 'LLM refine unavailable/failed; skipped fold to avoid a lossy rewrite (enable refineLLM and retry)' };
      backupSkill(skillsDir, archiveDir, args.name, 'fold'); // restorable via skill_rollback
      const res = foldSkillBody(skillsDir, args.name, distilled.body, ctx.logger ?? undefined);
      if (!res || res.folded === false) return { folded: false, reason: res?.reason ?? 'fold write failed' };
      return { folded: true, skill: args.name, version: res.version, note: `🧭 已把「${args.name}」的精炼段折叠回干净正文，版本 v${res.version}（已备份，可 skill_rollback 回滚）` };
    },
    presentCall: (args) => present(`🧭 折叠精炼段: ${args.name}`, 'other', args.name),
  }));

  ctx.tools.register(defineTool({
    name: 'skill_style',
    description: 'Attach a USER-STYLE overlay to a crystallized skill so its output "sounds like the user" — WITHOUT rewriting the skill. The overlay is a small instruction layer applied when the skill is used; the SKILL.md is never touched, so it is fully reversible. action=set attaches (instructions default to a block derived from the user profile; pass custom instructions to override); show/clear/list. This is the safe route for per-user skill personalization.',
    parameters: {
      action: { type: 'string', description: 'set (default) | show | clear | list.' },
      name: { type: 'string', description: 'Skill directory name (required for set/show/clear).' },
      instructions: { type: 'string', description: 'Custom style instructions for set. Omit to auto-derive from the user profile.' },
    },
    output: jsonOutput(),
    async execute(args) {
      const action = args.action ?? 'set';
      if (action === 'list') return { styled: listStyled(workspaceDir) };
      if (!args.name) return { error: 'name required' };
      if (!readEvolveSkill(skillsDir, args.name)) return { error: `"${args.name}" is not an evolve-owned skill; refusing (never touch human skills)` };
      if (action === 'show') {
        const overlay = getStyle(workspaceDir, args.name);
        return overlay ? { name: args.name, overlay } : { name: args.name, overlay: null, note: 'no style overlay attached' };
      }
      if (action === 'clear') return clearStyle(workspaceDir, args.name, ctx.logger ?? undefined);
      // set: custom instructions, else derive from the user profile.
      const instructions = (typeof args.instructions === 'string' && args.instructions.trim() !== '')
        ? args.instructions
        : deriveStyleFromProfile(store.profileView());
      if (!instructions) return { set: false, reason: 'no custom instructions and the user profile is empty — nothing to attach yet' };
      const res = setStyle(workspaceDir, args.name, instructions, ctx.logger ?? undefined);
      return res.set
        ? { ...res, note: `🎨 已给「${args.name}」挂上用户风格叠加层（不改底层 skill，可 action=clear 移除还原）` }
        : res;
    },
    presentCall: (args) => present(`🎨 skill 风格叠加: ${args.action ?? 'set'} ${args.name ?? ''}`, 'other', args.name ?? ''),
  }));

  ctx.tools.register(defineTool({
    name: 'evolve_maintain',
    description: 'One-shot maintenance sweep (v0.4.1 direction-3 sublayer B: the entry point an EXTERNAL cron calls for offline upkeep — no plugin-internal timer). Aggregates all read-only convergence/curation checks into one report: stale/archivable skills, skill merge candidates (zero-load + high-overlap first), refinement-bloated skills, memory char-budget status, and local→global promotion candidates. Detection only — it SUGGESTS; actions (converge_skill/fold_skill/archive_skill/memory_promote/memory_forget) stay human/model-invoked. Safe to run on a schedule.',
    parameters: {},
    output: jsonOutput(),
    async execute() {
      const states = listSkillStates(skillsDir, archiveDir, { staleDays: cfg.curatorStaleDays });
      const overArchive = states.stale.filter((s) => (s.ageDays ?? 0) >= (cfg.curatorArchiveDays ?? 60))
        .map((s) => ({ name: s.name, ageDays: s.ageDays }));
      const conv = convergenceReport(skillsDir, {
        mergeSimilarity: cfg.convergeMergeSimilarity,
        maxRefinements: cfg.convergeMaxRefinements,
      });
      const budget = store.memoryBudgetStatus();
      const promotions = store.promotionCandidates();
      // Consume the outcome-triage triples (v0.4.1): surface fitness READINESS
      // (is there enough data to bother scoring?) + neutral low-efficiency signals
      // (skills that load a lot but succeed rarely). Per the memo, fitness only
      // FEEDS convergence hints — it never auto-rewrites. No data → say so, so
      // "is there enough to run fitness yet" becomes observable instead of silent.
      const tri = triage ? triage.summary() : { totalTurns: 0, bySkill: {} };
      const minTurns = cfg.fitnessMinTurns ?? 30;
      const fitnessReady = tri.totalTurns >= minTurns;
      const lowEfficiency = Object.entries(tri.bySkill ?? {})
        .filter(([, e]) => e.loaded >= 3 && (e.succeeded / e.loaded) < 0.4)
        .map(([name, e]) => ({ name, loaded: e.loaded, successRate: Number((e.succeeded / e.loaded).toFixed(2)) }))
        .sort((a, b) => a.successRate - b.successRate);
      const fitness = {
        triplesCollected: tri.totalTurns,
        minTurnsForFitness: minTurns,
        ready: fitnessReady,
        note: fitnessReady
          ? `三元组已积累 ${tri.totalTurns} 条(≥${minTurns}),够跑 fitness 线索`
          : `三元组仅 ${tri.totalTurns} 条(<${minTurns}),数据不足,fitness 暂不启用`,
        lowEfficiencySkills: fitnessReady ? lowEfficiency : [],
      };
      const suggestions = [];
      if (overArchive.length) suggestions.push(`${overArchive.length} 个 skill 可归档(archive_skill)`);
      if (conv.mergeCandidates.length) suggestions.push(`${conv.mergeCandidates.length} 对 skill 可合并(converge_skill)`);
      if (conv.bloated.length) suggestions.push(`${conv.bloated.length} 个 skill 精炼段堆积可折叠(fold_skill)`);
      if (budget.enabled && budget.overBudget) suggestions.push(`记忆超预算 ${budget.overBy} 字符,可合并/forget`);
      if (promotions.length) suggestions.push(`${promotions.length} 条记忆可升级为全局(memory_promote)`);
      if (fitness.ready && fitness.lowEfficiencySkills.length) suggestions.push(`${fitness.lowEfficiencySkills.length} 个 skill 疑似低效(高加载低成功),可考虑合并/精炼`);
      return {
        ranAt: new Date().toISOString(),
        skillCounts: states.counts,
        archivable: overArchive,
        mergeCandidates: conv.mergeCandidates,
        bloated: conv.bloated,
        memoryBudget: budget,
        promotionCandidates: promotions,
        fitness,
        suggestions,
        note: suggestions.length ? `🧭 养护巡检:${suggestions.join('；')}。均为建议,动作需显式触发。` : '🧭 养护巡检:一切健康,无需收敛。',
      };
    },
    presentCall: () => present('🧭 离线养护巡检', 'read'),
  }));

  // ── Real usage tracking (zero-token): the platform `skill` load tool ────
  // When the model calls DSH's own `skill` tool, an assistant/message event
  // carries a tool-call content block { type:'tool-call', name:'skill',
  // arguments:{name} }. (The tool/call event itself only has {turn,step,callId}
  // — the name lives on the assistant message block, verified against
  // dsh-session invariant.js.) If the loaded skill is one of ours, stamp usage
  // so curator stale-detection reflects ACTUAL use, and attribute the load to
  // this turn for outcome triage.
  ctx.on('session/event', (_session, event) => {
    try {
      if (event?.type !== 'assistant/message') return;
      const data = event.data ?? {};
      const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
      const turn = data.turn ?? 0;
      for (const b of blocks) {
        if (b?.type !== 'tool-call' || b.name !== 'skill') continue;
        const rawArgs = b.arguments ?? b.input;
        const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        const loaded = parsed?.name;
        if (typeof loaded === 'string' && loaded !== '' && existsSync(join(skillsDir, loaded, 'SKILL.md'))) {
          noteSkillUse(skillsDir, loaded);
          try { triage?.noteSkillLoaded(turn, loaded); } catch { /* ignore */ }
          // Style overlay (v0.4.0 direction 2B): if this skill has a user-style
          // overlay, queue it for injection on the next step so the skill's
          // output adopts the user's style. The SKILL.md itself is untouched.
          if (!injectedStyleFor.has(loaded)) {
            try {
              const overlay = getStyle(workspaceDir, loaded);
              if (overlay) pendingStyleOverlays.set(loaded, overlay);
            } catch { /* best-effort */ }
          }
        }
      }
      // Background-review snapshot collection (v0.4.0 direction 3): accumulate
      // the assistant's TEXT for this turn IN MEMORY only (no injection, no
      // persist, no prompt-cache touch). Consumed + reset by the turn/end review.
      if (reviewCollector) {
        const assistantText = blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join(' ');
        reviewCollector.add('assistant', assistantText);
      }
    } catch { /* best-effort — never break event handling */ }
  });

  // Collect USER message text into the same per-turn snapshot buffer.
  if (reviewCollector) {
    ctx.on('session/event', (_session, event) => {
      try {
        if (event?.type !== 'user/message') return;
        const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
        const userText = blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join(' ');
        reviewCollector.add('user', userText);
      } catch { /* best-effort */ }
    });
  }

  // ── Per-step relevant recall injection (zero-token, repeat-suppressed) ──
  let lastInjectedKey = '';
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision?.kind !== 'enter') return decision;
    const extraMessages = [];
    if (checkpointPending) {
      checkpointPending = false;
      extraMessages.push(createUserMessage({
        content: [{ type: 'text', text: '【dsh-evolve】🧷 记忆已自动 git checkpoint（可回滚）' }],
        source: { kind: 'plugin', plugin: name, form: 'notice' },
      }));
    }
    // Inject any queued skill style overlays (v0.4.0 direction 2B): the skill's
    // SKILL.md is untouched; we layer the user's style as an instruction here.
    if (pendingStyleOverlays.size > 0) {
      for (const [skillName, overlay] of pendingStyleOverlays) {
        extraMessages.push(createUserMessage({
          content: [{ type: 'text', text: `【dsh-evolve】🎨 skill「${skillName}」的用户风格叠加（context，非用户发言）：\n${overlay}` }],
          source: { kind: 'plugin', plugin: name, form: 'notice' },
        }));
        injectedStyleFor.add(skillName);
      }
      pendingStyleOverlays.clear();
    }
    const query = queryFromMessages(payload?.messages);
    if (query === '' || !hasMeaningfulQuery(query)) {
      return extraMessages.length ? { ...decision, messages: [...decision.messages, ...extraMessages] } : decision;
    }
    let hits;
    try {
      hits = await store.recall(query, cfg.injectCount, { touch: false, includePending: false });
    } catch {
      return extraMessages.length ? { ...decision, messages: [...decision.messages, ...extraMessages] } : decision;
    }
    if (!hits || hits.length === 0) {
      return extraMessages.length ? { ...decision, messages: [...decision.messages, ...extraMessages] } : decision;
    }
    const key = hits.map((h) => h.record.id).sort().join(',');
    if (key === lastInjectedKey) {
      return extraMessages.length ? { ...decision, messages: [...decision.messages, ...extraMessages] } : decision;
    }
    lastInjectedKey = key;
    // Observability: mark these records as having influenced the model context.
    // In-memory only; persisted lazily (no write/git/ranking impact here).
    try { store.noteInjection(hits.map((h) => h.record.id)); } catch { /* best-effort */ }
    const msg = createUserMessage({
      content: [{ type: 'text', text: renderInjection(hits, cfg.injectMaxChars) }],
      source: { kind: 'plugin', plugin: name, form: 'notice' },
    });
    return { ...decision, messages: [...decision.messages, ...extraMessages, msg] };
  });

  // ── Error -> lesson nudge (deterministic count; reuses live turn) ───────
  const errorCounts = new Map();
  const lessonizeAfter = cfg.lessonizeAfter ?? 2;
  ctx.on('agent/error', async (payload) => {
    const fp = errorFingerprint(payload?.error);
    if (fp === '' || fp === ':') return;
    // Triage: record this turn hit an error (best-effort, before the nudge logic).
    try { triage?.noteError(payload?.turn ?? 0, fp); } catch { /* ignore */ }
    const n = (errorCounts.get(fp) ?? 0) + 1;
    if (n < lessonizeAfter) { errorCounts.set(fp, n); return; }
    errorCounts.delete(fp);
    try {
      payload.agent.inject(createUserMessage({
        content: [{ type: 'text', text: `【dsh-evolve】⚠️ 检测到同类错误第 ${n} 次：${fp}。请用 memory_remember 固化为教训(kind=lesson, importance=3)，并辩证总结：①错在哪、怎么规避 ②失败条件是什么(换条件是否可行、标注边界) ③有没有其实有效、值得保留的部分。避免把条件性失败记成绝对结论。` }],
        source: { kind: 'plugin', plugin: name, form: 'notice' },
      }));
    } catch { /* best-effort */ }
  });

  // ── turn/start -> Tier 1 always-on snapshot (the always-on snapshot mirror) ───
  // Inject the small set of durable user preferences/facts at the START of each
  // turn so they take effect immediately. Zero LLM; deduped so an unchanged
  // snapshot isn't re-sent (protects prompt cache), never blocks the turn.
  let lastTier1Key = '';
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return;
    if (cfg.tier1Enabled === false) return;
    try {
      const snap = store.tier1Snapshot({
        maxChars: cfg.tier1MaxChars, kinds: cfg.tier1Kinds,
        scope: cfg.tier1Scope, minImportance: cfg.tier1MinImportance,
      });
      if (snap.empty) return;
      if (snap.text === lastTier1Key) return; // unchanged since last turn — skip
      lastTier1Key = snap.text;
      const initiator = ctx.get?.('agents')?.currentInitiator?.();
      const agent = initiator?.agent ?? session?.agent;
      agent?.inject?.(createUserMessage({
        content: [{ type: 'text', text: `【dsh-evolve】用户长期偏好/事实（始终生效, context 非用户发言）:\n${snap.text}` }],
        source: { kind: 'plugin', plugin: name, form: 'notice' },
      }));
    } catch { /* best-effort — never break turn/start */ }
  });

  // ── turn/end -> crystallize/refine suggestion + optional auto-archive ───
  let lastSuggestedTag = '';
  let lastRefineTag = '';
  let lastConvergeKey = '';
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    // Triage: flush this turn's (skillsLoaded, errors, success) tuple first
    // (independent of the nudge logic below; best-effort, never blocks).
    try { triage?.flushTurn(event.data?.turn ?? 0); } catch { /* ignore */ }

    // ── Background review (v0.4.0 direction 3): isolated, throttled ────────
    // Replay THIS turn's snapshot through a standalone LLM call, route each
    // suggestion through store.remember (→ adjudicator gates auto/pending).
    // Never touches the main conversation/prompt cache. Fully async + fire-and-
    // forget so it never blocks turn/end. Best-effort: any failure is swallowed.
    if (reviewCollector && reviewCollector.hasContent) {
      const turnNo = Number(event.data?.turn ?? 0);
      const everyN = Math.max(1, cfg.reviewEveryTurns ?? 5);
      const due = turnNo - lastReviewedTurn >= everyN;
      if (due) {
        const snapshot = reviewCollector.snapshot();
        reviewCollector.reset();       // consume: next turns start a fresh buffer
        lastReviewedTurn = turnNo;
        void (async () => {
          try {
            const initiator = ctx.get?.('agents')?.currentInitiator?.();
            const exec = { agent: initiator?.agent ?? session?.agent };
            const { suggestions, elapsedMs, llmCalled } = await runReview(ctx, exec, {
              snapshot, cfg, logger: ctx.logger,
            });
            if (suggestions.length === 0) return;
            let auto = 0; let pending = 0; let skipped = 0;
            for (const s of suggestions) {
              // Pre-write quality gate: skip thin / reworded
              // near-duplicate suggestions BEFORE they land, so background review
              // doesn't pile up noise. (Manual memory_remember is not gated.)
              const q = store.assessWrite({ content: s.content, kind: s.kind, scope: s.scope });
              if (q.verdict === 'thin' || q.verdict === 'near-duplicate') { skipped += 1; continue; }
              // Route through the normal write path: the adjudicator (direction
              // 1) decides auto vs pending using the SAME objective signals. The
              // reviewer's anchored flag feeds anchoredToUser, but high-importance
              // / conflict / unknown still fall to pending by the gate's rules.
              const rec = await store.remember({
                content: s.content, kind: s.kind, importance: s.importance,
                scope: s.scope, anchoredToUser: s.anchoredToUser === true,
              });
              if (!rec) continue;
              if (rec.tags?.includes('pending')) pending += 1; else auto += 1;
            }
            ctx.logger?.info?.(`[dsh-evolve] background review turn ${turnNo}: ${suggestions.length} suggestion(s) → ${auto} auto, ${pending} pending, ${skipped} skipped (llm ${llmCalled ? `${elapsedMs}ms` : 'skipped'})`);
          } catch (e) {
            ctx.logger?.warn?.(`[dsh-evolve] background review failed: ${e?.message ?? e}`);
          }
        })();
      }
    }

    try {
      const initiator = ctx.get?.('agents')?.currentInitiator?.();
      const agent = initiator?.agent ?? session?.agent;
      const nudge = (text) => {
        try {
          agent?.inject?.(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: name, form: 'notice' },
          }));
        } catch { /* best-effort */ }
      };

      // 1) REFINE: tags whose skill already exists and gathered enough NEW evidence.
      const byTag = store.evidenceByTag(cfg.crystallizeKinds);
      let refined = false;
      for (const [tag, recs] of byTag) {
        if (!findSkillByTag(skillsDir, tag)) continue;
        if (recs.length < (cfg.refineMinNewEvidence ?? 2)) continue;
        if (tag === lastRefineTag) { refined = true; break; }
        lastRefineTag = tag;
        nudge(`【dsh-evolve】🧬 标签「${tag}」的 skill 已存在，且积累了 ${recs.length} 条新经验，可用 refine_skill(tag="${tag}") 就地精炼升级（追加 Refinement 段、版本号+1，不覆盖你的编辑）。`);
        refined = true;
        break;
      }

      // 2) CRYSTALLIZE: fresh tags (no skill yet) past the crystallize threshold.
      if (!refined) {
        const ready = store.crystallizationEvidence(cfg.crystallizeKinds, cfg.crystallizeMinImportance)
          .filter((g) => !findSkillByTag(skillsDir, g.tag));
        if (ready.length > 0) {
          const pick = ready[0];
          if (pick.tag !== lastSuggestedTag) {
            lastSuggestedTag = pick.tag;
            nudge(`【dsh-evolve】🧬 标签「${pick.tag}」已积累 ${pick.records.length} 条高价值 lesson/decision，可考虑用 crystallize_skill(tag="${pick.tag}") 固化成可复用 skill（仅当它确实是可复用流程时）。`);
          }
        }
      }

      // 3) CURATE: report stale, and optionally auto-archive very-idle skills.
      const states = listSkillStates(skillsDir, archiveDir, { staleDays: cfg.curatorStaleDays });
      const overArchive = states.stale.filter((s) => (s.ageDays ?? 0) >= (cfg.curatorArchiveDays ?? 60));
      if (overArchive.length > 0) {
        if (cfg.curatorAutoArchive === true) {
          const done = [];
          for (const s of overArchive) {
            const r = archiveSkill(skillsDir, archiveDir, s.name, ctx.logger ?? undefined);
            if (r.archived) done.push(`${s.name}(idle ${s.ageDays}d)`);
          }
          if (done.length > 0) nudge(`【dsh-evolve】📦 已自动归档长期闲置 skill：${done.join('、')}（移出活动目录，可 restore_skill 恢复；未删除）。`);
        } else {
          nudge(`【dsh-evolve】🧹 以下 skill 已闲置 ≥${cfg.curatorArchiveDays}天，可考虑 archive_skill 归档（可逆、不删）：${overArchive.map((s) => `${s.name}(${s.ageDays}d)`).join('、')}。`);
        }
      }

      // 4) CONVERGE (v0.4.0 direction 4): detect near-duplicate skills to merge
      // + refinement-bloated skills to fold. DETECTION only (zero LLM); the
      // actual merge/fold is a separate human/model-invoked tool (converge_skill
      // / fold_skill), never auto-run — mutations stay opt-in.
      if (cfg.convergeSuggest !== false) {
        const report = convergenceReport(skillsDir, {
          mergeSimilarity: cfg.convergeMergeSimilarity,
          maxRefinements: cfg.convergeMaxRefinements,
        });
        if (report.hasSuggestions) {
          const key = JSON.stringify({ m: report.topMerge, b: report.bloated.map((x) => x.name) });
          if (key !== lastConvergeKey) {
            lastConvergeKey = key;
            const bits = [];
            if (report.topMerge) {
              bits.push(`「${report.topMerge.a}」与「${report.topMerge.b}」高度重叠(${report.topMerge.similarity})，可 converge_skill 合并为一个 umbrella skill（生成新的 + 归档旧的，可逆、不删）`);
            }
            if (report.bloated.length > 0) {
              bits.push(`${report.bloated.map((x) => `${x.name}(${x.refinementCount}段精炼)`).join('、')} 精炼段堆积，可 fold_skill 折叠回干净正文`);
            }
            if (bits.length > 0) nudge(`【dsh-evolve】🧭 收敛建议（防臃肿）：${bits.join('；')}。`);
          }
        }
      }
    } catch { /* best-effort — never break turn/end */ }
  });

  // ── Web settings page (v0.3.0) ─────────────────────────────────────────
  // Only wires up when the web profile provides webServer + settings. Both are
  // soft (ctx.inject self-defers; never in the top-level inject array) so
  // headless/other profiles skip the whole UI without affecting memory/skills.
  try {
    // v0.4.2 prune controller: skillOps reuses skills.js + converge.js primitives.
    const usagePathLocal = join(skillsDir, '.evolve-usage.json');
    const readUsage = () => { try { return JSON.parse(readFileSync(usagePathLocal, 'utf8')); } catch { return {}; } };
    const skillOps = {
      isEvolveOwned: (name) => !!readEvolveSkill(skillsDir, name),
      skillUsage: (name) => {
        const u = readUsage()[name];
        const meta = readEvolveSkill(skillsDir, name);
        return { name, version: meta?.version ?? 0, lastActivityAt: u?.lastActivityAt ?? u?.createdAt ?? '',
          status: 'active', refinementCount: meta?.refinementCount ?? 0 };
      },
      mergeCandidates: () => findMergeCandidates(skillsDir, { mergeSimilarity: cfg.mergeSimilarity }),
      archive: (name) => archiveSkill(skillsDir, archiveDir, name, ctx.logger ?? undefined),
      fold: (name) => {
        const skill = readEvolveSkill(skillsDir, name);
        if (!skill) return { error: 'not evolve-owned' };
        return foldSkillBody(skillsDir, name, bodyBeforeRefinements(skill.body ?? ''), ctx.logger ?? undefined);
      },
      converge: (names, into) => {
        const skills = names.map((n) => readEvolveSkill(skillsDir, n)).filter(Boolean);
        if (skills.length < 2) return { error: 'need >=2 evolve-owned skills' };
        const mergedTag = into || skills[0].tag || names[0];
        const body = buildMergeInput(skills);
        const skillName = proposeSkillName(skillsDir, mergedTag, into);
        const res = writeCrystallizedSkill(skillsDir, skillName, mergedTag, [], ctx.logger ?? undefined, body);
        for (const s of skills) { try { archiveSkill(skillsDir, archiveDir, s.name, ctx.logger ?? undefined); } catch { /* best-effort */ } }
        return { converged: res?.name ?? skillName, from: names };
      },
    };
    const prune = makePruneController({ store, workspaceDir, cfg, skillOps });

    setupWebSettings(ctx, {
      cfg, store,
      llm: ctx.llm,  // resolved in the injected main ctx; passed as a value so the
                     // web child plugin (which only injects webServer) can use it.
      prune,
      skillStates: () => {
        const st = listSkillStates(skillsDir, archiveDir, { staleDays: cfg.curatorStaleDays });
        return { counts: st.counts, triage: triage ? triage.summary() : { disabled: true } };
      },
    });
  } catch (e) {
    ctx.logger?.warn?.(`[dsh-evolve] web settings setup skipped: ${e?.message ?? e}`);
  }

  ctx.logger?.info?.(`[dsh-evolve] ready (workspace=${workspaceDir}, skillsDir=${skillsDir}, archive=${archiveDir}, fts=${fts?.available ? 'on' : 'off'})`);
}

/**
 * Prune controller (v0.4.2): the controlled-pruning surface behind the panel.
 * Assembles candidates (heat-ordered, pinned/protected excluded), builds/stores
 * plans in an in-memory registry (idempotency), previews (read-only), and
 * executes through the authz gate + per-target etag staleness + audit trail.
 *
 * @param deps { store, skillsDir, archiveDir, workspaceDir, cfg, skillOps }
 *   skillOps = { evolveSkills(), skillUsage(name), archive(name), fold(name),
 *                converge(names,into) } supplied by index (reuses skills.js).
 */
function makePruneController({ store, workspaceDir, cfg, skillOps }) {
  const registry = new PlanRegistry();

  function listCandidates() {
    const budget = store.memoryBudgetStatus();
    // memory candidates = the trim list budgetStatus already produces (heat-ordered,
    // pinned+protected excluded). Enrich each with entityType + allowedActions + etag.
    const memRecordsById = store.recordsById();
    const memoryCandidates = (budget.trimCandidates ?? []).map((c) => {
      const rec = memRecordsById.get(c.id);
      const authz = authorizePruneAction('memory-forget', rec ?? {}, cfg);
      const allowedActions = ['memory-forget'];
      if (rec && rec.scope === 'project') allowedActions.push('memory-promote');
      return {
        entityType: 'memory', id: c.id, kind: rec?.kind, importance: c.importance,
        heat: c.heat, injectionCount: c.injectionCount, observationCount: c.observationCount,
        pinned: !!rec?.pinned, protectedKind: false,
        reason: c.heat != null ? `low value + cold (heat ${c.heat})` : 'low value',
        allowedActions: authz.allowed ? allowedActions : [],
        etag: rec ? memoryEtag(rec) : null,
        content: c.content,
      };
    });
    // protected-kind records shown READ-ONLY in a separate review area (no forget)
    const protectedReview = store.confirmed()
      .filter((r) => ['preference', 'decision'].includes(r.kind))
      .slice(0, 20)
      .map((r) => ({ entityType: 'memory', id: r.id, kind: r.kind, importance: r.importance,
        content: String(r.content).replace(/\s+/g, ' ').slice(0, 80) }));

    // skill candidates = merge candidates + refinement bloat, heat-annotated.
    const skillCandidates = [];
    try {
      const merges = skillOps.mergeCandidates(); // [{a,b,similarity,zeroLoadCount,_heat?}]
      for (const m of merges.slice(0, 20)) {
        skillCandidates.push({
          entityType: 'skill', kind: 'merge', names: [m.a, m.b],
          similarity: m.similarity, zeroLoadCount: m.zeroLoadCount,
          allowedActions: ['skill-converge', 'skill-archive'],
        });
      }
    } catch { /* best-effort */ }

    // forgotten (recoverable) list
    const forgotten = store.list({ forgotten: true }).map((r) => ({
      id: r.id, kind: r.kind, content: String(r.content).replace(/\s+/g, ' ').slice(0, 80),
    }));

    return { budget: { enabled: budget.enabled, used: budget.used, max: budget.max, overBudget: budget.overBudget },
      memoryCandidates, protectedReview, skillCandidates, forgotten };
  }

  // selection -> decisions[] -> plan (stored in registry). No mutation.
  function preview(selection) {
    const decisions = [];
    const memRecordsById = store.recordsById();
    for (const sel of (selection?.decisions ?? [])) {
      if (sel.entityType === 'memory') {
        const targets = (sel.memoryIds ?? []).map((id) => {
          const rec = memRecordsById.get(id);
          return { id, etag: rec ? memoryEtag(rec) : null };
        });
        decisions.push({ action: sel.action, entityType: 'memory', targets, reason: sel.reason ?? '' });
      } else if (sel.entityType === 'skill') {
        const targets = (sel.skillNames ?? []).map((name) => ({ name, etag: skillEtag(skillOps.skillUsage(name)) }));
        decisions.push({ action: sel.action, entityType: 'skill', targets, into: sel.into, reason: sel.reason ?? '' });
      }
    }
    const plan = buildPlan(decisions);
    registry.put(plan);
    // human-readable preview + authz precheck (skipped items shown up front)
    const preview = decisions.map((d) => {
      const authzTarget = d.entityType === 'memory'
        ? (memRecordsById.get(d.targets[0]?.id) ?? {})
        : d.targets.map((t) => ({ name: t.name, ownedByEvolve: skillOps.isEvolveOwned(t.name) }));
      const authz = authorizePruneAction(d.action, d.action === 'skill-converge' ? authzTarget : authzTarget, cfg);
      return { action: d.action, count: d.targets.length, allowed: authz.allowed, reason: authz.reason, requires: authz.requires };
    });
    return { planDigest: plan.planDigest, preview };
  }

  async function execute(planDigest, opts = {}) {
    const look = registry.lookup(planDigest);
    if (look.status === 'plan-expired') return { status: 'plan-expired' };
    if (look.status === 'retry') return { ...look.receipt, status: 'retry', replayed: true };
    const plan = look.plan;

    // authz gate per decision (data-layer store.forget also re-checks pinned)
    const memRecordsById = store.recordsById();
    const handlers = {
      'memory-forget': async (id) => {
        const rec = memRecordsById.get(id);
        const authz = authorizePruneAction('memory-forget', rec ?? {}, cfg);
        if (!authz.allowed) return { blocked: authz.reason };
        // panel forget = reversible soft-delete; importance-3 needs confirm
        const needConfirm = authz.requires === 'explicit-confirm';
        return store.softForget(id, needConfirm ? opts.confirm === true : undefined);
      },
      'memory-promote': async (id) => {
        const rec = memRecordsById.get(id);
        const authz = authorizePruneAction('memory-promote', rec ?? {}, cfg);
        if (!authz.allowed) return { blocked: authz.reason };
        return store.promoteToGlobal(id);
      },
      'memory-restore': async (id) => {
        // restore is reversible + low-risk (un-forget); no authz gate needed
        return store.restoreForgotten(id);
      },
      'skill-archive': async (name) => {
        if (!skillOps.isEvolveOwned(name)) return { blocked: 'not evolve-owned' };
        return skillOps.archive(name);
      },
      'skill-fold': async (name) => {
        if (!skillOps.isEvolveOwned(name)) return { blocked: 'not evolve-owned' };
        return skillOps.fold(name);
      },
      'skill-converge': async (names, into) => {
        const list = names.map((n) => ({ name: n, ownedByEvolve: skillOps.isEvolveOwned(n) }));
        const authz = authorizePruneAction('skill-converge', list, cfg);
        if (!authz.allowed) return { blocked: authz.reason };
        return skillOps.converge(names, into);
      },
    };
    const currentEtag = (entityType, key) => {
      if (entityType === 'memory') { const r = memRecordsById.get(key); return r ? memoryEtag(r) : null; }
      const u = skillOps.skillUsage(key); return u ? skillEtag(u) : null;
    };
    const result = await applyPlan(plan, handlers, currentEtag);
    registry.markConsumed(planDigest, result);
    // audit is fail-open (never blocks the prune)
    try { appendAudit(workspaceDir, { planDigest, decisions: plan.decisions.length, status: result.status, applied: result.applied, skipped: result.skipped }, cfg, { warn() {} }); } catch { /* fail-open */ }
    return result;
  }

  return { listCandidates, preview, execute };
}

/**
 * Wire the web settings section + control-plane routes.
 *
 * webServer/settings only exist in the web profile. We can't put them in
 * dsh-evolve's TOP-LEVEL inject (that would block headless boot). And the
 * runtime `ctx.inject([...], cb)` form does NOT fire on this host's real ctx
 * (verified live: callback never runs). The reliable mechanism is a CHILD
 * plugin whose OWN top-level `inject` declares the dep — cordis runs the child's
 * apply only once the dep resolves, and simply never runs it in headless. This
 * is exactly how a sibling plugin (inject=['webServer']) works.
 */
function setupWebSettings(ctx, { cfg, store, skillStates, llm, prune }) {
  // Child plugin for the control-plane routes (hard-needs webServer).
  const routesPlugin = {
    name: 'dsh-evolve-web-routes',
    inject: ['webServer'],
    apply(wctx) {
      const disposers = [];
      try {
        const routes = makeEvolveRoutes({
          store, llm,
          getConfig: () => cfg,
          setConfig: (patch) => { Object.assign(cfg, patch); },
          skillStates,
          prune,
        });
        for (const route of routes) disposers.push(wctx.webServer.register(route));
      } catch (e) {
        for (const d of disposers) { try { d(); } catch { /* ignore */ } }
        wctx.logger?.warn?.(`[dsh-evolve] route registration failed: ${e?.message ?? e}`);
      }
      wctx.effect?.(() => () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } });
    },
  };

  // Child plugin for the settings section (hard-needs settings). Dynamic import
  // so a profile without dsh-settings on the resolution path never hard-fails.
  const settingsPlugin = {
    name: 'dsh-evolve-web-settings',
    inject: ['settings'],
    async apply(sctx) {
      try {
        const { installSettingsSection, settingsNamespace } = await import('@deepseek-ai/dsh-settings');
        const ns = settingsNamespace('dsh-evolve');
        const base = {
          refineLLM: cfg.refineLLM === true,
          refineProvider: cfg.refineProvider ?? '',
          refineModel: cfg.refineModel ?? '',
          tier1Enabled: cfg.tier1Enabled !== false,
        };
        let current = () => base;
        installSettingsSection(sctx, ns, zEvolveSettings, base, {
          setSource: (src) => { current = src; },
          onChange: () => { try { Object.assign(cfg, current()); } catch { /* ignore */ } },
        });
      } catch (e) {
        sctx.logger?.warn?.(`[dsh-evolve] settings section skipped: ${e?.message ?? e}`);
      }
    },
  };

  try { ctx.plugin(routesPlugin); } catch (e) { ctx.logger?.warn?.(`[dsh-evolve] web routes plugin skipped: ${e?.message ?? e}`); }
  try { ctx.plugin(settingsPlugin); } catch (e) { ctx.logger?.warn?.(`[dsh-evolve] web settings plugin skipped: ${e?.message ?? e}`); }
}

export default { name, inject, apply };
