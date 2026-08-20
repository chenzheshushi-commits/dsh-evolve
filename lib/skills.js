/**
 * Skill crystallization + light curator.
 *
 * DESIGN (the piece the retrieval layer alone does not provide):
 *  - Crystallization TRIGGER is deterministic (zero LLM): store.crystallizationEvidence
 *    finds tags with enough high-value lesson/decision records. When a tag is
 *    ready, we queue a nudge to the CURRENT model (reusing the live turn) to
 *    author a SKILL.md via the crystallize_skill tool — no extra API call.
 *  - WRITING a skill = writing ~/.dsh/skills/<name>/SKILL.md. That's the entire
 *    "sink". DSH's own dsh-skill-filesystem watches that dir (chokidar) and
 *    hot-loads it; the `skill` tool then lists+loads it. So CALL / MANAGE /
 *    HOT-RELOAD are 100% reused from the platform — we only produce the file.
 *  - Light curator: usage sidecar (usage.json) tracks per-skill write time; a
 *    deterministic idle check can flag stale crystallized skills (never deletes;
 *    archive is the max action,.
 *
 * No LLM, no session-log writes.
 *
 * @module dsh-evolve/skills
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Deterministic short hash of a string -> base36, ~5 chars. Zero-dep (FNV-1a).
 * Used to keep skill names unique across tags whose ASCII parts collide or are
 * empty (e.g. Chinese tags), without pulling in a transliteration dependency.
 */
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

/**
 * DSH-legal skill name derived from a memory tag.
 *
 * DSH requires names to match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (lowercase ASCII +
 * hyphens; skill-filesystem silently ignores files whose name is invalid).
 * A tag may be non-ASCII (Chinese) or share its ASCII part with another tag,
 * so a naive strip collapses distinct tags to the same name (or to bare
 * "skill"). Rule:
 *   1. take the lowercase ASCII-alnum skeleton of the tag (kebab-joined),
 *   2. ALWAYS suffix a short deterministic hash of the ORIGINAL tag, so
 *      distinct tags never collide and the name is stable across runs,
 *   3. if no ASCII survives (pure-CJK tag), use `skill-<hash>` — still unique
 *      per tag, never a bare "skill".
 * The human-readable original tag is preserved in the SKILL.md description.
 */
export function skillNameFromTag(tag) {
  const raw = String(tag);
  const skeleton = raw.toLowerCase.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const hash = shortHash(raw);
  const name = skeleton.length > 0 ? `${skeleton}-${hash}` : `skill-${hash}`;
  // Defensive: guarantee the result is DSH-legal no matter what.
  return NAME_RE.test(name) ? name : `skill-${hash}`;
}

/** Build a valid SKILL.md body from crystallization evidence (deterministic). */
export function renderSkillMd(name, tag, records) {
  const desc = `Crystallized from ${records.length} memory records tagged "${tag}". Use when a task relates to: ${tag}.`;
  const safeDesc = desc.replace(/\n/g, ' ').slice(0, 1000);
  const lessons = records.filter((r) => r.kind === 'lesson');
  const decisions = records.filter((r) => r.kind === 'decision');
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(safeDesc)}`,
    'version: 1.0.0',
    'author: dsh-evolve (crystallized)',
    'license: MIT',
    '---',
    '',
    `# ${name}`,
    '',
    `> Auto-crystallized by dsh-evolve from memory tag \`${tag}\`.`,
    '> Deterministic seed — refine the prose freely; it is a normal SKILL.md now.',
    '',
  ];
  if (decisions.length > 0) {
    lines.push('## Decisions', '');
    for (const r of decisions) lines.push(`- ${r.content.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  if (lessons.length > 0) {
    lines.push('## Lessons', '');
    for (const r of lessons) lines.push(`- ${r.content.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  lines.push('## Source memory ids', '', records.map((r) => `- ${r.id} (${r.kind}, imp${r.importance})`).join('\n'), '');
  return lines.join('\n');
}

/**
 * Write a crystallized SKILL.md into the skills dir DSH watches.
 * Returns { name, path } on success, or null on failure (never throws).
 * Won't clobber a user-authored skill of the same name (checks a marker).
 */
export function writeCrystallizedSkill(skillsDir, name, tag, records, logger = { warn {} }) {
  try {
    const dir = join(skillsDir, name);
    const file = join(dir, 'SKILL.md');
    if (existsSync(file)) {
      const cur = readFileSync(file, 'utf8');
      if (!cur.includes('dsh-evolve (crystallized)')) {
        // A human/other skill owns this name — don't overwrite.
        logger.warn(`skill ${name} exists and is not evolve-owned; skipping`);
        return null;
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, renderSkillMd(name, tag, records));
    _touchUsage(skillsDir, name, 'crystallized');
    return { name, path: file };
  } catch (e) {
    logger.warn(`writeCrystallizedSkill failed: ${e?.message ?? e}`);
    return null;
  }
}

// ── Light curator: usage sidecar under the skills dir ────────────────────────
function _usagePath(skillsDir) {
  return join(skillsDir, '.evolve-usage.json');
}
function _readUsage(skillsDir) {
  try { return JSON.parse(readFileSync(_usagePath(skillsDir), 'utf8')); } catch { return {}; }
}
function _touchUsage(skillsDir, name, event) {
  try {
    const u = _readUsage(skillsDir);
    const e = u[name] ?? { createdAt: new Date.toISOString, events: [] };
    e.lastActivityAt = new Date.toISOString;
    e.events = [...(e.events ?? []), { at: e.lastActivityAt, event }].slice(-20);
    u[name] = e;
    writeFileSync(_usagePath(skillsDir), JSON.stringify(u, null, 2));
  } catch { /* best-effort */ }
}

/** Record that a crystallized skill was loaded (called from a hook if wired). */
export function noteSkillUse(skillsDir, name) {
  _touchUsage(skillsDir, name, 'used');
}

/**
 * Deterministic idle report: crystallized skills whose usage.json shows no
 * activity for >= idleDays. Never deletes — returns names for a human/agent to
 * archive..
 */
export function idleCrystallizedSkills(skillsDir, idleDays) {
  const out = [];
  try {
    const u = _readUsage(skillsDir);
    const cutoff = Date.now - idleDays * 24 * 3600 * 1000;
    for (const [name, e] of Object.entries(u)) {
      const last = Date.parse(e.lastActivityAt ?? e.createdAt ?? '');
      if (Number.isFinite(last) && last < cutoff) out.push(name);
    }
  } catch { /* best-effort */ }
  return out;
}

/** Count evolve-owned skills currently on disk (for stats). */
export function countCrystallizedSkills(skillsDir) {
  try {
    let n = 0;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory) continue;
      const f = join(skillsDir, entry.name, 'SKILL.md');
      try { if (statSync(f).isFile && readFileSync(f, 'utf8').includes('dsh-evolve (crystallized)')) n += 1; } catch { /* skip */ }
    }
    return n;
  } catch { return 0; }
}
