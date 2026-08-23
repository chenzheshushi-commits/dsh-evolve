/**
 * Zero-token outcome triage collector (v0.3.0, option B).
 *
 * Records (skillsLoaded[], errorFingerprints[], success) tuples per turn into a
 * sidecar JSONL — the raw fuel a FUTURE self-improvement step (fitness scoring /
 * GEPA) would need: "after loading skill X, did the turn succeed or error?".
 *
 * DESIGN (deliberately minimal — this is a data recorder, not an analyzer):
 *  - NO new hook types. Reuses signals the plugin already observes:
 *      • tool/call (name==='skill')  -> which evolve skill(s) got loaded this turn
 *      • agent/error                 -> this turn hit an error (fingerprint)
 *      • turn/end                    -> flush one tuple; success = no error seen
 *  - NO LLM. NO main-path injection. Pure in-memory accumulation + one append.
 *  - Bounded: sidecar is capped (ring-trimmed) so it can't grow unbounded.
 *  - Best-effort: every method swallows its own errors; never breaks a hook.
 *
 * It does NOT drive refine/crystallize decisions in v0.3.0 — it only records.
 * Turning this data into fitness signals is a later, explicitly-gated step.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_TUPLES = 2000; // ring cap; trims oldest when exceeded

export class OutcomeTriage {
  /** @param {string} sidecarPath  JSONL file under evolve-workspace. */
  constructor(sidecarPath, logger = { warn() {} }) {
    this.path = sidecarPath;
    this.logger = logger;
    // Per-turn accumulator, keyed by turn number (a session rarely overlaps turns).
    this._turns = new Map();
  }

  _turn(turn) {
    const key = String(turn ?? 0);
    let t = this._turns.get(key);
    if (!t) { t = { skills: new Set(), errors: [], startedAt: Date.now() }; this._turns.set(key, t); }
    return t;
  }

  /** A skill was loaded this turn (from tool/call name==='skill', evolve-owned only). */
  noteSkillLoaded(turn, skillName) {
    try { if (skillName) this._turn(turn).skills.add(skillName); } catch { /* best-effort */ }
  }

  /** This turn hit an error (from agent/error). */
  noteError(turn, fingerprint) {
    try { if (fingerprint) this._turn(turn).errors.push(fingerprint); } catch { /* best-effort */ }
  }

  /**
   * Flush one tuple at turn/end. Only records turns that actually loaded an
   * evolve skill OR errored — empty turns are noise, skipped. Returns the tuple
   * or null. success = no error fingerprints observed this turn.
   */
  flushTurn(turn) {
    try {
      const key = String(turn ?? 0);
      const t = this._turns.get(key);
      if (!t) return null;
      this._turns.delete(key);
      const skills = [...t.skills];
      if (skills.length === 0 && t.errors.length === 0) return null; // nothing worth recording
      const tuple = {
        at: new Date().toISOString(),
        turn: Number(turn ?? 0),
        skillsLoaded: skills,
        errors: t.errors,
        success: t.errors.length === 0,
      };
      this._append(tuple);
      return tuple;
    } catch (e) {
      this.logger.warn?.(`[dsh-evolve] triage flush failed: ${e?.message ?? e}`);
      return null;
    }
  }

  _append(tuple) {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(tuple) + '\n');
      // Ring-trim if the file grew past the cap (cheap: count lines, rewrite tail).
      this._trimIfNeeded();
    } catch (e) {
      this.logger.warn?.(`[dsh-evolve] triage append failed: ${e?.message ?? e}`);
    }
  }

  _trimIfNeeded() {
    try {
      // Only bother checking when the file is largish (~ >256KB).
      if (!existsSync(this.path) || statSync(this.path).size < 262144) return;
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= MAX_TUPLES) return;
      writeFileSync(this.path, lines.slice(lines.length - MAX_TUPLES).join('\n') + '\n');
    } catch { /* best-effort */ }
  }

  /** Read all recorded tuples (for future analysis / stats). Best-effort. */
  readAll() {
    try {
      if (!existsSync(this.path)) return [];
      return readFileSync(this.path, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }

  /** Aggregate per-skill outcome counts (for skill_stats / future fitness). */
  summary() {
    const bySkill = {};
    let total = 0;
    let successes = 0;
    for (const t of this.readAll()) {
      total += 1;
      if (t.success) successes += 1;
      for (const s of t.skillsLoaded ?? []) {
        const e = bySkill[s] ?? { loaded: 0, succeeded: 0, errored: 0 };
        e.loaded += 1;
        if (t.success) e.succeeded += 1; else e.errored += 1;
        bySkill[s] = e;
      }
    }
    return { totalTurns: total, successes, failures: total - successes, bySkill };
  }
}

/** Build the default sidecar path under a workspace dir. */
export function triageSidecarPath(workspaceDir) {
  return join(workspaceDir, '.evolve-triage.jsonl');
}
