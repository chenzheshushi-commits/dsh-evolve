/**
 * Prune authorization (v0.4.2): decide whether a PRUNE action on a memory/skill
 * target is allowed. This is a SEPARATE gate from adjudicator.js.
 *
 * ⚠️ Why not reuse adjudicate(): adjudicator answers "may this WRITE be
 * auto-confirmed?" — its inputs are content/kind/scope/importance/anchoredToUser
 * and its semantics are about *ingestion*. It understands nothing about
 * archive/fold/converge/promote/soft-delete. Reusing it for prune authorization
 * would be a semantic mismatch. Ingestion approval and disposal authorization
 * are two different questions, kept in two modules.
 *
 * Three-tier protection model:
 *   - pinned (record.pinned===true)   → user explicitly locked; ANY action reject
 *   - protected kind (preference/decision) → not a normal prune candidate;
 *       cannot be directly memory-forget'd (shown read-only in a review area)
 *   - ordinary (fact/lesson/note/todo) → normal disposal allowed
 *
 * PURE module: no IO, no LLM, no mutation. Data-layer store.forget/softForget
 * still enforce the pinned guard independently (defense at the narrowest choke
 * point); this module is the UI/panel-path policy gate.
 *
 * @module dsh-evolve/prune-authz
 */

/** Kinds that are protected from direct forget (but visible for review). */
export const PROTECTED_KINDS = ['preference', 'decision'];

/** Marker every evolve-owned skill's SKILL.md carries (ownership check). */
export const EVOLVE_MARKER = 'dsh-evolve-state';

export function isProtectedKind(kind) {
  return PROTECTED_KINDS.includes(kind);
}

/**
 * Authorize a prune action on a target.
 * @param action one of: memory-forget | memory-promote | skill-archive |
 *               skill-fold | skill-converge
 * @param target for memory actions: a record { pinned, kind, importance, scope,
 *               forgottenAt }. For skill actions: { name, ownedByEvolve } or an
 *               array (skill-converge) of such.
 * @param cfg    optional config (unused today; reserved).
 * @returns { allowed:boolean, reason:string, requires?:'explicit-confirm'|'backup' }
 */
export function authorizePruneAction(action, target, cfg = {}) {
  switch (action) {
    case 'memory-forget': {
      const rec = target || {};
      if (rec.pinned) return { allowed: false, reason: 'pinned by user — never prunable' };
      if (isProtectedKind(rec.kind)) {
        return { allowed: false, reason: `protected kind (${rec.kind}) — use conflict/staleness review, not direct forget` };
      }
      if (rec.importance === 3) {
        return { allowed: true, reason: 'high-importance memory', requires: 'explicit-confirm' };
      }
      return { allowed: true, reason: 'ordinary memory, reversible soft-delete' };
    }

    case 'memory-promote': {
      const rec = target || {};
      if (rec.pinned) return { allowed: false, reason: 'pinned by user' };
      if (rec.scope !== 'project') {
        return { allowed: false, reason: 'only project-scope memories can be promoted to global' };
      }
      return { allowed: true, reason: 'project→global promotion (reversible by re-scope)' };
    }

    case 'skill-archive': {
      const sk = target || {};
      if (!sk.ownedByEvolve) return { allowed: false, reason: 'not an evolve-owned skill — never touch human-authored skills' };
      return { allowed: true, reason: 'evolve-owned skill, reversible archive' };
    }

    case 'skill-fold': {
      const sk = target || {};
      if (!sk.ownedByEvolve) return { allowed: false, reason: 'not an evolve-owned skill' };
      return { allowed: true, reason: 'fold refinements into clean body', requires: 'backup' };
    }

    case 'skill-converge': {
      const list = Array.isArray(target) ? target : [];
      const owned = list.filter((s) => s && s.ownedByEvolve);
      if (owned.length < 2) {
        return { allowed: false, reason: 'skill-converge needs >=2 evolve-owned skills' };
      }
      return { allowed: true, reason: `merge ${owned.length} evolve-owned skills`, requires: 'backup' };
    }

    default:
      return { allowed: false, reason: `unknown prune action: ${action}` };
  }
}
