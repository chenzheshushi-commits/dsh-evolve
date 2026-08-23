/**
 * Convergence / anti-bloat (v0.4.0 direction 4): the OTHER half of evolution.
 * crystallize/refine only GROW (refine appends `## Refinement vN` forever) —
 * without a converge half the skill library becomes a noise pile. This module
 * DETECTS what should be merged or compacted; it does NOT auto-act.
 *
 * Design (detection always on, mutating actions opt-in):
 *  - Deterministic DETECTION is always on (zero LLM): reuse the bigram/Jaccard
 *    similarity machine (search.js) to find near-duplicate skills, and scan the
 *    embedded state block to find refinement-bloated skills.
 *  - The actual MERGE (LLM umbrella-building) is a separate, opt-in, human-gated
 *    action — never auto-runs. Here we only surface candidates for a nudge / the
 *    web panel, exactly like the crystallize/refine suggestions already do.
 *  - NEVER physically delete a user asset: a real merge = write a new umbrella
 *    skill + archive (reversible) the originals. This module doesn't do that;
 *    it just names the candidates.
 *
 * Only evolve-owned skills are considered (EVOLVE_MARKER) — never touch/merge a
 * human-authored skill of the same topic.
 *
 * @module @local/dsh-evolve/converge
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tokenSetBigram, jaccard } from './search.js';
import { readState } from './skills.js';

const EVOLVE_MARKER = 'dsh-evolve (crystallized)';
const REFINEMENT_RE = /^##\s+Refinement\s+v/gim;

/**
 * Read the usage sidecar (.evolve-usage.json) and return the set of skill names
 * that have been REALLY loaded by the model at least once (a 'used' event, which
 * noteSkillUse records on the platform skill tool/call). Skills absent from this
 * set are "zero-load" — never actually used since crystallization.
 */
function loadedSkillNames(skillsDir) {
  const loaded = new Set();
  try {
    const u = JSON.parse(readFileSync(join(skillsDir, '.evolve-usage.json'), 'utf8'));
    for (const [name, entry] of Object.entries(u)) {
      const events = Array.isArray(entry?.events) ? entry.events : [];
      if (events.some((e) => e?.event === 'used')) loaded.add(name);
    }
  } catch { /* no sidecar yet → everything is zero-load */ }
  return loaded;
}

/**
 * Read every evolve-owned skill's {name, tag, body, refinementCount}. Read-only.
 * body = the SKILL.md with frontmatter/state-block stripped, for similarity.
 */
export function readEvolveSkills(skillsDir) {
  let entries = [];
  try { entries = readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    let md = '';
    try { md = readFileSync(file, 'utf8'); } catch { continue; }
    if (!md.includes(EVOLVE_MARKER)) continue; // only our own skills
    const st = readState(md);
    // Strip frontmatter + state block + refinement headers for a clean body.
    const body = md
      .replace(/^---[\s\S]*?---\n/, '')
      .replace(/<!--dsh-evolve-state:.*?-->/s, '')
      .replace(/^>.*$/gim, '')
      .trim();
    const refinementCount = (md.match(REFINEMENT_RE) || []).length;
    skills.push({ name: entry.name, tag: st?.tag ?? null, body, refinementCount });
  }
  return skills;
}

/**
 * Find near-duplicate skill pairs whose bigram-Jaccard similarity >= threshold.
 * These are merge candidates ("反代超时" vs "网关504"). Read-only, zero LLM.
 * @returns array of {a, b, similarity} sorted by similarity desc.
 */
export function findMergeCandidates(skillsDir, opts = {}) {
  const threshold = opts.mergeSimilarity ?? 0.55;
  const skills = readEvolveSkills(skillsDir);
  const loaded = loadedSkillNames(skillsDir);
  const withTokens = skills.map((s) => ({ ...s, tokens: tokenSetBigram(s.body) }));
  const pairs = [];
  for (let i = 0; i < withTokens.length; i += 1) {
    for (let j = i + 1; j < withTokens.length; j += 1) {
      const sim = jaccard(withTokens[i].tokens, withTokens[j].tokens);
      if (sim >= threshold) {
        // Zero-load signal (memo: "zero-load + high-overlap = top merge candidate").
        // A pair where at least one side was never actually loaded is the
        // strongest candidate — duplicated AND unused.
        const aLoaded = loaded.has(withTokens[i].name);
        const bLoaded = loaded.has(withTokens[j].name);
        const zeroLoadCount = (aLoaded ? 0 : 1) + (bLoaded ? 0 : 1);
        pairs.push({
          a: withTokens[i].name, b: withTokens[j].name,
          similarity: Number(sim.toFixed(3)),
          zeroLoadCount, // 0=both used, 1=one unused, 2=both unused
        });
      }
    }
  }
  // Sort: more zero-load first (unused dupes are the priority), then similarity.
  pairs.sort((x, y) => (y.zeroLoadCount - x.zeroLoadCount) || (y.similarity - x.similarity));
  return pairs;
}

/**
 * Find skills bloated by too many appended `## Refinement vN` sections — the
 * self-inflicted bloat source. These are candidates for the "fold refinements
 * back into a clean body" LLM pass (opt-in). Read-only.
 * @returns array of {name, refinementCount} over the threshold, sorted desc.
 */
export function findRefinementBloat(skillsDir, opts = {}) {
  const maxRefinements = opts.maxRefinements ?? 4;
  return readEvolveSkills(skillsDir)
    .filter((s) => s.refinementCount >= maxRefinements)
    .map((s) => ({ name: s.name, refinementCount: s.refinementCount }))
    .sort((a, b) => b.refinementCount - a.refinementCount);
}

/**
 * One-shot convergence report for the turn/end nudge + web panel. Pure detection,
 * no mutation. Returns the top merge candidate + bloated skills so the caller can
 * surface a single actionable suggestion.
 */
export function convergenceReport(skillsDir, opts = {}) {
  const mergeCandidates = findMergeCandidates(skillsDir, opts);
  const bloated = findRefinementBloat(skillsDir, opts);
  return {
    mergeCandidates,
    bloated,
    topMerge: mergeCandidates[0] ?? null,
    hasSuggestions: mergeCandidates.length > 0 || bloated.length > 0,
  };
}

/**
 * Read one evolve-owned skill's full text + parsed state. Returns null if the
 * named skill isn't evolve-owned (never touch human skills). Read-only.
 */
export function readEvolveSkill(skillsDir, name) {
  const file = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file)) return null;
  let md = '';
  try { md = readFileSync(file, 'utf8'); } catch { return null; }
  if (!md.includes(EVOLVE_MARKER)) return null;
  return { name, md, state: readState(md) };
}

/**
 * Assemble the raw text handed to the LLM when MERGING several skills into one
 * umbrella. Deterministic; the caller runs the LLM (or falls back to this text
 * verbatim as the merged body when no LLM is available).
 */
export function buildMergeInput(skills) {
  return skills.map((s) => `### From skill "${s.name}"\n${s.body}`).join('\n\n');
}

/**
 * Extract the clean pre-refinement body of a skill (everything before the first
 * `## Refinement vN` header). Used by fold_skill: the LLM re-distills the whole
 * thing, but if the LLM is unavailable we at least keep the original body and
 * drop nothing — folding is best-effort and never destructive.
 */
export function bodyBeforeRefinements(md) {
  const idx = String(md).search(/^##\s+Refinement\s+v/im);
  if (idx < 0) return null; // no refinements to fold
  return String(md).slice(0, idx).trim();
}

