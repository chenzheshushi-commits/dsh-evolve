/**
 * dsh-evolve — self-evolving memory + skill crystallization for DSH.
 *
 * v0.2.0 closes the three gapsidentified in the first release:
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
 *   - apply never throws into boot; hooks never break the agent loop.
 *
 * @module dsh-evolve
 */
import { existsSync, mkdirSync } from 'node:fs';
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
  skillNameFromTag, writeCrystallizedSkill, refineCrystallizedSkill,
  archiveSkill, restoreSkill, listSkillStates, countCrystallizedSkills, noteSkillUse,
} from './skills.js';

export const name = 'dsh-evolve';
export const inject = ['tools', 'storageDomain', 'systemPrompt'];

function resolveDshHome {
  const raw = process.env.DSH_HOME;
  if (raw && raw.trim !== '') {
    const expanded = raw.startsWith('~/') ? join(homedir, raw.slice(2)) : raw;
    return isAbsolute(expanded) ? expanded : join(process.cwd, expanded);
  }
  return join(homedir, '.dsh');
}

function queryFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim;
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
  return `${code}:${msg}`.trim;
}

const jsonOutput =  => ({
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** DSH UI display card for a tool call (title + kind hint). */
const present = (title, kind, rawInput) => ({
  card: 'generic', title, kind,...(rawInput === undefined ? {} : { rawInput }),
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
- Model writes are PENDING until a human confirms (memory_confirm). Pending memories are
  searchable but are NOT auto-injected — the human owns what becomes always-on.
- When the user corrects you, or the same mistake recurs, memory_remember it as
  kind=lesson, importance=3.
- Write lessons DIALECTICALLY, never absolute: (1) what went wrong + how to avoid; (2) the
  CONDITIONS that caused it (would it work under different conditions? note the boundary);
  (3) what actually worked — keep the salvageable part. Prefer "under condition A, X failed
  because B; the C part worked" over "X is impossible".
- kind: fact / preference / decision / lesson / todo / note. importance: 1 nice / 2 useful /
  3 critical (eviction-proof). scope: user (everywhere) or project (this project).

Skill lifecycle (crystallize → refine → curate):
- CRYSTALLIZE (crystallize_skill): when several high-value lessons/decisions share a tag and
  NO skill exists for it yet, author a new SKILL.md. Only for genuinely reusable procedures.
- REFINE (refine_skill): when a tag ALREADY has a crystallized skill and new evidence
  accumulated, improve it IN PLACE — a new versioned "Refinement" section is appended, the
  version bumps, your prose edits are preserved. Prefer refine over re-crystallizing.
- CURATE (skill_curator / archive_skill / restore_skill): the system reports active/stale/
  archived skills. Archiving moves a stale skill out of the active catalog (reversible via
  restore_skill); it NEVER deletes. Suggest archiving only skills that are truly obsolete.
- Skills are loaded/managed by the harness's own skill system — treat crystallized/refined
  ones as normal skills afterward.

Observability (read-only): memory_stats shows totals, kind/scope breakdown, the pending-confirm
queue (memories awaiting human approval), and which memories are most accessed (manual recall)
vs most injected (auto-fed into context — the real decision-influence signal). skill_stats shows
the crystallized-skill lifecycle counts. Use them to review what the memory/skill system is doing.`;

/** Plugin entry. Never throws — memory/skill plugin must not brick the harness. */
export async function apply(ctx, config = {}) {
  const cfg = {...MEMORY_DEFAULTS,...SKILL_DEFAULTS,...config };
  const dshHome = resolveDshHome;
  const workspaceDir = join(dshHome, 'evolve-workspace');
  const skillsDir = cfg.skillsDir && cfg.skillsDir.trim !== '' ? cfg.skillsDir : join(dshHome, 'skills');
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
    if (!existing) ctx.effect( =>  => { void domain.close?.; });
  } catch (e) {
    ctx.logger?.warn?.(`[dsh-evolve] storage domain open failed (memory disabled): ${e?.message ?? e}`);
    return;
  }
  const table = domain.table('records');

  // Derived FTS5 index (NullFts if unavailable). Backfilled inside the store ctor.
  const fts = await createFtsIndex(ctx.logger ?? undefined, cfg.ftsEnabled !== false);
  if (fts?.available && typeof fts.close === 'function') ctx.effect( =>  => { fts.close; });

  // Surface background git checkpoints as a visible one-liner on the next step.
  let checkpointPending = false;
  const store = new MemoryStore(table, {
    workspaceDir, config: cfg, logger: ctx.logger ?? undefined, fts,
    onCommit:  => { checkpointPending = true; },
  });
  // Flush any pending injection counters on dispose (last chance before the
  // domain closes) — the "ride on real writes" path handles the common case.
  ctx.effect( =>  => { void store.flushInjections?.; });

  // ── System-prompt protocol section ─────────────────────────────────────
  ctx.systemPrompt.section({ name: 'evolve-protocol', order: 110, text: PROTOCOL_SECTION });

  // ── Model tools: memory ────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Save a cross-session memory (pending until a human confirms). kind: fact/preference/decision/lesson/todo/note; importance 1-3; scope user/project; tags: short lowercase words.',
    parameters: {
      content: { type: 'string', required: true, description: 'The memory content (plaintext, <=2000 chars).' },
      kind: { type: 'string', description: `One of: ${MEMORY_KINDS.join(', ')}.` },
      importance: { type: 'number', description: '1 nice-to-know, 2 useful, 3 critical (eviction-proof).' },
      scope: { type: 'string', description: `One of: ${MEMORY_SCOPES.join(', ')}.` },
      tags: { type: 'array', items: { type: 'string' }, description: 'Short lowercase anchor words for recall + crystallization.' },
    },
    output: jsonOutput,
    async execute(args) {
      const rec = await store.remember({
        content: args.content, kind: args.kind, importance: args.importance,
        scope: args.scope, tags: args.tags,
      });
      if (!rec) return { saved: false };
      return { saved: true, status: 'pending', note: `已存记忆(待确认): ${rec.kind}/imp${rec.importance} — ${rec.content.slice(0, 40)}`, record: rec };
    },
    presentCall: (args) => present('💾 存记忆(待确认)', 'other', args.content),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Recall stored memories by keyword (deterministic bigram + BM25 fusion; a miss means nothing matched). Includes pending memories so you can evaluate them.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword query.' },
      limit: { type: 'number', description: 'Max results (default 5).' },
    },
    output: jsonOutput,
    async execute(args) {
      const hits = await store.recall(args.query, args.limit, { touch: true, includePending: true });
      return hits.map((h) => ({...h.record, score: Number(h.score.toFixed(4)) }));
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
    output: jsonOutput,
    async execute(args) {
      return store.list({ kind: args.kind, scope: args.scope, pending: args.pending });
    },
    presentCall:  => present('📇 记忆索引', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_confirm',
    description: 'Human-owned: confirm a pending memory so it becomes eligible for auto-injection. Only call when the user explicitly asks to confirm/approve a memory; never self-promote.',
    parameters: { id: { type: 'string', required: true, description: 'Memory id from memory_index/memory_recall.' } },
    output: jsonOutput,
    async execute(args) { return (await store.confirm(args.id)) ?? { confirmed: false }; },
    presentCall: (args) => present('✅ 确认记忆(人工授权)', 'other', args.id),
  }));

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one memory by id. importance-3 memories require confirm=true.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id.' },
      confirm: { type: 'boolean', description: 'Required true to delete an importance-3 memory.' },
    },
    output: jsonOutput,
    async execute(args) { return store.forget(args.id, args.confirm); },
    presentCall: (args) => present('🗑️ 删除记忆', 'other', args.id),
  }));

  // ── Model tools: skill crystallize / refine ────────────────────────────
  const skillExists = (tag) => existsSync(join(skillsDir, skillNameFromTag(tag), 'SKILL.md'));

  /** Confirmed, non-crystallized procedural evidence for a tag (any amount). */
  const freshEvidence = (tag) => store.list({ pending: false }).filter((r) => r.tags.includes(tag) && cfg.crystallizeKinds.includes(r.kind) && !r.crystallizedAt);

  ctx.tools.register(defineTool({
    name: 'crystallize_skill',
    description: 'Author a NEW reusable SKILL.md from accumulated lesson/decision memories sharing a tag (written to the harness skills dir, hot-loaded). If a skill for this tag already exists, use refine_skill instead.',
    parameters: {
      tag: { type: 'string', required: true, description: 'The memory tag whose lessons/decisions to crystallize.' },
    },
    output: jsonOutput,
    async execute(args) {
      const skillName = skillNameFromTag(args.tag);
      if (skillExists(args.tag)) {
        return { crystallized: false, reason: `skill "${skillName}" already exists for tag "${args.tag}"; use refine_skill to improve it in place` };
      }
      const records = freshEvidence(args.tag);
      if (records.length === 0) {
        return { crystallized: false, reason: `no fresh confirmed lesson/decision memories tagged "${args.tag}" (already crystallized or none confirmed)` };
      }
      const res = writeCrystallizedSkill(skillsDir, skillName, args.tag, records, ctx.logger ?? undefined);
      if (!res) return { crystallized: false, reason: 'write skipped (name owned by a non-evolve skill) or failed' };
      await store.markCrystallized(records.map((r) => r.id));
      return {
        crystallized: true, skill: res.name, version: res.version, path: res.path, fromRecords: records.length,
        note: `🧬 已把 ${records.length} 条"${args.tag}"经验结晶为 skill「${res.name}」v${res.version}，写入 ${res.path}，DSH 将自动热加载`,
      };
    },
    presentCall: (args) => present(`🧬 结晶 skill: ${skillNameFromTag(args.tag)}`, 'create', args.tag),
  }));

  ctx.tools.register(defineTool({
    name: 'refine_skill',
    description: 'IMPROVE an existing crystallized skill in place with newly-accumulated evidence for its tag: appends a versioned "Refinement" section, bumps the version, updates the changelog — WITHOUT overwriting human edits. Zero extra LLM. Use this instead of re-crystallizing when the skill already exists.',
    parameters: {
      tag: { type: 'string', required: true, description: 'The memory tag whose skill to refine (must already be crystallized).' },
    },
    output: jsonOutput,
    async execute(args) {
      const skillName = skillNameFromTag(args.tag);
      if (!skillExists(args.tag)) {
        return { refined: false, reason: `no skill "${skillName}" for tag "${args.tag}" yet; use crystallize_skill first` };
      }
      const records = freshEvidence(args.tag);
      if (records.length === 0) {
        return { refined: false, reason: `no new confirmed lesson/decision memories tagged "${args.tag}" to fold in` };
      }
      const res = refineCrystallizedSkill(skillsDir, skillName, args.tag, records, ctx.logger ?? undefined);
      if (!res) return { refined: false, reason: 'refine failed (I/O)' };
      if (res.refined === false) return res;
      await store.markCrystallized(records.map((r) => r.id));
      return {
        refined: true, skill: res.name, version: res.version, path: res.path, added: res.added,
        note: `🧬 已用 ${res.added} 条新"${args.tag}"经验精炼 skill「${res.name}」→ v${res.version}（追加 Refinement 段，保留人工编辑）`,
      };
    },
    presentCall: (args) => present(`🧬 精炼 skill: ${skillNameFromTag(args.tag)}`, 'edit', args.tag),
  }));

  // ── Model tools: curator lifecycle ─────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'skill_curator',
    description: 'Lifecycle report for crystallized skills: active / stale (idle >= staleDays) / archived, with versions + idle age. Never mutates; use to decide what to archive or refine.',
    parameters: {},
    output: jsonOutput,
    async execute {
      const states = listSkillStates(skillsDir, archiveDir, { staleDays: cfg.curatorStaleDays });
      return {...states,
        crystallizedActive: countCrystallizedSkills(skillsDir),
        archiveDays: cfg.curatorArchiveDays,
        autoArchive: cfg.curatorAutoArchive === true,
      };
    },
    presentCall:  => present('🧹 skill 生命周期报告', 'read'),
  }));

  // ── Model tools: observability (v0.2.1) ────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: 'Current-snapshot memory statistics: totals, by-kind/scope breakdown, pending-confirm queue, and the memories most accessed (manual recall) and most injected (auto-fed into context — the real decision-influence signal). No time-window data (this plugin keeps no event log by design).',
    parameters: {},
    output: jsonOutput,
    async execute {
      return store.stats({ topN: 5 });
    },
    presentCall:  => present('📊 记忆统计', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'skill_stats',
    description: 'Current-snapshot crystallized-skill statistics: active/stale/archived counts, per-skill version + refinement count + idle age. Read-only; never mutates.',
    parameters: {},
    output: jsonOutput,
    async execute {
      const states = listSkillStates(skillsDir, archiveDir, { staleDays: cfg.curatorStaleDays });
      return {
        counts: states.counts,
        staleDays: cfg.curatorStaleDays,
        archiveDays: cfg.curatorArchiveDays,
        autoArchive: cfg.curatorAutoArchive === true,
        active: states.active,
        stale: states.stale,
        archived: states.archived,
      };
    },
    presentCall:  => present('📊 skill 统计', 'read'),
  }));

  ctx.tools.register(defineTool({
    name: 'archive_skill',
    description: 'Archive a stale/obsolete crystallized skill: move it OUT of the active skills dir into the evolve archive so it stops appearing in the skill catalog. REVERSIBLE (restore_skill) and never deletes. Only archives evolve-owned skills.',
    parameters: { name: { type: 'string', required: true, description: 'The crystallized skill name (from skill_curator).' } },
    output: jsonOutput,
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
    output: jsonOutput,
    async execute(args) {
      const res = restoreSkill(skillsDir, archiveDir, args.name, ctx.logger ?? undefined);
      if (res.restored) res.note = `♻️ 已恢复 skill「${res.name}」→ ${res.to}（重新进入活动目录）`;
      return res;
    },
    presentCall: (args) => present(`♻️ 恢复 skill: ${args.name}`, 'other', args.name),
  }));

  // ── Real usage tracking (zero-token): the platform `skill` load tool ────
  // Every time the model loads a skill via DSH's own `skill` tool, a tool/call
  // event fires. If the loaded skill is one of ours, stamp its usage so the
  // curator's stale detection reflects ACTUAL use, not just creation time.
  ctx.on('session/event', (_session, event) => {
    try {
      if (event?.type !== 'tool/call' || event.name !== 'skill') return;
      const parsed = typeof event.arguments === 'string' ? JSON.parse(event.arguments) : event.arguments;
      const loaded = parsed?.name;
      if (typeof loaded === 'string' && loaded !== '' && existsSync(join(skillsDir, loaded, 'SKILL.md'))) {
        noteSkillUse(skillsDir, loaded);
      }
    } catch { /* best-effort — never break event handling */ }
  });

  // ── Per-step relevant recall injection (zero-token, repeat-suppressed) ──
  let lastInjectedKey = '';
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next;
    if (decision?.kind !== 'enter') return decision;
    const extraMessages = [];
    if (checkpointPending) {
      checkpointPending = false;
      extraMessages.push(createUserMessage({
        content: [{ type: 'text', text: '【dsh-evolve】🧷 记忆已自动 git checkpoint（可回滚）' }],
        source: { kind: 'plugin', plugin: name, form: 'notice' },
      }));
    }
    const query = queryFromMessages(payload?.messages);
    if (query === '' || !hasMeaningfulQuery(query)) {
      return extraMessages.length ? {...decision, messages: [...decision.messages,...extraMessages] } : decision;
    }
    let hits;
    try {
      hits = await store.recall(query, cfg.injectCount, { touch: false, includePending: false });
    } catch {
      return extraMessages.length ? {...decision, messages: [...decision.messages,...extraMessages] } : decision;
    }
    if (!hits || hits.length === 0) {
      return extraMessages.length ? {...decision, messages: [...decision.messages,...extraMessages] } : decision;
    }
    const key = hits.map((h) => h.record.id).sort.join(',');
    if (key === lastInjectedKey) {
      return extraMessages.length ? {...decision, messages: [...decision.messages,...extraMessages] } : decision;
    }
    lastInjectedKey = key;
    // Observability: mark these records as having influenced the model context.
    // In-memory only; persisted lazily (no write/git/ranking impact here).
    try { store.noteInjection(hits.map((h) => h.record.id)); } catch { /* best-effort */ }
    const msg = createUserMessage({
      content: [{ type: 'text', text: renderInjection(hits, cfg.injectMaxChars) }],
      source: { kind: 'plugin', plugin: name, form: 'notice' },
    });
    return {...decision, messages: [...decision.messages,...extraMessages, msg] };
  });

  // ── Error -> lesson nudge (deterministic count; reuses live turn) ───────
  const errorCounts = new Map;
  const lessonizeAfter = cfg.lessonizeAfter ?? 2;
  ctx.on('agent/error', async (payload) => {
    const fp = errorFingerprint(payload?.error);
    if (fp === '' || fp === ':') return;
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

  // ── turn/end -> crystallize/refine suggestion + optional auto-archive ───
  let lastSuggestedTag = '';
  let lastRefineTag = '';
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    try {
      const initiator = ctx.get?.('agents')?.currentInitiator?.;
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
        if (!existsSync(join(skillsDir, skillNameFromTag(tag), 'SKILL.md'))) continue;
        if (recs.length < (cfg.refineMinNewEvidence ?? 2)) continue;
        if (tag === lastRefineTag) { refined = true; break; }
        lastRefineTag = tag;
        nudge(`【dsh-evolve】🧬 标签「${tag}」的 skill 已存在，且积累了 ${recs.length} 条新经验，可用 refine_skill(tag="${tag}") 就地精炼升级（追加 Refinement 段、版本号+1，不覆盖你的编辑）。`);
        refined = true;
        break;
      }

      // 2) CRYSTALLIZE: fresh tags (no skill yet) past the crystallize threshold.
      if (!refined) {
        const ready = store.crystallizationEvidence(cfg.crystallizeKinds, cfg.crystallizeMinImportance).filter((g) => !existsSync(join(skillsDir, skillNameFromTag(g.tag), 'SKILL.md')));
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
    } catch { /* best-effort — never break turn/end */ }
  });

  ctx.logger?.info?.(`[dsh-evolve] ready (workspace=${workspaceDir}, skillsDir=${skillsDir}, archive=${archiveDir}, fts=${fts?.available ? 'on' : 'off'})`);
}

export default { name, inject, apply };
