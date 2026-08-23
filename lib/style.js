/**
 * Per-skill style overlay (v0.4.0 direction 2B): make a crystallized skill
 * "sound like the user" WITHOUT rewriting it. Instead of mutating SKILL.md
 * (a long-lived asset — risky, lossy, hard to reverse), we attach a small
 * "user-style instructions" OVERLAY as a sidecar file. The overlay is applied
 * when the skill is used; the underlying SKILL.md is never touched.
 *
 * WHY THIS SHAPE (from the v0.4.0 memo, the safer of two routes):
 * Hermes has no "rewrite skill to user style" mechanism, but it DOES model
 * style as a layered instruction (TTS instructions, tone/style fields) rather
 * than by editing content. We follow that: the original skill stays intact =
 * naturally reversible + pluggable. This sidesteps direction 2B's biggest risk
 * (mangling a reusable asset by over-fitting to one user).
 *
 * SAFETY:
 *  - Overlays live under the workspace (evolve-workspace/skill-style/), NEVER in
 *    the DSH-watched skills root — so they don't become discoverable "skills"
 *    and don't touch the catalog.
 *  - Removing an overlay fully restores the vanilla skill (clearStyle).
 *  - Overlays are LOCAL data (like all profile-derived state) — never packaged.
 *
 * @module @local/dsh-evolve/style
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Sidecar dir for style overlays (under workspace, NOT the skills root). */
export function styleDir(workspaceDir) {
  return join(workspaceDir, 'skill-style');
}

function overlayPath(workspaceDir, skillName) {
  return join(styleDir(workspaceDir), `${skillName}.md`);
}

/** Basic guard: skill names are kebab dirs; reject path-traversal / junk. */
const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive a compact style-instructions block from the user profile (direction
 * 2A's profileView output). Deterministic, zero-LLM: turns confirmed user
 * preferences into a short "apply this style" instruction. Returns '' when the
 * profile has nothing style-relevant (so callers can skip attaching an overlay).
 */
export function deriveStyleFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const prefs = (profile.byKind?.preference ?? [])
    .map((r) => ({ content: String(r.content).trim(), confidence: r.confidence, obs: r.observationCount ?? 1 }))
    .filter((r) => r.content);
  if (prefs.length === 0) return '';
  // Reinforced (high-confidence) preferences lead — they're what the user has
  // shown most consistently. A note flags confidence so the model weights them.
  const lines = [
    '# User style overlay (applied by @local/dsh-evolve)',
    '',
    '> When using this skill, adapt your output to the user\'s known preferences',
    '> below (strongest/most-observed first). This overlay does not change the',
    '> skill\'s substance — only how the result is expressed. Remove it anytime to',
    '> restore the vanilla skill.',
    '',
    '## Apply the user\'s style',
  ];
  for (const p of prefs) {
    const tag = p.confidence === 'high' ? ' (consistently observed)' : '';
    lines.push(`- ${p.content}${tag}`);
  }
  return lines.join('\n');
}

/**
 * Attach (or replace) a style overlay for a skill. If `instructions` is empty,
 * this is a no-op that returns {set:false} (never write an empty overlay).
 * Returns {set:true, path} on success.
 */
export function setStyle(workspaceDir, skillName, instructions, logger = { warn() {} }) {
  try {
    if (!SAFE_NAME.test(skillName)) return { set: false, reason: `invalid skill name "${skillName}"` };
    const text = String(instructions ?? '').trim();
    if (text === '') return { set: false, reason: 'empty style instructions; nothing attached' };
    const dir = styleDir(workspaceDir);
    mkdirSync(dir, { recursive: true });
    const path = overlayPath(workspaceDir, skillName);
    writeFileSync(path, `${text}\n`);
    return { set: true, path };
  } catch (e) {
    logger.warn?.(`setStyle failed: ${e?.message ?? e}`);
    return { set: false, reason: e?.message ?? String(e) };
  }
}

/** Read a skill's style overlay, or null if none. */
export function getStyle(workspaceDir, skillName) {
  try {
    if (!SAFE_NAME.test(skillName)) return null;
    const path = overlayPath(workspaceDir, skillName);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

/**
 * Remove a skill's style overlay — fully restores the vanilla skill (the
 * SKILL.md was never touched). Returns {cleared:true|false}.
 */
export function clearStyle(workspaceDir, skillName, logger = { warn() {} }) {
  try {
    if (!SAFE_NAME.test(skillName)) return { cleared: false, reason: `invalid skill name "${skillName}"` };
    const path = overlayPath(workspaceDir, skillName);
    if (!existsSync(path)) return { cleared: false, reason: 'no overlay to clear' };
    rmSync(path, { force: true });
    return { cleared: true };
  } catch (e) {
    logger.warn?.(`clearStyle failed: ${e?.message ?? e}`);
    return { cleared: false, reason: e?.message ?? String(e) };
  }
}

/** List all skills that currently have a style overlay attached. */
export function listStyled(workspaceDir) {
  try {
    const dir = styleDir(workspaceDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}
