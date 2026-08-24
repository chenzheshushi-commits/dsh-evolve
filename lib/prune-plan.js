/**
 * Prune plan / registry / audit (v0.4.2). Closes the preview→execute loop with
 * idempotency, and records an append-only audit trail.
 *
 * Design (from multi-round review):
 *   - Idempotency lives in an in-memory registry, NOT the audit log. The audit
 *     is fail-open (a failed write must not block pruning) — so it cannot be the
 *     source of "return the original receipt". skill-converge is not naturally
 *     idempotent (a re-run would create a second umbrella), so the registry's
 *     consumed-flag is the real guard.
 *   - Staleness is per-target etag, not a global revision: injectionCount lazy
 *     flush / skill sidecar / other-session edits wouldn't move a global rev.
 *     A stale target is skipped with a reason; the rest of the plan still applies.
 *   - Each decision applies independently with its own receipt — no cross-decision
 *     transaction, so "partial apply" is the natural semantics (no rollback needed).
 *
 * @module dsh-evolve/prune-plan
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLAN_TTL_MS = 15 * 60 * 1000; // 15 min
const PLAN_MAX = 100;               // registry cap (LRU)

function sha(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/** Per-target etag: any field that would change what the plan operates on. */
export function memoryEtag(r) {
  return sha({
    id: r.id, updatedAt: r.updatedAt, importance: r.importance,
    observationCount: r.observationCount ?? 1, injectionCount: r.injectionCount ?? 0,
    pinned: !!r.pinned, forgottenAt: r.forgottenAt || '', scope: r.scope,
  });
}
export function skillEtag(s) {
  return sha({
    name: s.name, version: s.version ?? 0, lastActivityAt: s.lastActivityAt || '',
    status: s.status || 'active', refinementCount: s.refinementCount ?? 0,
  });
}

/**
 * Build a plan from selected decisions. `decisions` = array of
 * { action, entityType:'memory'|'skill', targets:[{id/name, etag}], reason }.
 */
export function buildPlan(decisions) {
  const createdAt = new Date().toISOString();
  const planDigest = sha({ decisions, createdAt });
  return { planDigest, createdAt, decisions };
}

/** In-memory registry: digest -> { plan, createdAt, expiresAt, consumed, receipt }. */
export class PlanRegistry {
  constructor(now = () => Date.now()) {
    this._now = now;
    this._m = new Map();
  }

  _sweep() {
    const t = this._now();
    for (const [k, v] of this._m) if (v.expiresAt <= t) this._m.delete(k);
    // LRU cap: drop oldest insertions beyond PLAN_MAX
    while (this._m.size > PLAN_MAX) {
      const oldest = this._m.keys().next().value;
      this._m.delete(oldest);
    }
  }

  put(plan) {
    this._sweep();
    const t = this._now();
    // delete+set to move to newest position (Map preserves insertion order)
    this._m.delete(plan.planDigest);
    this._m.set(plan.planDigest, { plan, createdAt: t, expiresAt: t + PLAN_TTL_MS, consumed: false, receipt: null });
    return plan;
  }

  /**
   * Look up a plan for execution.
   * @returns { status:'ok'|'retry'|'plan-expired', plan?, receipt? }
   */
  lookup(planDigest) {
    this._sweep();
    const e = this._m.get(planDigest);
    if (!e) return { status: 'plan-expired' };        // restart / TTL / LRU-evicted
    if (e.consumed) return { status: 'retry', receipt: e.receipt }; // idempotent replay
    return { status: 'ok', plan: e.plan };
  }

  /**
   * Atomic check-and-claim: if the plan is executable, mark it consumed IN THE
   * SAME synchronous tick (before returning) and hand back the plan. This closes
   * the TOCTOU window that plain lookup()+later-markConsumed() leaves open: with
   * a long `await applyPlan` between check and mark, a concurrent second request
   * for the same digest (double-click / retry / resend) would also read
   * consumed=false and re-execute (creating e.g. a duplicate umbrella skill).
   * Because JS is single-threaded and this method has NO await, the claim is
   * atomic w.r.t. the event loop — the second request synchronously sees
   * consumed=true and gets 'retry'. finalize() later backfills the real receipt.
   */
  lookupAndClaim(planDigest) {
    this._sweep();
    const e = this._m.get(planDigest);
    if (!e) return { status: 'plan-expired' };
    if (e.consumed) return { status: 'retry', receipt: e.receipt };
    e.consumed = true;
    e.receipt = { status: 'pending', pending: true }; // placeholder until finalize
    return { status: 'ok', plan: e.plan };
  }

  /** Backfill the real receipt after applyPlan resolves (paired with lookupAndClaim). */
  finalize(planDigest, receipt) {
    const e = this._m.get(planDigest);
    if (e) { e.consumed = true; e.receipt = receipt; }
  }

  markConsumed(planDigest, receipt) {
    const e = this._m.get(planDigest);
    if (e) { e.consumed = true; e.receipt = receipt; }
  }
}

/**
 * Apply a plan. Each decision + each target applies independently; stale targets
 * (etag changed) are skipped with a reason, the rest proceed.
 * @param plan       from buildPlan
 * @param handlers   { 'memory-forget'(id), 'memory-promote'(id), 'skill-archive'(name),
 *                     'skill-fold'(name), 'skill-converge'(names,into) } -> async result
 * @param currentEtag (entityType, keyOrObj) -> etag string | null (null = not found)
 * @returns { status:'ok'|'degraded', applied:[...], skipped:[{target,reason}] }
 */
export async function applyPlan(plan, handlers, currentEtag) {
  const applied = [];
  const skipped = [];
  for (const dec of plan.decisions) {
    const handler = handlers[dec.action];
    if (typeof handler !== 'function') {
      for (const t of dec.targets) skipped.push({ target: t.id ?? t.name, reason: `no handler for ${dec.action}` });
      continue;
    }
    // skill-converge is a group op over all targets at once
    if (dec.action === 'skill-converge') {
      let stale = false;
      for (const t of dec.targets) {
        let cur;
        try { cur = currentEtag('skill', t.name ?? t.id); }
        catch (e) { cur = null; } // etag resolver threw -> treat as not-found (don't bubble)
        if (cur === null || (t.etag && cur !== t.etag)) { stale = true; skipped.push({ target: t.name ?? t.id, reason: cur === null ? 'not-found' : 'stale-target' }); }
      }
      if (stale) continue;
      try {
        const names = dec.targets.map((t) => t.name ?? t.id);
        const res = await handler(names, dec.into);
        applied.push({ action: dec.action, targets: names, receipt: res });
      } catch (e) {
        skipped.push({ target: dec.targets.map((t) => t.name ?? t.id).join('+'), reason: `error: ${e.message}` });
      }
      continue;
    }
    // per-target ops
    for (const t of dec.targets) {
      const key = t.id ?? t.name;
      let cur;
      try { cur = currentEtag(dec.entityType, key); }
      catch (e) { cur = null; } // etag resolver threw -> treat as not-found (don't bubble)
      if (cur === null) { skipped.push({ target: key, reason: 'not-found' }); continue; }
      if (t.etag && cur !== t.etag) { skipped.push({ target: key, reason: 'stale-target' }); continue; }
      try {
        const res = await handler(key, dec.into);
        applied.push({ action: dec.action, target: key, receipt: res });
      } catch (e) {
        skipped.push({ target: key, reason: `error: ${e.message}` });
      }
    }
  }
  return { status: skipped.length > 0 ? 'degraded' : 'ok', applied, skipped };
}

/** Audit sidecar path (JSONL, same pattern as triage). */
export function auditPath(workspaceDir) {
  return join(workspaceDir, '.evolve-audit.jsonl');
}

/**
 * Append one prune run to the audit JSONL. fail-open: a write error only warns,
 * NEVER blocks the prune. Ring-trims to auditMaxRuns.
 *
 * Trim is AMORTIZED (v0.4.2): a plain append is O(1) (appendFileSync only).
 * We only read+rewrite the whole file to trim once every `checkEvery` appends
 * (tracked per-path in _appendsSinceTrim), instead of on every single append.
 * checkEvery is a fraction of maxRuns, so the file can transiently overshoot the
 * cap by at most that slack before the next trim reclaims it — bounded, and it
 * turns an every-write O(n) into an occasional O(n). Stateless callers unaffected:
 * signature/return unchanged, fail-open preserved.
 */
const _appendsSinceTrim = new Map();

export function appendAudit(workspaceDir, entry, cfg = {}, logger = { warn() {} }) {
  const path = auditPath(workspaceDir);
  const maxRuns = cfg.auditMaxRuns ?? 500;
  // Amortized trim cadence: check every ~20% of the cap, clamped to [1, 200].
  // Lower bound 1 keeps small caps correct (a maxRuns=5 file still trims every
  // append); upper bound 200 keeps huge caps from drifting too long. Worst-case
  // transient overshoot is one checkEvery's worth of rows before the next trim.
  const checkEvery = Math.min(200, Math.max(1, Math.floor(maxRuns * 0.2)));
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(path, line + '\n'); // O(1) hot path
    const since = (_appendsSinceTrim.get(path) ?? 0) + 1;
    if (since >= checkEvery) {
      _appendsSinceTrim.set(path, 0);
      // amortized trim: only now do we pay the O(n) read+rewrite
      if (existsSync(path)) {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        if (lines.length > maxRuns) {
          writeFileSync(path, lines.slice(-maxRuns).join('\n') + '\n');
        }
      }
    } else {
      _appendsSinceTrim.set(path, since);
    }
  } catch (e) {
    logger.warn?.(`[dsh-evolve] audit append failed (non-fatal): ${e.message}`);
  }
}

export function readAudit(workspaceDir, cfg = {}) {
  const path = auditPath(workspaceDir);
  const maxRuns = cfg.auditMaxRuns ?? 500;
  try {
    if (!existsSync(path)) return [];
    // Symmetric tail cap: append-side trim is amortized and may transiently
    // overshoot maxRuns, so the read side slices to the last maxRuns too — a
    // future UI consumer never sees more than the configured cap.
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .slice(-maxRuns)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
