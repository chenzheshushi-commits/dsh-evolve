/**
 * Who owns a SKILL.md, decided structurally rather than by substring.
 *
 * The old check was one line:
 *
 *     readFileSync(file, 'utf8').includes('dsh-evolve (crystallized)')
 *
 * Any skill whose PROSE happened to mention that phrase was treated as ours and
 * became eligible for overwrite, fold and archive. A hand-written skill
 * documenting dsh-evolve itself qualifies -- and once autonomous apply exists,
 * that stops being a misclassification and becomes an authorization hole.
 *
 * Ownership now requires all of:
 *
 *   1. frontmatter `author` EXACTLY equals the marker (a YAML field, not prose)
 *   2. the state block parses as JSON
 *   3. the state carries its required fields with the right types
 *   4. state.ownerId matches THIS installation
 *
 * (4) is mandatory, not a bonus. The author line and the state block are both
 * public text that anyone can copy, so "the format looks right" cannot be the
 * authorization boundary for automatic mutation. The ownerId is a random value
 * generated per installation and kept out of git.
 *
 * Legacy skills predate ownerId and are NOT adopted automatically: silently
 * stamping every file that "looks like ours" would be claiming the user's own
 * work. They are listed for human confirmation instead, and stay out of every
 * automatic path until claimed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const EVOLVE_MARKER = 'dsh-evolve (crystallized)';

const OWNER_FILE = '.evolve-owner.json';
const STATE_RE = /<!--dsh-evolve-state:(.*?)-->/s;

/** Verdicts, so callers can tell "not ours" from "ours but unclaimed". */
export const OWNERSHIP = {
  OWNED: 'owned',
  FOREIGN: 'foreign',
  LEGACY_UNCLAIMED: 'legacy-unclaimed',
  MALFORMED: 'malformed',
};

/**
 * This installation's owner id, created on first use.
 *
 * Lives in the workspace and is gitignored: if it travelled with the repo, two
 * machines would recognise each other's skills as their own.
 */
export function getOwnerId(workspaceDir) {
  if (!workspaceDir) return null;
  const path = join(workspaceDir, OWNER_FILE);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed?.ownerId === 'string' && parsed.ownerId.length >= 16) return parsed.ownerId;
    } catch { /* fall through and regenerate */ }
  }
  const ownerId = randomBytes(16).toString('hex');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ownerId, createdAt: new Date().toISOString() }, null, 2)}\n`);
  return ownerId;
}

/** The frontmatter `author` value, or null when there is no frontmatter. */
export function readAuthor(md) {
  const text = String(md ?? '');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const frontmatter = text.slice(0, end);
  const m = /^author:[ \t]*(.*)$/m.exec(frontmatter);
  if (!m) return null;
  // Tolerate quoting, since YAML allows it.
  return m[1].trim().replace(/^["'](.*)["']$/, '$1');
}

/** Parse the embedded state block, or null. */
export function readStateBlock(md) {
  const m = STATE_RE.exec(String(md ?? ''));
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    // Arrays pass `typeof === 'object'`, so exclude them explicitly: a state
    // block is a record, and treating [] as one would let stateIsWellFormed
    // reason about a shape that can never carry the fields it checks for.
    const isRecord = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    return isRecord ? parsed : null;
  } catch {
    return null;
  }
}

/** Does the state block carry the fields ownership depends on? */
function stateIsWellFormed(state) {
  return Boolean(state)
    && typeof state.tag === 'string' && state.tag !== ''
    && typeof state.version === 'string' && state.version !== ''
    && typeof state.createdAt === 'string' && state.createdAt !== ''
    && Array.isArray(state.sourceIds);
}

/**
 * Classify a SKILL.md's ownership.
 *
 * @param {string} md            the file contents
 * @param {string|null} ownerId  this installation's owner id
 * @returns {{status: string, reason: string, state: object|null}}
 */
export function classifyOwnership(md, ownerId) {
  const text = String(md ?? '');

  if (readAuthor(text) !== EVOLVE_MARKER) {
    return {
      status: OWNERSHIP.FOREIGN,
      reason: 'frontmatter author is not the evolve marker; prose mentioning the marker '
        + 'does not make a skill ours (that was the old substring bug)',
      state: null,
    };
  }

  const state = readStateBlock(text);
  if (state === null) {
    return {
      status: OWNERSHIP.MALFORMED,
      reason: 'the author line claims evolve ownership but the state block is missing or '
        + 'unparseable; refusing to mutate a file we cannot read',
      state: null,
    };
  }
  if (!stateIsWellFormed(state)) {
    return {
      status: OWNERSHIP.MALFORMED,
      reason: 'the state block is missing required fields (tag/version/createdAt/sourceIds)',
      state,
    };
  }

  if (typeof state.ownerId !== 'string' || state.ownerId === '') {
    return {
      status: OWNERSHIP.LEGACY_UNCLAIMED,
      reason: 'predates ownerId. NOT adopted automatically -- stamping every file that looks '
        + "like ours would be claiming the user's own work. Needs explicit confirmation.",
      state,
    };
  }
  if (!ownerId || state.ownerId !== ownerId) {
    return {
      status: OWNERSHIP.FOREIGN,
      reason: `state.ownerId belongs to a different installation (${String(state.ownerId).slice(0, 8)}…)`,
      state,
    };
  }

  return { status: OWNERSHIP.OWNED, reason: 'author, state and ownerId all match', state };
}

/**
 * The single question every mutating path must ask.
 *
 * Only OWNED may be mutated automatically. LEGACY_UNCLAIMED deliberately fails:
 * it stays out of autonomous paths until a human claims it, though manual tools
 * may still operate on it by passing allowLegacy.
 */
export function isEvolveOwned(md, ownerId, { allowLegacy = false } = {}) {
  const { status } = classifyOwnership(md, ownerId);
  if (status === OWNERSHIP.OWNED) return true;
  return allowLegacy && status === OWNERSHIP.LEGACY_UNCLAIMED;
}

/** Stamp an owner id into a state block. Only ever from an explicit claim. */
export function claimState(state, ownerId) {
  if (!ownerId) throw new Error('claimState requires an ownerId');
  return { ...state, ownerId, claimedAt: new Date().toISOString() };
}
