/**
 * Skill crystallization + real evolution (refine) + curator lifecycle (v0.2.0).
 *
 * WHAT'S NEW vs v0.1.0 (the three gaps the user called out):
 *
 *  1. CURATOR LIFECYCLE STATE MACHINE (was: report-only, never acted).
 *     Skills now have states: active → stale (idle ≥ staleDays, still loaded) →
 *     archived (moved OUT of the DSH-watched skills root into
 *     evolve-workspace/archived-skills/, so skill-filesystem stops discovering
 *     it — the catalog shrinks). Archiving is REVERSIBLE (restore moves it
 *     back) and never destroys — mirroring Hermes's curator philosophy
 *     (max action = archive). Real usage is tracked from the platform's
 *     `tool/call` events (skill loads), not just creation time.
 *
 *  2. REAL EVOLUTION / refine (was: crystallize = static overwrite).
 *     refineCrystallizedSkill() IMPROVES an existing skill in place: it appends
 *     newly-accumulated evidence as a versioned "## Refinement vN.M" section,
 *     bumps the semver, updates the changelog, and records the new source ids —
 *     WITHOUT overwriting human prose edits. A machine-readable state block
 *     (HTML comment) carries version + sourceIds + refinement history so the
 *     same evidence is never folded in twice. Zero LLM: the improving text is
 *     authored by the CURRENT model via the live turn (same mechanism as
 *     crystallization), never a separate API pass.
 *
 * DSH's own dsh-skill-filesystem still owns load/manage/hot-reload; we only
 * produce/relocate files under the roots it watches. No LLM, no session-log writes.
 *
 * @module @local/dsh-evolve/skills
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
  renameSync, rmSync, cpSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Frontmatter marker proving a skill is evolve-owned (safe to touch/refine/archive). */
const EVOLVE_MARKER = 'dsh-evolve (crystallized)';
/** Single-line machine state block embedded in SKILL.md (survives human prose edits). */
const STATE_RE = /<!--dsh-evolve-state:(.*?)-->/s;

/**
 * Deterministic short hash of a string -> base36, ~6 chars. Zero-dep (FNV-1a).
 * Keeps skill names unique across tags whose ASCII parts collide or are empty
 * (e.g. Chinese tags), without a transliteration dependency.
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
 * DSH-legal skill name derived from a memory tag — READABILITY FIRST.
 *
 * DSH requires names to match /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (skill-filesystem
 * silently ignores invalid names). Previously we ALWAYS suffixed a hash, so a
 * perfectly readable ASCII tag like "dsh" degenerated into "dsh-1j94xi" — the
 * catalog became a wall of meaningless hashes. Fixed: if the tag's ASCII
 * skeleton is already legal & non-empty, use it VERBATIM (`dsh` -> `dsh`,
 * `reverse-proxy` -> `reverse-proxy`). The hash is now a FALLBACK, only for
 * pure-CJK / empty skeletons (`反代` -> `skill-<hash>`, never a bare "skill").
 *
 * NOTE: collision handling no longer lives here — a hash on every name was a
 * crutch for "can't trust the derived name to be unique". Uniqueness is now
 * resolved at creation time by proposeSkillName() (dedupe against existing
 * dirs), and LOCATION is resolved by findSkillByTag() (state-block .tag),
 * so the on-disk name never has to be recomputable from the tag.
 */
export function skillNameFromTag(tag) {
  const raw = String(tag);
  const skeleton = raw.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (skeleton.length > 0 && NAME_RE.test(skeleton)) return skeleton;
  return `skill-${shortHash(raw)}`;
}

/** Coerce an arbitrary string into a DSH-legal skill name, or null if it can't
 * yield anything meaningful. Used to sanitize an LLM-proposed name. */
export function sanitizeSkillName(candidate) {
  const s = String(candidate ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s.length > 0 && NAME_RE.test(s) ? s : null;
}

/**
 * Choose the final on-disk directory name for a NEW crystallized skill.
 * Preference order: sanitized LLM-proposed name -> readable skeleton from tag
 * -> `skill-<hash>`. Then guarantee uniqueness against skills already on disk
 * (active dir): if the chosen name is taken by a DIFFERENT tag, append a short
 * disambiguating hash of the tag. This is the ONLY place a hash may be added
 * for collision reasons — readable names stay readable unless they actually
 * clash.
 *
 * @param {string} skillsDir active skills root (to check existing dirs)
 * @param {string} tag       memory tag being crystallized
 * @param {string=} llmName  optional model-proposed name (sanitized here)
 * @returns {string} a unique, DSH-legal skill name
 */
export function proposeSkillName(skillsDir, tag, llmName) {
  // Idempotent: if this tag already has a skill (under ANY dir name), reuse it.
  const existing = findSkillByTag(skillsDir, tag);
  if (existing) return existing;
  const base = sanitizeSkillName(llmName) ?? skillNameFromTag(tag);
  // If nothing on disk uses this name, take it as-is.
  const dir = join(skillsDir, base, 'SKILL.md');
  if (!existsSync(dir)) return base;
  // Name exists but belongs to a DIFFERENT tag (findSkillByTag already ruled out
  // same-tag above) -> append tag hash to disambiguate.
  const disambig = `${base}-${shortHash(String(tag))}`;
  return NAME_RE.test(disambig) ? disambig : `skill-${shortHash(String(tag))}`;
}

/**
 * Locate an existing evolve-owned skill BY ITS TAG, reading the machine state
 * block's `.tag` field — NOT by recomputing a name from the tag. This is what
 * makes readable/LLM-generated names safe: once a skill is written, its dir
 * name is whatever it is; we always find it back via the tag recorded inside.
 * Returns the on-disk directory name, or null if no evolve-owned skill for the
 * tag exists. Deterministic, read-only.
 */
export function findSkillByTag(skillsDir, tag) {
  let entries = [];
  try { entries = readdirSync(skillsDir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, 'SKILL.md');
    try {
      const md = readFileSync(file, 'utf8');
      if (!md.includes(EVOLVE_MARKER)) continue;
      const st = readState(md);
      if (st?.tag === tag) return entry.name;
    } catch { /* skip unreadable */ }
  }
  return null;
}

// ── State block (machine-readable, embedded, edit-proof) ─────────────────────

/** Parse the embedded state block from SKILL.md text, or null. */
export function readState(md) {
  const m = STATE_RE.exec(String(md));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Render the single-line state comment. */
function renderState(state) {
  return `<!--dsh-evolve-state:${JSON.stringify(state)}-->`;
}

/** Bump the MINOR component of a semver string ("1.0.0" -> "1.1.0"). */
function bumpMinor(version) {
  const parts = String(version ?? '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const [maj = 1, min = 0] = parts;
  return `${maj}.${min + 1}.0`;
}

function nowIso() { return new Date().toISOString(); }
function today() { return nowIso().slice(0, 10); }
function oneLine(s) { return String(s).replace(/\r?\n/g, ' '); }

// ── Rendering ────────────────────────────────────────────────────────────────

function baseDescription(tag, count) {
  return `Crystallized from ${count} memory records tagged "${tag}". Use when a task relates to: ${tag}.`;
}

/** One-line, length-capped description. Prefer an LLM-authored functional
 * description ("Use when …. <behavior>."); fall back to the tag-template. */
function resolveDescription(tag, count, llmDescription) {
  const llm = typeof llmDescription === 'string' ? oneLine(llmDescription).trim() : '';
  const desc = llm.length > 0 ? llm : baseDescription(tag, count);
  return desc.slice(0, 1000);
}

/** Build a valid SKILL.md from crystallization evidence (deterministic, v1.0.0).
 * If `distilledBody` is a non-empty string (from the opt-in LLM refine pass), it
 * REPLACES the deterministic Decisions/Lessons sections — frontmatter, changelog,
 * source ids, and the machine state block are always kept intact.
 * `llmDescription` (optional) supplies a functional one-line description instead
 * of the tag-template. */
export function renderSkillMd(name, tag, records, distilledBody, llmDescription) {
  const version = '1.0.0';
  const safeDesc = resolveDescription(tag, records.length, llmDescription);
  const lessons = records.filter((r) => r.kind === 'lesson');
  const decisions = records.filter((r) => r.kind === 'decision');
  const state = {
    tag,
    version,
    createdAt: nowIso(),
    baseDescription: safeDesc,
    sourceIds: records.map((r) => r.id),
    refinements: [],
  };
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(safeDesc)}`,
    `version: ${version}`,
    `author: ${EVOLVE_MARKER}`,
    'license: MIT',
    '---',
    '',
    `# ${name}`,
    '',
    `> Auto-crystallized by @local/dsh-evolve from memory tag \`${tag}\`.`,
    '> This is a normal SKILL.md now — refine the prose freely. @local/dsh-evolve',
    '> appends future evidence as new "Refinement" sections below and never',
    '> overwrites your edits.',
    '',
  ];
  const distilled = typeof distilledBody === 'string' ? distilledBody.trim() : '';
  if (distilled) {
    lines.push(distilled, '');
  } else {
    if (decisions.length > 0) {
      lines.push('## Decisions', '');
      for (const r of decisions) lines.push(`- ${oneLine(r.content)}`);
      lines.push('');
    }
    if (lessons.length > 0) {
      lines.push('## Lessons', '');
      for (const r of lessons) lines.push(`- ${oneLine(r.content)}`);
      lines.push('');
    }
  }
  lines.push('## Changelog', '', `- v${version} (${today()}): crystallized from ${records.length} memories tagged "${tag}"${distilled ? ' (LLM-distilled)' : ''}`, '');
  lines.push('## Source memory ids', '', records.map((r) => `- ${r.id} (${r.kind}, imp${r.importance})`).join('\n'), '');
  lines.push(renderState(state), '');
  return lines.join('\n');
}

// ── Curator: usage sidecar under the skills dir ──────────────────────────────
function _usagePath(skillsDir) { return join(skillsDir, '.evolve-usage.json'); }
function _readUsage(skillsDir) {
  try { return JSON.parse(readFileSync(_usagePath(skillsDir), 'utf8')); } catch { return {}; }
}
function _touchUsage(skillsDir, name, event) {
  try {
    const u = _readUsage(skillsDir);
    const e = u[name] ?? { createdAt: nowIso(), events: [] };
    e.lastActivityAt = nowIso();
    e.events = [...(e.events ?? []), { at: e.lastActivityAt, event }].slice(-20);
    u[name] = e;
    writeFileSync(_usagePath(skillsDir), JSON.stringify(u, null, 2));
  } catch { /* best-effort */ }
}

/** Record that a crystallized skill was loaded (called from the tool/call hook). */
export function noteSkillUse(skillsDir, name) {
  _touchUsage(skillsDir, name, 'used');
}

// ── Write / refine ───────────────────────────────────────────────────────────

/** Is this SKILL.md file evolve-owned (safe to refine/archive)? */
function isEvolveOwned(file) {
  try { return readFileSync(file, 'utf8').includes(EVOLVE_MARKER); } catch { return false; }
}

/**
 * Write a fresh crystallized SKILL.md into the skills dir DSH watches.
 * Returns { name, path, version } on success, or null (never throws).
 * Won't clobber a skill of the same name that isn't evolve-owned.
 */
export function writeCrystallizedSkill(skillsDir, name, tag, records, logger = { warn() {} }, distilledBody, llmDescription) {
  try {
    const dir = join(skillsDir, name);
    const file = join(dir, 'SKILL.md');
    if (existsSync(file) && !isEvolveOwned(file)) {
      logger.warn?.(`skill ${name} exists and is not evolve-owned; skipping`);
      return null;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, renderSkillMd(name, tag, records, distilledBody, llmDescription));
    _touchUsage(skillsDir, name, 'crystallized');
    return { name, path: file, version: '1.0.0' };
  } catch (e) {
    logger.warn?.(`writeCrystallizedSkill failed: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * REAL EVOLUTION: refine an existing evolve-owned skill in place with newly
 * accumulated evidence — additive, human-edit-preserving, versioned.
 *
 *  - Reads the current SKILL.md + its state block.
 *  - Folds in ONLY records not already in sourceIds (never double-counts).
 *  - Appends a "## Refinement vN.M" section (new decisions/lessons) to the body,
 *    bumps the frontmatter semver (minor), adds a changelog line, and rewrites
 *    the state block (new version + refinement entry + extended sourceIds).
 *  - Everything the human wrote above stays byte-for-byte intact.
 *
 * Returns { name, path, version, added, refined:true } | { refined:false, reason }
 * | null (I/O failure). Never throws.
 */
export function refineCrystallizedSkill(skillsDir, name, tag, records, logger = { warn() {} }, distilledBody) {
  try {
    const dir = join(skillsDir, name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) return { refined: false, reason: `skill "${name}" not found (crystallize it first)` };
    const md = readFileSync(file, 'utf8');
    if (!md.includes(EVOLVE_MARKER)) {
      logger.warn?.(`skill ${name} is not evolve-owned; refusing to refine`);
      return { refined: false, reason: `skill "${name}" is not evolve-owned` };
    }
    const state = readState(md) ?? {
      tag, version: '1.0.0', createdAt: nowIso(), baseDescription: baseDescription(tag, records.length),
      sourceIds: [], refinements: [],
    };
    const known = new Set(state.sourceIds ?? []);
    const fresh = records.filter((r) => !known.has(r.id));
    if (fresh.length === 0) {
      return { refined: false, reason: `no new evidence for "${name}" (all ${records.length} records already folded in)` };
    }
    const newVersion = bumpMinor(state.version);
    const decisions = fresh.filter((r) => r.kind === 'decision');
    const lessons = fresh.filter((r) => r.kind === 'lesson');

    // Build the refinement section (appended to the END of the human-editable body).
    const sec = [
      '',
      `## Refinement v${newVersion} (${today()})`,
      '',
      '> New evidence auto-appended by @local/dsh-evolve. Fold into the prose above when convenient.',
      '',
    ];
    const distilled = typeof distilledBody === 'string' ? distilledBody.trim() : '';
    if (distilled) {
      sec.push(distilled, '');
    } else {
      if (decisions.length > 0) {
        sec.push('### New decisions', '');
        for (const r of decisions) sec.push(`- ${oneLine(r.content)}`);
        sec.push('');
      }
      if (lessons.length > 0) {
        sec.push('### New lessons', '');
        for (const r of lessons) sec.push(`- ${oneLine(r.content)}`);
        sec.push('');
      }
    }
    sec.push(`_source: ${fresh.map((r) => r.id).join(', ')}_`, '');

    // Split off the trailing state block; body = everything the human owns.
    let body = md.replace(STATE_RE, '').replace(/\s+$/, '');
    body = `${body}\n${sec.join('\n')}`;

    // Insert a changelog line under an existing "## Changelog", else append one.
    const changelogLine = `- v${newVersion} (${today()}): refined with ${fresh.length} new ${decisions.length ? 'decision' : ''}${decisions.length && lessons.length ? '/' : ''}${lessons.length ? 'lesson' : ''} memories`;
    if (/^##\s+Changelog\s*$/m.test(body)) {
      body = body.replace(/(^##\s+Changelog\s*$\n\n?)/m, `$1${changelogLine}\n`);
    } else {
      body = `${body}\n## Changelog\n\n${changelogLine}\n`;
    }

    // Bump frontmatter version + description refinement suffix.
    body = body.replace(/^version:\s*.*$/m, `version: ${newVersion}`);
    const refineCount = (state.refinements?.length ?? 0) + 1;
    const desc = `${state.baseDescription ?? baseDescription(tag, records.length)} · refined v${newVersion} (${refineCount} refinement${refineCount === 1 ? '' : 's'})`;
    body = body.replace(/^description:\s*.*$/m, `description: ${JSON.stringify(oneLine(desc).slice(0, 1000))}`);

    const nextState = {
      ...state,
      tag: state.tag ?? tag,
      version: newVersion,
      sourceIds: [...(state.sourceIds ?? []), ...fresh.map((r) => r.id)],
      refinements: [...(state.refinements ?? []), { version: newVersion, at: nowIso(), addedIds: fresh.map((r) => r.id) }],
    };
    const out = `${body.replace(/\s+$/, '')}\n\n${renderState(nextState)}\n`;
    writeFileSync(file, out);
    _touchUsage(skillsDir, name, `refined:v${newVersion}`);
    return { name, path: file, version: newVersion, added: fresh.length, refined: true };
  } catch (e) {
    logger.warn?.(`refineCrystallizedSkill failed: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * FOLD (v0.4.0 direction 4, anti-bloat): REPLACE a bloated skill's body with a
 * clean re-distilled version (from the LLM), collapsing the accumulated
 * `## Refinement vN` sections back into coherent prose. Unlike refine (additive),
 * this is a rewrite — so it:
 *   - preserves frontmatter + the EVOLVE_MARKER header block,
 *   - bumps the minor version, records a fold entry in the state block, and
 *     keeps sourceIds intact (evidence provenance is not lost),
 *   - marks the state `.folded` so we can tell folded skills apart.
 * Caller MUST have taken a backupSkill() first (fold is a rewrite; rollback via
 * skill_rollback). Returns { name, path, version, folded:true } | {folded:false}
 * | null. Never throws.
 */
export function foldSkillBody(skillsDir, name, foldedBody, logger = { warn() {} }) {
  try {
    const dir = join(skillsDir, name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) return { folded: false, reason: `skill "${name}" not found` };
    const md = readFileSync(file, 'utf8');
    if (!md.includes(EVOLVE_MARKER)) return { folded: false, reason: `skill "${name}" is not evolve-owned` };
    const clean = typeof foldedBody === 'string' ? foldedBody.trim() : '';
    if (clean === '') return { folded: false, reason: 'empty folded body; refusing to overwrite' };
    const state = readState(md);
    if (!state) return { folded: false, reason: 'no state block; refusing to fold' };
    const newVersion = bumpMinor(state.version);

    // Preserve frontmatter (--- ... ---) and the leading quote/header block; only
    // the prose body is replaced. Grab everything up to the first H1 or blank
    // after frontmatter as the header, then swap the rest for the clean body.
    const fmMatch = md.match(/^---[\s\S]*?---\n/);
    const frontmatter = fmMatch ? fmMatch[0] : '';
    // Rebuild: frontmatter + H1 title + provenance quote + clean body + changelog + state.
    const h1Match = md.match(/^#\s+.*$/m);
    const h1 = h1Match ? h1Match[0] : `# ${name}`;
    const provenance = [
      '',
      `> Auto-crystallized by @local/dsh-evolve (folded v${newVersion}).`,
      '> Refinement sections were distilled back into the body below. @local/dsh-evolve',
      '',
    ].join('\n');
    let body = `${frontmatter}${h1}\n${provenance}\n${clean}\n`;
    body = body.replace(/^version:\s*.*$/m, `version: ${newVersion}`);
    const changelogLine = `- v${newVersion} (${today()}): folded refinement sections back into a clean body`;
    if (/^##\s+Changelog\s*$/m.test(body)) {
      body = body.replace(/(^##\s+Changelog\s*$\n\n?)/m, `$1${changelogLine}\n`);
    } else {
      body = `${body}\n## Changelog\n\n${changelogLine}\n`;
    }
    const nextState = {
      ...state,
      version: newVersion,
      folded: true,
      refinements: [...(state.refinements ?? []), { version: newVersion, at: nowIso(), folded: true }],
    };
    const out = `${body.replace(/\s+$/, '')}\n\n${renderState(nextState)}\n`;
    writeFileSync(file, out);
    _touchUsage(skillsDir, name, `folded:v${newVersion}`);
    return { name, path: file, version: newVersion, folded: true };
  } catch (e) {
    logger.warn?.(`foldSkillBody failed: ${e?.message ?? e}`);
    return null;
  }
}

// ── Lifecycle: active → stale → archived (reversible, never destroys) ─────────

/** Move a directory, falling back to copy+remove across filesystems (EXDEV). */
function moveDir(src, dst) {
  mkdirSync(join(dst, '..'), { recursive: true });
  try {
    renameSync(src, dst);
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    cpSync(src, dst, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Archive an evolve-owned skill: move it OUT of the DSH-watched skills root into
 * archiveDir (evolve-workspace/archived-skills/). skill-filesystem stops
 * discovering it → the model's catalog shrinks. Fully reversible via restore.
 * Returns { archived:true, name, from, to } | { archived:false, reason }.
 */
export function archiveSkill(skillsDir, archiveDir, name, logger = { warn() {} }) {
  try {
    if (!NAME_RE.test(name)) return { archived: false, reason: `invalid skill name "${name}"` };
    const src = join(skillsDir, name);
    const file = join(src, 'SKILL.md');
    if (!existsSync(file)) return { archived: false, reason: `active skill "${name}" not found` };
    if (!isEvolveOwned(file)) return { archived: false, reason: `skill "${name}" is not evolve-owned; refusing to archive` };
    const dst = join(archiveDir, name);
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    mkdirSync(archiveDir, { recursive: true });
    // Pre-mutation tar.gz safety net (mirror of Hermes curator's pre-run backup).
    try { backupSkill(skillsDir, archiveDir, name, 'archive'); } catch { /* best-effort */ }
    moveDir(src, dst);
    _touchUsage(skillsDir, name, 'archived');
    return { archived: true, name, from: src, to: dst };
  } catch (e) {
    logger.warn?.(`archiveSkill failed: ${e?.message ?? e}`);
    return { archived: false, reason: String(e?.message ?? e) };
  }
}

/**
 * Restore an archived skill back into the watched skills root (re-discovered).
 * Returns { restored:true, name, to } | { restored:false, reason }.
 */
export function restoreSkill(skillsDir, archiveDir, name, logger = { warn() {} }) {
  try {
    if (!NAME_RE.test(name)) return { restored: false, reason: `invalid skill name "${name}"` };
    const src = join(archiveDir, name);
    if (!existsSync(join(src, 'SKILL.md'))) return { restored: false, reason: `archived skill "${name}" not found` };
    const dst = join(skillsDir, name);
    if (existsSync(dst)) return { restored: false, reason: `an active skill "${name}" already exists` };
    mkdirSync(skillsDir, { recursive: true });
    moveDir(src, dst);
    _touchUsage(skillsDir, name, 'restored');
    return { restored: true, name, to: dst };
  } catch (e) {
    logger.warn?.(`restoreSkill failed: ${e?.message ?? e}`);
    return { restored: false, reason: String(e?.message ?? e) };
  }
}

/**
 * tar.gz snapshot of one skill dir into evolve-workspace/.curator-backups/<ts>/,
 * taken before a destructive op (archive/refine). Mirror of Hermes curator's
 * pre-run backup. Best-effort: uses system tar via execFileSync (no shell).
 * Returns the backup file path, or null if tar unavailable / skill missing.
 */
export function backupSkill(skillsDir, archiveDir, name, reason = 'op') {
  if (!NAME_RE.test(name)) return null;
  const srcDir = join(skillsDir, name);
  if (!existsSync(join(srcDir, 'SKILL.md'))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const backupRoot = join(archiveDir, '..', '.curator-backups', `${stamp}-${reason}`);
  mkdirSync(backupRoot, { recursive: true });
  const out = join(backupRoot, `${name}.tgz`);
  // tar -C <skillsDir> -czf <out> <name>  (relative entry so restore is clean)
  execFileSync('tar', ['-C', skillsDir, '-czf', out, name], { stdio: 'ignore' });
  return out;
}

/**
 * Restore a skill from its most-recent tar.gz backup back into the watched
 * skills root. Returns { restored:true, name, from } | { restored:false, reason }.
 */
export function restoreFromBackup(skillsDir, archiveDir, name, logger = { warn() {} }) {
  try {
    if (!NAME_RE.test(name)) return { restored: false, reason: `invalid skill name "${name}"` };
    const backupsRoot = join(archiveDir, '..', '.curator-backups');
    if (!existsSync(backupsRoot)) return { restored: false, reason: 'no backups exist' };
    // find newest <ts>-<reason>/<name>.tgz
    const candidates = readdirSync(backupsRoot)
      .map((d) => ({ dir: d, file: join(backupsRoot, d, `${name}.tgz`) }))
      .filter((c) => existsSync(c.file))
      .sort((a, b) => b.dir.localeCompare(a.dir));
    if (candidates.length === 0) return { restored: false, reason: `no backup found for "${name}"` };
    const newest = candidates[0].file;
    const dst = join(skillsDir, name);
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    mkdirSync(skillsDir, { recursive: true });
    execFileSync('tar', ['-C', skillsDir, '-xzf', newest], { stdio: 'ignore' });
    _touchUsage(skillsDir, name, 'restored-from-backup');
    return { restored: true, name, from: newest };
  } catch (e) {
    logger.warn?.(`restoreFromBackup failed: ${e?.message ?? e}`);
    return { restored: false, reason: String(e?.message ?? e) };
  }
}

/** Most-recent activity for a skill = max(usage sidecar, SKILL.md mtime). */
function lastActivityMs(skillsDir, name, file) {
  let last = 0;
  try {
    const u = _readUsage(skillsDir)[name];
    const t = Date.parse(u?.lastActivityAt ?? u?.createdAt ?? '');
    if (Number.isFinite(t)) last = Math.max(last, t);
  } catch { /* ignore */ }
  try { last = Math.max(last, statSync(file).mtimeMs); } catch { /* ignore */ }
  return last;
}

function readMeta(file) {
  try {
    const md = readFileSync(file, 'utf8');
    const st = readState(md) ?? {};
    return {
      owned: md.includes(EVOLVE_MARKER),
      version: st.version ?? (md.match(/^version:\s*(\S+)/m)?.[1] ?? '?'),
      tag: st.tag ?? '?',
      refinements: st.refinements?.length ?? 0,
    };
  } catch { return { owned: false }; }
}

/**
 * Full lifecycle report over evolve-owned skills.
 * status: 'active' | 'stale' (active + idle ≥ staleDays) | 'archived'.
 * Returns { skillsDir, archiveDir, active:[], stale:[], archived:[], counts }.
 * Deterministic, read-only.
 */
export function listSkillStates(skillsDir, archiveDir, opts = {}) {
  const staleDays = opts.staleDays ?? 30;
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const active = [];
  const stale = [];
  const archived = [];

  const scan = (dir, kind) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, 'SKILL.md');
      const meta = readMeta(file);
      if (!meta.owned) continue;
      const last = lastActivityMs(skillsDir, entry.name, file);
      const ageDays = last > 0 ? Math.floor((now - last) / dayMs) : null;
      const row = {
        name: entry.name, version: meta.version, tag: meta.tag,
        refinements: meta.refinements, lastActivityAt: last > 0 ? new Date(last).toISOString() : null, ageDays,
      };
      if (kind === 'archived') { archived.push(row); continue; }
      if (ageDays !== null && ageDays >= staleDays) { row.status = 'stale'; stale.push(row); } else { row.status = 'active'; active.push(row); }
    }
  };
  scan(skillsDir, 'active');
  scan(archiveDir, 'archived');

  return {
    skillsDir, archiveDir, staleDays,
    active, stale, archived,
    counts: { active: active.length, stale: stale.length, archived: archived.length },
  };
}

/** Count evolve-owned skills currently active on disk (for stats). */
export function countCrystallizedSkills(skillsDir) {
  try {
    let n = 0;
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const f = join(skillsDir, entry.name, 'SKILL.md');
      try { if (statSync(f).isFile() && readFileSync(f, 'utf8').includes(EVOLVE_MARKER)) n += 1; } catch { /* skip */ }
    }
    return n;
  } catch { return 0; }
}

/**
 * Back-compat shim for the old report-only API: names of active skills idle for
 * ≥ idleDays. New code should use listSkillStates(). Kept so nothing breaks.
 */
export function idleCrystallizedSkills(skillsDir, idleDays) {
  return listSkillStates(skillsDir, join(skillsDir, '..', 'evolve-workspace', 'archived-skills'), { staleDays: idleDays })
    .stale.map((s) => s.name);
}
