/**
 * Optional LLM refinement pass for crystallize/refine (v0.3.0).
 *
 * PURPOSE: the deterministic crystallizer (skills.js) assembles SKILL.md by
 * concatenating raw memory records — correct but reads like a log. When the user
 * opts in (cfg.refineLLM), we route the raw evidence through ONE auxiliary
 * ctx.llm.stream() call to distill it into a structured SKILL.md body (dedupe,
 * group, rewrite as steps + pitfalls) — closing the quality gap to Hermes skills.
 *
 * EFFICIENCY (consistent with Hermes auxiliary tasks):
 *  - single call, on-demand (only at crystallize/refine — maybe 0×/session)
 *  - reuses the provider's warm prefix cache via ctx.llm.stream (same path
 *    dsh-compaction-basic uses for summarization)
 *  - never in a per-step / per-turn path
 *  - MODEL FOLLOWS MAIN: provider/model default to the session's current main
 *    model (agent.session.requestHeader().config); an explicit config override
 *    (from the settings dropdown) wins; falls back to agent options. This is the
 *    exact precedence dsh-compaction-basic uses — no hardcoded model.
 *
 * SAFETY: any failure (no llm service, no resolvable model, stream error, empty
 * output) returns null so the caller falls back to the deterministic assembly.
 * Never throws into crystallize/refine.
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

const SYSTEM_INSTRUCTION = [
  'You are refining raw agent-memory notes into a single high-quality skill document (Markdown).',
  'Output EXACTLY in this shape, nothing before or after:',
  'NAME: <kebab-case skill name: lowercase ASCII words joined by hyphens, 2-5 words, describes the FUNCTION, e.g. "reverse-proxy-timeout" or "wsl-memory-diagnosis". No spaces, no CJK, no version, no file extension.>',
  'DESC: <one line, English or Chinese, starting with "Use when …" then the behavior, ≤ 200 chars. Describe WHAT the skill helps with, not "records tagged X".>',
  'BODY:',
  '<the Markdown body below this line>',
  '',
  'Body rules:',
  '- Deduplicate and merge overlapping points.',
  '- Organize into clear sections: a one-line summary, then Steps and/or Pitfalls as appropriate.',
  '- Preserve every concrete fact, command, path, number, and named entity verbatim — do NOT invent.',
  '- Keep it tight and skimmable. No preamble, no meta-commentary.',
  '- Do NOT write YAML frontmatter or a top-level H1 title (the caller adds those).',
].join('\n');

/**
 * Parse the structured LLM response into {name, description, body}.
 * Tolerant: any missing field comes back undefined (caller falls back per-field).
 * If no NAME:/DESC:/BODY: markers are present at all, treat the whole thing as body
 * (back-compat with the old body-only prompt).
 */
export function parseRefineResponse(text) {
  // Strip any reasoning/thinking blocks the model may emit before the answer.
  // Some models (incl. MiniMax) wrap chain-of-thought in <think>…</think>; if it
  // leaks into the body it pollutes the whole SKILL.md (observed in dsh-1j94xi).
  const raw = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')   // unclosed think block: drop to end
    .trim();
  const nameM = raw.match(/^\s*NAME:\s*(.+?)\s*$/m);
  const descM = raw.match(/^\s*DESC:\s*(.+?)\s*$/m);
  const bodyM = raw.match(/^\s*BODY:\s*\n?([\s\S]*)$/m);
  const hasMarkers = Boolean(nameM || descM || bodyM);
  if (!hasMarkers) {
    const body = raw.trim();
    return { name: undefined, description: undefined, body: body || undefined };
  }
  const body = (bodyM ? bodyM[1] : '').trim();
  return {
    name: nameM ? nameM[1].trim() : undefined,
    description: descM ? descM[1].trim() : undefined,
    body: body || undefined,
  };
}

/**
 * Resolve the target model with the compaction-basic precedence:
 *   explicit config override ?? current main model (request header) ?? agent options.
 * Returns {provider, model} or null if none resolvable.
 */
export function resolveRefineModel(exec, cfg) {
  const configured = (cfg.refineProvider && cfg.refineModel)
    ? { provider: cfg.refineProvider, model: cfg.refineModel }
    : undefined;
  const agent = exec?.agent;
  let latest;
  try {
    const hdr = agent?.session?.requestHeader?.();
    if (hdr?.config?.provider && hdr?.config?.model) {
      latest = { provider: hdr.config.provider, model: hdr.config.model };
    }
  } catch { /* ignore */ }
  let agentTarget;
  const opts = agent?.options;
  if (opts?.provider && opts?.model) agentTarget = { provider: opts.provider, model: opts.model };
  return configured ?? latest ?? agentTarget ?? null;
}

/**
 * Distill raw evidence into a structured skill via one LLM call.
 * @returns {Promise<{name?:string, description?:string, body:string}|null>}
 *   parsed fields (name/description may be undefined; body always present), or
 *   null to fall back to fully deterministic assembly. Never throws.
 */
export async function refineWithLLM(ctx, exec, { rawText, kind, tag, cfg, logger }) {
  const log = logger ?? { warn() {} };
  try {
    if (cfg.refineLLM !== true) return null;
    const llm = ctx?.llm ?? ctx?.get?.('llm');
    if (!llm || typeof llm.stream !== 'function') return null;
    const target = resolveRefineModel(exec, cfg);
    if (!target) { log.warn?.('[dsh-evolve] refineWithLLM: no resolvable model, falling back'); return null; }

    const verb = kind === 'refine' ? 'refine the existing skill with the new evidence below' : 'author a new skill from the evidence below';
    const userText = [
      `Task: ${verb}.`,
      `Skill topic (tag): ${tag}`,
      '',
      'Raw evidence (agent memory records):',
      rawText,
    ].join('\n');

    const messages = [createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: '@local/dsh-evolve', form: 'notice' },
    })];

    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      system: SYSTEM_INSTRUCTION,  // GenerateOptions.system is a plain string (not a block array)
      maxTokens: cfg.refineMaxTokens ?? 4000,
      purpose: 'skill-refine',
    };
    const sid = exec?.agent?.session?.id;
    if (sid !== undefined) options.sessionId = sid;

    let out = '';
    // Consume the stream with the canonical BlockAssembler (same as
    // dsh-compaction-basic) instead of guessing chunk shape. Extract text blocks.
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream(options)) assembler.push(chunk);
    if (assembler.finish?.kind === 'error') {
      log.warn?.(`[dsh-evolve] refineWithLLM: stream error (${assembler.finish?.failure?.code ?? 'unknown'}), falling back`);
      return null;
    }
    for (const block of assembler.blocks()) {
      if (block?.type === 'text' && typeof block.text === 'string') out += block.text;
    }
    out = out.trim();
    if (!out) { log.warn?.('[dsh-evolve] refineWithLLM: empty output, falling back'); return null; }
    const parsed = parseRefineResponse(out);
    if (!parsed.body) { log.warn?.('[dsh-evolve] refineWithLLM: no body parsed, falling back'); return null; }
    return parsed;
  } catch (e) {
    log.warn?.(`[dsh-evolve] refineWithLLM failed (${e?.message ?? e}); falling back to deterministic`);
    return null;
  }
}
