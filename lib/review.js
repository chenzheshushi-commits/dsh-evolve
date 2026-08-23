/**
 * Background review (v0.4.0 direction 3): after every turn (throttled), run an
 * ISOLATED LLM pass that replays the turn's conversation snapshot and asks
 * "anything worth remembering here?" — then routes each suggestion through the
 * SAME store.remember path (so the tiered adjudicator from direction 1 decides
 * auto vs pending). Modeled on Hermes agent/background_review.py.
 *
 * WHY (user's original pain): "现有功能不会自行总结进化，需要人提示." This makes
 * the plugin observe every turn on its own instead of waiting to be told.
 *
 * DESIGN (each point maps to a Hermes-verified property):
 *  1. ISOLATED: uses ctx.llm.stream() as a standalone auxiliary call (same path
 *     llm-refine.js already uses in production). The MAIN conversation context
 *     and its prompt cache are NEVER touched — we never inject the review into
 *     the live turn. This is what makes "review every turn" affordable.
 *  2. SNAPSHOT FROM OUR OWN BUFFER: turn/end events carry only {turn, reason},
 *     not messages. So a lightweight collector accumulates this turn's
 *     user+assistant text IN MEMORY as it streams (zero injection, no cache
 *     touch), and the review consumes that buffer. This is the "observe during,
 *     land at the boundary" split from the v0.4.0 memo.
 *  3. THROTTLED: runs at most every reviewEveryTurns turns (default 5), via a
 *     turn-count stamp — NOT a timer (honors the edge-plugin "no setInterval"
 *     rule).
 *  4. TOOL-LOCKED BY CONSTRUCTION: this is a plain text llm.stream() call with
 *     NO tools registered to it. The model can only EMIT suggestions as text;
 *     our deterministic code parses them and does the writing (through the
 *     adjudicator). The model never writes directly. Safer than Hermes's fork
 *     (which grants a tool whitelist) — here the write path is entirely ours.
 *  5. WEAK-MODEL DEFENSE (3 layers, per the model-agnostic ironclad rule):
 *     (a) prompt anti-footgun: explicit "only durable, user-anchored facts; if
 *         nothing, say NONE" instructions;
 *     (b) best-effort parse: malformed output → skip this round, never throw,
 *         the worst case is "this round's review produced nothing";
 *     (c) routable model: reviewProvider/reviewModel override, else follow main.
 *
 * PURE-ISH: this module owns the collector + the review call + the parse. It
 * calls back into store.remember for writes. Never throws into the agent loop.
 *
 * @module @local/dsh-evolve/review
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveRefineModel } from './llm-refine.js';

const REVIEW_SYSTEM = [
  'You are a background memory reviewer for an AI agent. You are shown a snapshot',
  'of ONE finished conversation turn (the user messages and the assistant reply).',
  'Your job: extract ONLY durable, cross-session-worthy memories that are clearly',
  'anchored to what the USER stated — stable preferences, corrections, decisions,',
  'environment facts, or a hard-won lesson. Be conservative.',
  '',
  'TWO THINGS ARE WORTH REMEMBERING (both help future sessions):',
  '1. TASK/DOMAIN knowledge — reusable facts, decisions, lessons about the work.',
  '2. USER-PROFILE signals — who this user is and how they work: stable',
  '   preferences (tone, verbosity, language), recurring corrections, their',
  '   domains/projects, working style. These build an evolving picture of the',
  '   user (scope=user). Capture them when the USER reveals them, so the agent',
  '   grows to understand this person over time.',
  '',
  'STRICT RULES (a weak model must still be safe):',
  '- Extract a memory ONLY if it will still matter in a future session.',
  '- Do NOT record transient task state, chit-chat, or your own speculation.',
  '- Do NOT record something the user did not actually say or endorse.',
  '- USER-PROFILE memories use scope=user and kind=preference (or fact); durable',
  '  cross-project traits deserve importance 2-3. Task knowledge uses scope=project.',
  '- If there is nothing worth saving, output exactly: NONE',
  '',
  'OUTPUT FORMAT — zero or more lines, each EXACTLY:',
  'MEM | <kind> | <importance 1-3> | <scope user|project> | <anchored yes|no> | <content>',
  'where kind ∈ fact|preference|decision|lesson|todo|note.',
  'anchored=yes ONLY if the content is directly traceable to a user utterance in',
  'the snapshot (not your inference). Output NOTHING else — no preamble, no prose.',
].join('\n');

const VALID_KINDS = new Set(['fact', 'preference', 'decision', 'lesson', 'todo', 'note']);
const VALID_SCOPES = new Set(['user', 'project']);

/**
 * Per-turn conversation snapshot collector. Accumulates user + assistant text
 * IN MEMORY only. Reset at each turn boundary after review consumes it. Never
 * injects, never persists, never touches the prompt cache.
 */
export class TurnSnapshotCollector {
  constructor(opts = {}) {
    this.maxChars = opts.maxChars ?? 12000;
    this._parts = [];
    this._used = 0;
  }

  /** Append a piece of the current turn. role: 'user' | 'assistant'. */
  add(role, text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    if (this._used >= this.maxChars) return;
    const line = `${role === 'user' ? 'USER' : 'ASSISTANT'}: ${t}`;
    this._parts.push(line);
    this._used += line.length + 1;
  }

  /** Non-empty if we captured anything this turn. */
  get hasContent() { return this._parts.length > 0; }

  /** Snapshot text (bounded), then callers typically reset(). */
  snapshot() { return this._parts.join('\n').slice(0, this.maxChars); }

  reset() { this._parts = []; this._used = 0; }
}

/**
 * Parse the reviewer's output into memory-suggestion objects. Tolerant: bad
 * lines are skipped, not fatal. Strips <think> chain-of-thought (some models
 * leak it) before parsing — same defense llm-refine.parseRefineResponse uses.
 * @returns array of {content, kind, importance, scope, anchoredToUser}
 */
export function parseReviewOutput(text) {
  const raw = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
  if (raw === '' || /^NONE\b/i.test(raw)) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('MEM')) continue;
    const parts = l.split('|').map((p) => p.trim());
    // MEM | kind | importance | scope | anchored | content
    if (parts.length < 6) continue;
    const kind = parts[1].toLowerCase();
    const importance = Math.round(Number(parts[2]));
    const scope = parts[3].toLowerCase();
    const anchored = /^y(es)?$/i.test(parts[4]);
    const content = parts.slice(5).join('|').trim(); // content may contain '|'
    if (!VALID_KINDS.has(kind)) continue;
    if (!VALID_SCOPES.has(scope)) continue;
    if (!Number.isFinite(importance) || importance < 1 || importance > 3) continue;
    if (content === '') continue;
    out.push({ content, kind, importance, scope, anchoredToUser: anchored });
  }
  return out;
}

/**
 * Run one isolated review over a snapshot. Returns the parsed suggestions, or
 * [] on any failure (best-effort; never throws). Does NOT write — the caller
 * routes suggestions through store.remember so the adjudicator gates them.
 *
 * @param ctx    plugin ctx (needs ctx.llm)
 * @param exec   execution ctx (for resolveRefineModel: follows main model)
 * @param snapshot  the turn snapshot text
 * @param cfg    plugin config (reviewProvider/reviewModel/reviewMaxTokens)
 * @param logger
 * @returns {suggestions, elapsedMs, llmCalled}
 */
export async function runReview(ctx, exec, { snapshot, cfg, logger }) {
  const log = logger ?? { warn() {}, info() {} };
  const t0 = Date.now();
  try {
    const llm = ctx?.llm ?? ctx?.get?.('llm');
    if (!llm || typeof llm.stream !== 'function') return { suggestions: [], elapsedMs: 0, llmCalled: false };
    const text = String(snapshot ?? '').trim();
    if (text === '') return { suggestions: [], elapsedMs: 0, llmCalled: false };

    // Model precedence: explicit review override ?? main model ?? agent default.
    // reviewProvider/reviewModel mirror refineProvider/refineModel; when empty,
    // resolveRefineModel follows the current main model.
    const target = resolveRefineModel(exec, {
      refineProvider: cfg.reviewProvider ?? '',
      refineModel: cfg.reviewModel ?? '',
    });
    if (!target) { log.warn?.('[dsh-evolve] runReview: no resolvable model; skipping'); return { suggestions: [], elapsedMs: 0, llmCalled: false }; }

    const messages = [createUserMessage({
      content: [{ type: 'text', text: `Conversation turn snapshot:\n\n${text}` }],
      source: { kind: 'plugin', plugin: '@local/dsh-evolve', form: 'notice' },
    })];
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      system: REVIEW_SYSTEM, // plain string (GenerateOptions.system is not a block array)
      maxTokens: cfg.reviewMaxTokens ?? 1200,
      purpose: 'memory-review',
    };
    const sid = exec?.agent?.session?.id;
    if (sid !== undefined) options.sessionId = sid;

    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream(options)) assembler.push(chunk);
    if (assembler.finish?.kind === 'error') {
      log.warn?.(`[dsh-evolve] runReview: stream error (${assembler.finish?.failure?.code ?? 'unknown'}); skipping`);
      return { suggestions: [], elapsedMs: Date.now() - t0, llmCalled: true };
    }
    let raw = '';
    for (const block of assembler.blocks()) {
      if (block?.type === 'text' && typeof block.text === 'string') raw += block.text;
    }
    const suggestions = parseReviewOutput(raw);
    return { suggestions, elapsedMs: Date.now() - t0, llmCalled: true };
  } catch (e) {
    log.warn?.(`[dsh-evolve] runReview failed (${e?.message ?? e}); skipping this round`);
    return { suggestions: [], elapsedMs: Date.now() - t0, llmCalled: false };
  }
}
