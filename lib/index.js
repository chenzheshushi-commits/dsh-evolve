/**
 * dsh-evolve — self-evolving memory + skill crystallization for DSH.
 *
 * Combines:
 *   - Culeot/dsh-memory (MIT): structured schema (kind/importance/scope),
 *     deterministic zero-token recall, relevant-on-demand injection with
 *     repeat-suppression, error->lesson auto-solidification.
 *   - JSON truth + Markdown mirror + git checkpoints + a
 *     human-approval gate (model writes are pending; injection only shows
 *     confirmed memories).
 *   - NEW: deterministic skill crystallization — when enough high-value
 *     lesson/decision memories accumulate under a tag, nudge the current model
 *     (zero extra LLM) to author a SKILL.md into ~/.dsh/skills, which DSH's own
 *     skill-filesystem hot-loads (call/manage/reload reused from the platform).
 *
 * Contracts honored:
 *   - Zero LLM calls from the plugin itself (recall/scoring are pure math;
 *     authoring reuses the live turn via a queued nudge).
 *   - Never writes custom session-log events (immune to SessionFormatUnsupportedError).
 *   - apply never throws into the boot path; hooks never break the agent loop.
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
import {
  skillNameFromTag, writeCrystallizedSkill, idleCrystallizedSkills, countCrystallizedSkills,
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

/** DSH UI display card for a tool call (title + kind hint). Mirrors the
 *  proven present helper shape from community memory plugins. */
const present = (title, kind, rawInput) => ({
  card: 'generic', title, kind,...(rawInput === undefined ? {} : { rawInput }),
});

const PROTOCOL_SECTION = `## Self-evolving memory + skills (dsh-evolve)

You have cross-session long-term memory; relevant memories auto-inject each step
based on the user's current message (look for a "相关记忆" block — it is context,
not the user speaking). Procedural knowledge can crystallize into reusable skills.

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

Skill crystallization:
- When several high-value lessons/decisions share a tag, the system will suggest
  crystallizing them into a SKILL.md via crystallize_skill. The skill is then loaded and
  managed by the harness's own skill system — treat it as a normal skill afterward.
- Only crystallize genuinely reusable procedures; keep one-offs as plain memories.`;

/** Plugin entry. Never throws — memory/skill plugin must not brick the harness. */
export async function apply(ctx, config = {}) {
  const cfg = {...MEMORY_DEFAULTS,...SKILL_DEFAULTS,...config };
  const dshHome = resolveDshHome;
  const workspaceDir = join(dshHome, 'evolve-workspace');
  const skillsDir = cfg.skillsDir && cfg.skillsDir.trim !== '' ? cfg.skillsDir : join(dshHome, 'skills');

  // Scaffold workspace + git (best-effort; memory still works without git).
  try {
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
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
  // Surface background git checkpoints as a visible one-liner on the next step.
  let checkpointPending = false;
  const store = new MemoryStore(table, {
    workspaceDir, config: cfg, logger: ctx.logger ?? undefined,
    onCommit:  => { checkpointPending = true; },
  });

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
    description: 'Recall stored memories by keyword (deterministic keyword/bigram match; a miss means nothing matched). Includes pending memories so you can evaluate them.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword query.' },
      limit: { type: 'number', description: 'Max results (default 5).' },
    },
    output: jsonOutput,
    async execute(args) {
      const hits = await store.recall(args.query, args.limit, { touch: true, includePending: true });
      return hits.map((h) => ({...h.record, score: Number(h.score.toFixed(3)) }));
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

  // ── Model tools: skill crystallization ─────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'crystallize_skill',
    description: 'Crystallize accumulated lesson/decision memories sharing a tag into a reusable SKILL.md (written to the harness skills dir and hot-loaded). Call when the system suggests it, or when you judge a tag represents a genuinely reusable procedure.',
    parameters: {
      tag: { type: 'string', required: true, description: 'The memory tag whose lessons/decisions to crystallize.' },
    },
    output: jsonOutput,
    async execute(args) {
      const ready = store.crystallizationEvidence(cfg.crystallizeKinds, 0);
      // Fallback mirrors crystallizationEvidence's filters (confirmed + not
      // already crystallized) so a second call on the same tag doesn't re-pick
      // stale evidence and returns a consistent, explained refusal.
      const group = ready.find((g) => g.tag === args.tag)
        ?? { tag: args.tag, records: store.list({ pending: false }).filter((r) => r.tags.includes(args.tag) && cfg.crystallizeKinds.includes(r.kind) && !r.crystallizedAt) };
      if (!group.records || group.records.length === 0) {
        return { crystallized: false, reason: `no fresh confirmed lesson/decision memories tagged "${args.tag}" (already crystallized or none confirmed)` };
      }
      const skillName = skillNameFromTag(args.tag);
      const res = writeCrystallizedSkill(skillsDir, skillName, args.tag, group.records, ctx.logger ?? undefined);
      if (!res) return { crystallized: false, reason: 'write skipped (name owned by a non-evolve skill) or failed' };
      await store.markCrystallized(group.records.map((r) => r.id));
      return {
        crystallized: true, skill: res.name, path: res.path, fromRecords: group.records.length,
        note: `🧬 已把 ${group.records.length} 条"${args.tag}"经验结晶为 skill「${res.name}」并写入 ${res.path}，DSH 将自动热加载`,
      };
    },
    presentCall: (args) => present(`🧬 结晶 skill: ${skillNameFromTag(args.tag)}`, 'create', args.tag),
  }));

  ctx.tools.register(defineTool({
    name: 'skill_curator',
    description: 'Report crystallized-skill stats and idle skills (unused >= curatorIdleDays). Never deletes; use for housekeeping decisions.',
    parameters: {},
    output: jsonOutput,
    async execute {
      return {
        crystallizedCount: countCrystallizedSkills(skillsDir),
        idle: idleCrystallizedSkills(skillsDir, cfg.curatorIdleDays),
        skillsDir,
      };
    },
    presentCall:  => present('🧹 skill 养护报告', 'read'),
  }));

  // ── Per-step relevant recall injection (zero-token, repeat-suppressed) ──
  let lastInjectedKey = '';
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next;
    if (decision?.kind !== 'enter') return decision;
    // Surface a just-committed memory checkpoint as one visible line (once).
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

  // ── turn/end -> git checkpoint + deterministic crystallization suggestion ─
  let lastSuggestedTag = '';
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    // git checkpoint is scheduled inside the store on writes; here we only
    // run the deterministic crystallization check and (once) nudge the model.
    try {
      const ready = store.crystallizationEvidence(cfg.crystallizeKinds, cfg.crystallizeMinImportance);
      if (ready.length === 0) return;
      const pick = ready[0];
      if (pick.tag === lastSuggestedTag) return;
      lastSuggestedTag = pick.tag;
      const initiator = ctx.get?.('agents')?.currentInitiator?.;
      const agent = initiator?.agent ?? session?.agent;
      agent?.inject?.(createUserMessage({
        content: [{ type: 'text', text: `【dsh-evolve】🧬 标签「${pick.tag}」已积累 ${pick.records.length} 条高价值 lesson/decision，可考虑用 crystallize_skill(tag="${pick.tag}") 固化成可复用 skill（仅当它确实是可复用流程时）。` }],
        source: { kind: 'plugin', plugin: name, form: 'notice' },
      }));
    } catch { /* best-effort — never break turn/end */ }
  });

  ctx.logger?.info?.(`[dsh-evolve] ready (workspace=${workspaceDir}, skillsDir=${skillsDir})`);
}

export default { name, inject, apply };
