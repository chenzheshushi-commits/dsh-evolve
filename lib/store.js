/**
 * Memory store: JSON truth (via ctx.storageDomain) + human-owned approval gate
 * + Markdown mirror + git checkpoints.
 *
 *  - Truth lives in the harness storage domain (stock json backend →
 *    $DSH_HOME/storages/*.json). Deterministic, zero-LLM.
 *  - Approval gate : model writes land as status implied by
 *    `pending` unless the caller is the human-confirm path. We keep it simple:
 *    a record carries no separate status column; instead "pending" memories are
 *    those with importance kept and a `pending` tag until confirmed. To stay
 *    faithful to Culeot's schema we instead gate *injection*: only confirmed
 *    (non-pending) records are auto-injected; pending ones are recall-only.
 *  - Markdown mirror + git: after each mutation we render a human-readable
 *    MEMORY.md under the workspace and (debounced) git-commit it for rollback.
 *
 * No session-log writes (immune to SessionFormatUnsupportedError). Never
 * throws into the agent loop — every public method is best-effort.
 *
 * @module dsh-evolve/store
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEMORY_DEFAULTS, isValidKind, isValidScope, clampImportance,
} from './spec.js';
import {
  rankRecords, isExpired, tokenSetBigram, jaccard, fuseRRF,
} from './search.js';
import { adjudicate, DECISION_AUTO, ADJUDICATOR_DEFAULTS } from './adjudicator.js';
import { createHash } from 'node:crypto';
import { classifyProcessArtifact } from './process-artifact-filter.js';
import { firstSecretReason, redactSecrets, MAX_SECRET_SCAN_CHARS } from './secret-scan.js';
import { budgetStatus, assessWriteQuality, findPromotionCandidates } from './memory-convergence.js';

const PENDING_TAG = 'pending';
// A pending memory the user threw away. A state, not a deletion: the record
// stays forever and can be restored to pending by hand.
//
// It must be excluded at EVERY query point, not just in confirmed(): recall
// with includePending goes straight to all(), list() only looks at PENDING_TAG,
// stats() computes all-minus-forgotten, and the reinforcement loop walks the raw
// table. Filtering in one place would leave rejected memories still injected,
// still counted, and -- worst of all -- still swept up by confirm-all, which is
// exactly the bug this channel exists to fix.
const REJECTED_TAG = 'dsh-evolve-rejected';

/** True when the user threw this pending memory away. */
const isRejected = (r) => !!r.tags?.includes(REJECTED_TAG);
/** Tag stamped on records auto-confirmed by the adjudicator (visible + revocable). */
const AUTO_CONFIRMED_TAG = 'auto-confirmed';

function nowIso() {
  return new Date().toISOString();
}
/** Content fingerprint for audit lines that must not carry the text itself. */
function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}
function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max);
}
function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MemoryStore {
  /**
   * @param table   the opened domain table (put/get/delete/entries/update/size)
   * @param options { workspaceDir, config, logger, fts, onCommit }
   */
  constructor(table, options = {}) {
    this.table = table;
    this.config = { ...MEMORY_DEFAULTS, ...(options.config ?? {}) };
    this.workspaceDir = options.workspaceDir;
    this.logger = options.logger ?? { warn() {}, info() {} };
    this.onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;
    // Optional derived FTS5 index (NullFts when unavailable). Backfilled from
    // the current record set so recall fuses BM25 with bigram-Jaccard.
    this.fts = options.fts ?? null;
    this._commitTimer = null;
    // In-memory injection-count deltas (id -> pending increments). Flushed by
    // riding on the next real write (remember/confirm/forget) or on dispose —
    // NEVER on a timer. injectionCount is an observability signal only: it is
    // persisted to the record but deliberately does NOT touch accessedAt/
    // updatedAt and does NOT enter recencyBoost/scoreRecord, so it can't create
    // the "injected -> ranks higher -> injected again" feedback loop. Flushing
    // bypasses _afterWrite() (no git checkpoint, no Markdown re-render), keeping
    // the JSON store a low-write source of truth.
    this._injectionDelta = new Map();
    // R5 (v0.5.0): retrieval-path observability. Recall silently degrades to
    // bigram-only when FTS5 is unavailable/disabled; surface it so the user isn't
    // blind to reduced recall. Read-only counters, never drive behavior.
    this._retrieval = { lastPath: 'unknown', fusedCount: 0, bigramOnlyCount: 0, ftsErrorCount: 0 };
    if (this.fts?.available) {
      // v0.4.2: don't backfill tombstones into the index on restart (they'd add
      // noise and rely on downstream filtering to stay correct).
      try { this.fts.backfill(this.all().filter((r) => !r.forgottenAt)); } catch { /* best-effort */ }
    }
  }

  all() {
    return [...this.table.entries()].map(([, v]) => v);
  }

  /** Map<id, record> over the current set (for FTS-only id resolution in fusion). */
  recordsById() {
    const m = new Map();
    for (const r of this.all()) m.set(r.id, r);
    return m;
  }

  /**
   * Confirmed = not pending AND not forgotten (tombstoned). This is the SINGLE
   * gate for "active records": every active-record consumer (assessWrite,
   * budgetStatus, promotionCandidates, profileView, crystallization evidence,
   * adjudicator input) goes through here, so a new consumer is automatically
   * immune to pending/tombstoned leakage — no per-site forgottenAt checklist.
   * (recall/tier1 have their own candidate pools and filter forgottenAt
   * directly; the remember() reinforcement loop walks the raw table and needs
   * its own tombstone+pinned guards — confirmed() cannot cover those two.)
   */
  confirmed() {
    return this.all().filter((r) => !r.tags.includes(PENDING_TAG) && !r.forgottenAt
      && !isRejected(r));
  }

  /**
   * Record that these record ids were injected into the model context (a
   * decision-influencing event, distinct from a manual recall). Accumulates in
   * memory only — cheap, safe to call every step. Deltas are persisted lazily
   * by flushInjections() riding on the next real write or on dispose. Does NOT
   * write, does NOT touch ranking fields.
   */
  noteInjection(ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (!id) continue;
      this._injectionDelta.set(id, (this._injectionDelta.get(id) ?? 0) + 1);
    }
  }

  /** Effective injectionCount = persisted value + not-yet-flushed in-memory delta. */
  effectiveInjectionCount(record) {
    const base = record.injectionCount ?? 0;
    return base + (this._injectionDelta.get(record.id) ?? 0);
  }

  /**
   * Persist accumulated injection deltas into the records. Bypasses
   * _afterWrite() on purpose (no git checkpoint / Markdown re-render) and only
   * bumps injectionCount — never accessedAt/updatedAt — so ranking is untouched.
   * Called from a real write's tail and on plugin dispose. Best-effort; a lost
   * delta on hard crash is acceptable for an approximate observability counter.
   */
  async flushInjections() {
    if (this._injectionDelta.size === 0) return;
    const pending = this._injectionDelta;
    this._injectionDelta = new Map();
    for (const [id, delta] of pending) {
      const rec = this.table.get(id);
      if (!rec) continue; // record was deleted meanwhile; drop the delta
      try {
        await this.table.put(id, { ...rec, injectionCount: (rec.injectionCount ?? 0) + delta });
      } catch {
        // put back so a later flush can retry
        this._injectionDelta.set(id, (this._injectionDelta.get(id) ?? 0) + delta);
      }
    }
  }

  async _afterWrite() {
    try { this._renderMirror(); } catch (e) { this.logger.warn(`mirror failed: ${e?.message ?? e}`); }
    this._scheduleCommit();
    // Ride on this real write to drain any pending injection deltas (they bypass
    // _afterWrite themselves, so no recursion; keeps injectionCount persistence
    // free of its own git/mirror churn).
    try { await this.flushInjections(); } catch { /* best-effort */ }
    // B2 (v0.5.0): non-git onWrite hook for the idle-trigger's noteWrite (resets
    // the idle clock). Distinct from _scheduleCommit's git-coupled 1.5s debounce —
    // this fires on EVERY real write, synchronously, so the suggest tier's idle
    // recompute is armed off actual activity. Best-effort, never blocks the write.
    if (typeof this._onWrite === 'function') {
      try { this._onWrite(); } catch { /* best-effort; a refresh miss is harmless */ }
    }
  }

  /** Register a callback fired after every real write (B2: idle-trigger noteWrite). */
  setOnWrite(fn) { this._onWrite = typeof fn === 'function' ? fn : null; }

  /** Insert or merge one memory. Model writes are pending unless confirm=true. */
  async remember(input) {
    const now = input.now ?? Date.now();
    const kind = isValidKind(input.kind) ? input.kind : 'note';
    const scope = isValidScope(input.scope) ? input.scope : 'project';
    const importance = clampImportance(input.importance);
    // Persist no suffix the scanner did not inspect. maxContentChars normally is
    // much smaller, but a user may raise it; the scan limit remains the hard cap.
    const content = truncate(String(input.content ?? '').trim(),
      Math.min(this.config.maxContentChars, MAX_SECRET_SCAN_CHARS));
    if (content === '') return null;

    const rawTags = Array.isArray(input.tags) ? input.tags.map((t) => String(t)) : [];
    const tags = [...new Set(rawTags.map((t) => t.toLowerCase()))];

    // P3 secret gate: after normalisation but before EVERY write path, including
    // near-duplicate reinforcement. Returning null is the established refusal
    // contract; lastWriteRefusal makes the cause observable without ever storing
    // or logging the matching token itself.
    const contentSecret = firstSecretReason(content, { maxChars: MAX_SECRET_SCAN_CHARS });
    if (contentSecret && input.secretGrant !== true) {
      this.lastWriteRefusal = { reason: contentSecret, at: nowIso() };
      this._secretWritesFiltered = (this._secretWritesFiltered ?? 0) + 1;
      this.logger?.warn?.(`[dsh-evolve] ${contentSecret}`);
      return null;
    }
    // Scan BEFORE lower-casing: AWS access ids are intentionally uppercase and
    // normalisation would otherwise erase the strong AKIA prefix.
    for (const tag of rawTags) {
      const tagSecret = firstSecretReason(tag, { maxChars: MAX_SECRET_SCAN_CHARS });
      if (tagSecret && input.secretGrant !== true) {
        this.lastWriteRefusal = { reason: `${tagSecret} in tag`, at: nowIso() };
        this._secretWritesFiltered = (this._secretWritesFiltered ?? 0) + 1;
        this.logger?.warn?.(`[dsh-evolve] ${tagSecret} in tag`);
        return null;
      }
    }
    // sourceContext has review value even when the surrounding conversation
    // contained a token, so redact instead of dropping the whole memory. The
    // persisted value is clipped to the SAME prefix that was scanned -- never
    // "scan the first half, save the full string".
    const safeSourceContext = redactSecrets(String(input.sourceContext ?? ''), {
      maxChars: Math.min(500, MAX_SECRET_SCAN_CHARS),
    }).text.slice(0, 500);

    // U2 hard gate: a project's review correspondence is documentation, not
    // cross-session memory. Runs BEFORE adjudication so a suspect write never
    // reaches the queue at all -- the user's decision was that it must not dirty
    // the queue even as a pending item.
    //
    // provenance comes from the CALL SITE, never from a tool parameter: if the
    // model could set it, it would simply claim the user asked (the anchoredToUser
    // lesson). An absent provenance is treated as untrusted.
    const artifactVerdict = classifyProcessArtifact({ content, provenance: input.provenance });
    if (artifactVerdict.isProcessArtifact) {
      // Audit the fact, not the text -- storing the content here would defeat the
      // point of refusing to store it.
      this.logger?.info?.(`[dsh-evolve] process-artifact-filtered: ${artifactVerdict.patternNames.join(',')}`);
      this._processArtifactsFiltered = (this._processArtifactsFiltered ?? 0) + 1;
      this.onProcessArtifactFiltered?.({
        event: 'process-artifact-filtered',
        patternNames: artifactVerdict.patternNames,
        reason: artifactVerdict.reason,
        contentSha256: sha256Hex(content),
        at: nowIso(),
      });
      return null;
    }
    // Human-approval gate with TIERED adjudication (v0.4.0 direction 1).
    //   - confirm===true  → the human-confirm path: land confirmed, no gate.
    //   - else run the deterministic adjudicator over the CONFIRMED set:
    //       'auto'    → land confirmed + stamp AUTO_CONFIRMED_TAG (visible+revocable)
    //       'pending' → mark pending for human review (v0.3.x default)
    // The adjudicator uses only model-unfalsifiable signals (reversibility /
    // conflict / near-dup / caller-set user-anchoring) — NEVER the kind field.
    let adjudication = null;
    // Determine whether this write will land PENDING (either the caller pre-tagged
    // it pending — e.g. §3.5 review over-cap — or the adjudicator will decide so).
    const preTaggedPending = tags.includes(PENDING_TAG);
    if (input.confirm !== true && !preTaggedPending) {
      adjudication = adjudicate(
        { content, kind, scope, importance, anchoredToUser: input.anchoredToUser === true },
        this.confirmed(),
        this.config,
      );
      if (adjudication.decision === DECISION_AUTO) {
        if (!tags.includes(AUTO_CONFIRMED_TAG)) tags.push(AUTO_CONFIRMED_TAG);
      } else {
        tags.push(PENDING_TAG);
      }
    }

    // C1 (v0.5.0): the pending queue is the ONE region that can be losslessly
    // refused (pending content isn't an asset yet). Hard-cap it so "autonomous +
    // no auto-delete" can't grow the store without bound. This guard runs for
    // EVERY path that lands pending — both the adjudicator's pending decision AND
    // a caller pre-tagging pending (§3.5 review over-cap) — so neither can bypass
    // it. Confirmed memory is bounded separately by the char budget.
    // NOTE: near-duplicate REINFORCEMENT (below) does not create a new record, so
    // it's exempt — this only caps genuinely NEW pending items.
    if (input.confirm !== true && tags.includes(PENDING_TAG)) {
      const cap = Number(this.config.maxPendingQueue ?? 50);
      if (cap > 0) {
        // Rejected records must not consume the quota; otherwise discarding one
        // frees nothing and the queue stays blocked -- the whole point of U1.
        const pendingNow = this.all().filter((r) => r.tags.includes(PENDING_TAG)
          && !r.forgottenAt && !isRejected(r)).length;
        if (pendingNow >= cap) {
          const incomingBig = tokenSetBigram(content);
          const isReinforcement = this.all().some((r) => !r.forgottenAt && !r.pinned
            && r.scope === scope && r.kind === kind
            && jaccard(incomingBig, tokenSetBigram(r.content)) >= this.config.mergeSimilarity);
          if (!isReinforcement) {
            this.logger?.warn?.(`[dsh-evolve] pending queue full (${pendingNow}/${cap}) — dropping new pending write to bound growth: "${content.slice(0, 40)}"`);
            return null;
          }
        }
      }
    }

    // Near-duplicate REINFORCEMENT (v0.4.1 direction-2 kernel): a new write that
    // is near-duplicate of an existing record of the same kind+scope is not a
    // fresh memory — it's the SAME understanding observed again. Instead of
    // overwriting blindly, we reinforce: bump observationCount, and once enough
    // independent observations accumulate, raise importance (the user keeps
    // showing this → we get more confident). This is the "gradually trained from
    // use" core: understanding strengthens with repeated evidence across turns.
    const incoming = tokenSetBigram(content);
    for (const [key, rec] of [...this.table.entries()]) {
      if (rec.forgottenAt) continue;   // guard1: tombstones never reinforce (memory-black-hole)
      if (rec.pinned) continue;        // guard2: pinned records are never rewritten (respect "don't touch")
      if (rec.scope !== scope || rec.kind !== kind) continue;
      if (jaccard(incoming, tokenSetBigram(rec.content)) >= this.config.mergeSimilarity) {
        const observationCount = (rec.observationCount ?? 1) + 1;
        // Confidence-driven importance bump: every reinforceEvery observations,
        // raise importance by 1 (capped at 3). Reinforced understanding rises.
        const every = this.config.reinforceEvery ?? 3;
        const bumps = Math.floor(observationCount / every);
        const reinforcedImportance = Math.min(3, Math.max(rec.importance, importance, 1 + bumps));
        // Keep the HIGHER-QUALITY phrasing (do NOT blindly overwrite with the new
        // content — a vaguer/typo'd re-observation must not degrade a good one).
        // Quality proxy: prefer the higher-importance phrasing; tie-break on
        // information content (longer is usually more specific). Reinforcement
        // only raises count/importance — it never lowers content quality.
        const incomingBetter = (importance > rec.importance)
          || (importance === rec.importance && content.trim().length > String(rec.content).trim().length);
        const bestContent = incomingBetter ? content : rec.content;
        const merged = {
          ...rec,
          content: bestContent,
          tags: [...new Set([...rec.tags.filter((t) => t !== PENDING_TAG), ...tags])],
          importance: reinforcedImportance,
          observationCount,
          reinforcedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        await this.table.put(key, merged);
        await this._afterWrite();
        try { this.fts?.upsert(merged); } catch { /* best-effort */ }
        return merged;
      }
    }

    const id = newId();
    const record = {
      id, content, kind, tags, scope,
      project: String(input.project ?? ''),
      importance,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      accessedAt: '', accessCount: 0, injectionCount: 0,
      observationCount: 1, reinforcedAt: '',
      expiresAt: input.expiresAt ?? '',
      crystallizedAt: '',
      // A2 (v0.5.0): carry the reviewer's source-context snippet so the human审
      // can see why a pending record was suggested. Bounded to keep the store lean.
      sourceContext: safeSourceContext,
    };
    await this.table.put(id, record);
    await this._reportOverBudget();
    await this._afterWrite();
    try { this.fts?.upsert(record); } catch { /* best-effort */ }
    return record;
  }

  /**
   * Confirm a pending memory (human-owned). Strips the pending tag.
   *
   * Refuses a rejected record even when named explicitly. confirm-batch filters
   * via list(), which already hides them, but a caller passing ids directly
   * would otherwise resurrect something the user threw away.
   */
  async confirm(id) {
    const rec = this.table.get(id);
    if (!rec) return null;
    if (isRejected(rec)) return null;
    const updated = { ...rec, tags: rec.tags.filter((t) => t !== PENDING_TAG), updatedAt: nowIso() };
    await this.table.put(id, updated);
    await this._afterWrite();
    return updated;
  }

  /**
   * Throw away a pending memory the user does not want.
   *
   * Before this existed the review queue could only grow: a wrongly captured
   * memory could be confirmed or ignored, nothing else, so the queue eventually
   * hit maxPendingQueue and NEW memories were dropped at the door -- garbage
   * blocking the entrance.
   *
   * Not a deletion. The record is kept forever, carries REJECTED_TAG instead of
   * PENDING_TAG, and can be restored by hand. It stops being injected, stops
   * counting toward the pending quota, and confirm-all can no longer reach it.
   */
  async reject(id) {
    const rec = this.table.get(id);
    if (!rec) return null;
    if (isRejected(rec)) return rec;          // idempotent
    const tags = [...new Set([...rec.tags.filter((t) => t !== PENDING_TAG), REJECTED_TAG])];
    const updated = { ...rec, tags, rejectedAt: nowIso(), updatedAt: nowIso() };
    await this.table.put(id, updated);
    await this._afterWrite();
    return updated;
  }

  /** Put a rejected memory back in the review queue (invariant 4). */
  async restoreRejected(id) {
    const rec = this.table.get(id);
    if (!rec) return null;
    if (!isRejected(rec)) return null;
    const tags = [...new Set([...rec.tags.filter((t) => t !== REJECTED_TAG), PENDING_TAG])];
    const updated = { ...rec, tags, rejectedAt: null, updatedAt: nowIso() };
    await this.table.put(id, updated);
    await this._afterWrite();
    return updated;
  }

  /** The discard pile, newest first, for the panel's rejected section. */
  listRejected() {
    return this.all().filter(isRejected)
      .sort((a, b) => String(b.rejectedAt ?? b.updatedAt).localeCompare(String(a.rejectedAt ?? a.updatedAt)));
  }

  /**
   * List records the adjudicator AUTO-CONFIRMED (carry AUTO_CONFIRMED_TAG).
   * This is the "recently auto-confirmed" review surface: auto-confirm is only
   * acceptable because it stays VISIBLE here and REVOCABLE via revokeAutoConfirm.
   * Newest first. Read-only.
   */
  listAutoConfirmed() {
    return this.all()
      .filter((r) => r.tags.includes(AUTO_CONFIRMED_TAG))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((r) => ({
        id: r.id, kind: r.kind, importance: r.importance, scope: r.scope,
        createdAt: r.createdAt,
        content: String(r.content).replace(/\n/g, ' ').slice(0, 100),
      }));
  }

  /**
   * Revoke an auto-confirmation: send the record BACK to pending for human
   * review (or delete it outright with drop=true). The human override on the
   * auto path — nothing the adjudicator let through is irreversible.
   */
  async revokeAutoConfirm(id, opts = {}) {
    const rec = this.table.get(id);
    if (!rec) return { revoked: 0 };
    if (!rec.tags.includes(AUTO_CONFIRMED_TAG)) return { revoked: 0, notAuto: 1 };
    if (opts.drop === true) {
      const ok = await this.table.delete(id);
      if (ok) { await this._afterWrite(); try { this.fts?.remove(id); } catch { /* best-effort */ } }
      return { revoked: ok ? 1 : 0, dropped: ok ? 1 : 0 };
    }
    const tags = rec.tags.filter((t) => t !== AUTO_CONFIRMED_TAG);
    if (!tags.includes(PENDING_TAG)) tags.push(PENDING_TAG);
    await this.table.put(id, { ...rec, tags, updatedAt: nowIso() });
    await this._afterWrite();
    return { revoked: 1, backToPending: 1 };
  }

  /** Recall by query. touch=true refreshes access (recall counts as activity). */
  async recall(query, limit, options = {}) {
    // includePending still excludes rejected: the user threw those away, and
    // 'include the queue' never meant 'include the discard pile'.
    const pool = options.includePending
      ? this.all().filter((r) => !isRejected(r))
      : this.confirmed();
    const want = limit ?? this.config.recallLimit;
    const bigramHits = rankRecords(pool, query, want, {
      recencyHalfLifeDays: this.config.recencyHalfLifeDays,
    });

    // Fuse with BM25 (FTS5) when available. FTS indexes ALL records, so scope
    // its ids to the same pool (confirmed-only for injection) before fusing —
    // pending memories must never leak into auto-injection via the lexical path.
    let hits = bigramHits;
    // R5: track which retrieval path actually served this query (observability).
    let path = this.fts?.available ? 'fused' : 'bigram-only';
    if (this.fts?.available) {
      try {
        const allowed = new Set(pool.map((r) => r.id));
        const now = Date.now();
        const ftsIds = this.fts
          .search(query, Math.max(want * 4, 20))
          .filter((id) => {
            if (!allowed.has(id)) return false;
            const r = this.table.get(id);
            return r && !isExpired(r, now);
          });
        if (ftsIds.length > 0) {
          hits = fuseRRF(bigramHits, ftsIds, this.recordsById(), want);
        }
      } catch {
        // fusion failed at runtime → degraded to bigram-only for this query.
        path = 'fts-degraded';
        this._retrieval.ftsErrorCount += 1;
      }
    }
    this._retrieval.lastPath = path;
    if (path === 'fused') this._retrieval.fusedCount += 1;
    else this._retrieval.bigramOnlyCount += 1;

    if (options.touch) {
      for (const { record } of hits) {
        try {
          await this.table.put(record.id, {
            ...record, accessedAt: nowIso(), accessCount: record.accessCount + 1,
          });
        } catch { /* best-effort */ }
      }
    }
    return hits;
  }

  async forget(id, confirmDelete) {
    const rec = this.table.get(id);
    if (!rec) return { deleted: 0 };
    // Data-layer pinned guard (v0.4.2): store.forget is the common path for ALL
    // deletes — the conversational memory_forget tool calls it directly, bypassing
    // authorizePruneAction. Guarding here means every entry point is immune.
    if (rec.pinned && confirmDelete !== true) {
      return { deleted: 0, skippedPinned: 1 };
    }
    if (rec.importance === 3 && confirmDelete !== true) {
      return { deleted: 0, skippedImportant: 1 };
    }
    const ok = await this.table.delete(id);
    if (ok) { await this._afterWrite(); try { this.fts?.remove(id); } catch { /* best-effort */ } }
    return { deleted: ok ? 1 : 0 };
  }

  /**
   * Soft-delete (v0.4.2): stamp forgottenAt, DO NOT physically delete. Recoverable
   * via restoreForgotten. Excluded from confirmed() (and thus every active-record
   * consumer) + recall/tier1. Pinned records need confirmSoft (same guard as forget).
   */
  async softForget(id, confirmSoft) {
    const rec = this.table.get(id);
    if (!rec) return { softDeleted: 0 };
    if (rec.pinned && confirmSoft !== true) {
      return { softDeleted: 0, skippedPinned: 1 };
    }
    if (rec.forgottenAt) return { softDeleted: 0, alreadyForgotten: 1 };
    await this.table.put(id, { ...rec, forgottenAt: nowIso() });
    await this._afterWrite();
    try { this.fts?.remove(id); } catch { /* best-effort */ }
    return { softDeleted: 1 };
  }

  /** Restore a soft-deleted record: clear the tombstone, re-index. (v0.4.2) */
  async restoreForgotten(id) {
    const rec = this.table.get(id);
    if (!rec) return { restored: 0 };
    if (!rec.forgottenAt) return { restored: 0, notForgotten: 1 };
    const updated = { ...rec, forgottenAt: '' };
    await this.table.put(id, updated);
    await this._afterWrite();
    try { this.fts?.upsert(updated); } catch { /* best-effort */ }
    return { restored: 1, record: updated };
  }

  list(filter = {}) {
    let pool = this.all();
    if (filter.kind) pool = pool.filter((r) => r.kind === filter.kind);
    if (filter.scope) pool = pool.filter((r) => r.scope === filter.scope);
    // A rejected record still carries no PENDING_TAG, so pending:false would
    // otherwise show it in the default view.
    if (filter.rejected === true) pool = pool.filter(isRejected);
    else if (filter.rejected !== 'any') pool = pool.filter((r) => !isRejected(r));
    if (filter.pending === true) pool = pool.filter((r) => r.tags.includes(PENDING_TAG));
    if (filter.pending === false) pool = pool.filter((r) => !r.tags.includes(PENDING_TAG));
    // v0.4.2: forgotten filter (tombstones). Default view excludes them; pass
    // forgotten:true to list only tombstones (for the restore UI).
    if (filter.forgotten === true) pool = pool.filter((r) => !!r.forgottenAt);
    else if (filter.forgotten === false) pool = pool.filter((r) => !r.forgottenAt);
    return pool;
  }

  /**
   * Current-snapshot memory statistics (no time-window aggregation — this plugin
   * deliberately keeps no event log, so "last 7d" counts are impossible; we
   * report what the store can honestly answer right now). injectionCount uses
   * the effective value (persisted + in-memory delta) so stats reflect the live
   * session too.
   */
  stats(opts = {}) {
    const topN = opts.topN ?? 5;
    // v0.4.2: total/byKind/byScope count LIVE records only; tombstones counted
    // separately as `forgotten`. Otherwise soft-deleted records inflate totals
    // and distributions, contradicting the user's "已忘记" mental model.
    const everything = this.all();
    const forgotten = everything.filter((r) => r.forgottenAt).length;
    const rejected = everything.filter((r) => !r.forgottenAt && isRejected(r)).length;
    // Rejected records are reported on their own, never folded into the active
    // totals or distributions -- they are things the user threw away.
    const all = everything.filter((r) => !r.forgottenAt && !isRejected(r));
    const byKind = {};
    const byScope = {};
    let pending = 0;
    for (const r of all) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byScope[r.scope] = (byScope[r.scope] ?? 0) + 1;
      if (r.tags.includes(PENDING_TAG)) pending += 1;
    }
    const brief = (r) => ({
      id: r.id, kind: r.kind, importance: r.importance,
      accessCount: r.accessCount ?? 0,
      injectionCount: this.effectiveInjectionCount(r),
      content: String(r.content).replace(/\n/g, ' ').slice(0, 60),
    });
    const topByAccess = [...all].sort((a, b) => (b.accessCount ?? 0) - (a.accessCount ?? 0))
      .slice(0, topN).filter((r) => (r.accessCount ?? 0) > 0).map(brief);
    const topByInjection = [...all].sort((a, b) => this.effectiveInjectionCount(b) - this.effectiveInjectionCount(a))
      .slice(0, topN).filter((r) => this.effectiveInjectionCount(r) > 0).map(brief);
    // pending queue = the audit-gate backlog, so a human has a visible list to
    // confirm from (replaces the rejected kind-based auto-confirm idea).
    const pendingQueue = all.filter((r) => r.tags.includes(PENDING_TAG))
      .sort((a, b) => (b.importance - a.importance))
      .map((r) => ({
        id: r.id, kind: r.kind, importance: r.importance,
        content: String(r.content).replace(/\n/g, ' ').slice(0, 80),
        // A2 (v0.5.0): source-context snippet for the review queue UI (why suggested).
        sourceContext: String(r.sourceContext ?? '').replace(/\n/g, ' ').slice(0, 200),
      }));
    return {
      rejected,
      total: all.length,
      confirmed: all.length - pending,
      pending,
      forgotten,
      maxRecords: this.config.maxRecords,
      byKind,
      byScope,
      topByAccess,
      topByInjection,
      pendingQueue,
    };
  }

  /**
   * Tier 1 always-on snapshot (v0.3.0): the small set of durable user
   * preferences/facts to inject on every turn/start — the dsh-evolve mirror of
   * the always-on snapshot. Pure filter + importance sort + char-budget
   * truncate; zero LLM. Excludes crystallized records (they live in skills now).
   */
  tier1Snapshot(opts = {}) {
    const maxChars = opts.maxChars ?? 2200;
    const kinds = opts.kinds ?? ['preference', 'fact'];
    const scope = opts.scope ?? 'user';
    const minImportance = opts.minImportance ?? 2;
    const now = opts.now ?? Date.now();
    const pool = this.confirmed().filter((r) => (
      kinds.includes(r.kind)
      && r.scope === scope
      && (r.importance ?? 0) >= minImportance
      && !r.crystallizedAt
      && !isExpired(r, now)
    ));
    pool.sort((a, b) => (b.importance - a.importance) || String(a.createdAt).localeCompare(String(b.createdAt)));
    const lines = [];
    let used = 0;
    for (const r of pool) {
      const line = `- [${r.kind}/imp${r.importance}] ${String(r.content).replace(/\s+/g, ' ').trim()}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return { empty: lines.length === 0, text: lines.join('\n'), usedChars: used, count: lines.length };
  }

  /**
   * User-profile view (v0.4.0 direction 2A): the agent's evolving understanding
   * of WHO this user is — confirmed scope=user preference/fact memories, grouped
   * by kind, newest-weighted by importance. This is the "auto-grown USER.md":
   * direction-3 background review proposes these from what the user says; the
   * adjudicator gates them; this surfaces the accumulated picture. Read-only.
   */
  profileView(opts = {}) {
    const now = opts.now ?? Date.now();
    const kinds = opts.kinds ?? ['preference', 'fact'];
    const pool = this.confirmed().filter((r) => (
      r.scope === 'user'
      && kinds.includes(r.kind)
      && !r.crystallizedAt
      && !isExpired(r, now)
    ));
    // Sort by reinforcement strength first (observationCount), then importance:
    // the understanding the user has shown most often surfaces first. This is
    // the trained kernel's output, not a raw dump.
    pool.sort((a, b) => (
      (b.observationCount ?? 1) - (a.observationCount ?? 1)
      || (b.importance - a.importance)
      || String(b.updatedAt).localeCompare(String(a.updatedAt))
    ));
    const byKind = {};
    for (const r of pool) {
      const obs = r.observationCount ?? 1;
      (byKind[r.kind] ??= []).push({
        id: r.id, importance: r.importance,
        observationCount: obs,
        confidence: obs >= (this.config.reinforceEvery ?? 3) ? 'high' : (obs >= 2 ? 'medium' : 'low'),
        content: String(r.content).replace(/\s+/g, ' ').trim(),
        tags: r.tags.filter((t) => t !== PENDING_TAG && t !== AUTO_CONFIRMED_TAG),
      });
    }
    return { total: pool.length, byKind };
  }

  /**
   * R5 (v0.5.0): retrieval-path observability snapshot. Read-only. Lets the
   * settings page show whether recall is running FUSED (bigram+FTS5 RRF) or has
   * silently degraded to BIGRAM-ONLY (FTS5 unavailable / disabled / erroring) —
   * a reduced-recall state the user was previously blind to.
   */
  retrievalStatus() {
    const ftsAvailable = !!this.fts?.available;
    return {
      ftsEnabled: this.config.ftsEnabled !== false,
      ftsAvailable,
      lastPath: this._retrieval.lastPath,
      fusedCount: this._retrieval.fusedCount,
      bigramOnlyCount: this._retrieval.bigramOnlyCount,
      ftsErrorCount: this._retrieval.ftsErrorCount,
      // human-facing verdict for the UI one-liner
      mode: !ftsAvailable ? 'bigram-only' : (this._retrieval.ftsErrorCount > 0 ? 'fts-degraded' : 'fused'),
    };
  }

  /**
   * Disposal-suggest candidates (v0.5.0 direction 2, ev审 B3/C3/C8/E1).
   *
   * The OBJECTIVE, non-heat candidate rule for the suggest tier. A record is a
   * low-value candidate ONLY if ALL hold:
   *   - not pinned                              (user explicitly protected it)
   *   - kind ∉ {preference, decision}           (protected kinds — never a subject)
   *   - not forgotten                           (already a tombstone)
   *   - not pending (C3)                        (a held-for-review item, NOT a
   *       cold asset — tier1 injects with {touch:false,includePending:false} so
   *       pending always shows zero-use; excluding it stops silently disposing
   *       the user's review backlog)
   *   - zero use on BOTH channels (B3/C8)       (effectiveInjectionCount===0 AND
   *       accessCount===0 — the two counters are complementary; heat is NOT used,
   *       honoring the heat-read-only invariant)
   *   - older than disposalMinIdleDays          (explicit cool-off, not heat decay)
   *
   * READ-ONLY: returns candidates for a human to review. Never disposes. This is
   * exactly the set the suggest tier surfaces and (in a future v0.6.x) the tidy
   * tier would act on — same rule, no separate candidate logic.
   */
  disposalCandidates(now = Date.now()) {
    const PROTECTED = new Set(['preference', 'decision']);
    const minIdleMs = Math.max(0, Number(this.config.disposalMinIdleDays ?? 30)) * 86400000;
    const out = [];
    for (const r of this.all()) {
      if (r.forgottenAt) continue;
      if (r.pinned) continue;
      if (PROTECTED.has(r.kind)) continue;
      if (r.tags?.includes(PENDING_TAG)) continue;                 // C3
      // Rejected records are kept forever and only a human may turn them into a
      // tombstone; tidy must never dispose of them automatically.
      if (isRejected(r)) continue;
      if (this.effectiveInjectionCount(r) !== 0) continue;         // B3/C8 channel 1
      if ((r.accessCount ?? 0) !== 0) continue;                    // B3/C8 channel 2
      const age = now - Date.parse(r.createdAt || 0);
      if (!(age >= minIdleMs)) continue;                           // explicit cool-off
      out.push({
        id: r.id, kind: r.kind, importance: r.importance,
        content: String(r.content).replace(/\n/g, ' ').slice(0, 80),
        ageDays: Math.floor(age / 86400000),
        reason: 'zero-use (never injected, never recalled) + past cool-off',
      });
    }
    return out;
  }

  /**
   * g3. Memory char-budget status over CONFIRMED memory (deterministic hard cap).
   * Never auto-drops — returns trim candidates so a human/model can merge/forget.
   */
  memoryBudgetStatus() {
    const max = this.config.memoryMaxChars ?? 0;
    if (!max || max <= 0) return { enabled: false };
    return { enabled: true, ...budgetStatus(this.confirmed(), max, this.config) };
  }

  /**
   * g4. Pre-write quality assessment (thin / reworded near-duplicate). Exposed so
   * the background-review path can skip low-signal or redundant writes. Uses the
   * wider maxContentOverlap gate (catches "same thing reworded" the exact-merge
   * threshold misses). Read-only.
   */
  assessWrite(candidate) {
    // v0.4.2: assess against confirmed() (live, non-pending, non-tombstone) —
    // NOT all(). Using all() let a soft-deleted record's near-duplicate get
    // judged 'near-duplicate' and silently blocked (the 2nd memory-black-hole
    // entry, via the background-review quality gate).
    return assessWriteQuality(candidate, this.confirmed(), {
      minPromoteChars: this.config.minPromoteChars,
      maxContentOverlap: this.config.maxContentOverlap,
    });
  }

  /**
   * g5. Project-scope memories reinforced enough to promote to user-scope
   * (local→global). Detection only. Read-only.
   */
  promotionCandidates() {
    return findPromotionCandidates(this.confirmed(), {
      promoteMinObservations: this.config.promoteMinObservations,
    });
  }

  /** g5. Promote one project-scope memory to user-scope (global). Reversible via re-scope. */
  async promoteToGlobal(id) {
    const rec = this.table.get(id);
    if (!rec) return { promoted: 0 };
    if (rec.scope !== 'project') return { promoted: 0, reason: 'not a project-scope memory' };
    const updated = { ...rec, scope: 'user', updatedAt: nowIso() };
    await this.table.put(id, updated);
    await this._afterWrite();
    try { this.fts?.upsert(updated); } catch { /* best-effort */ }
    return { promoted: 1, record: updated };
  }

  /** Evidence for skill crystallization: confirmed procedural records by tag. */
  crystallizationEvidence(kinds, minImportance) {
    const now = Date.now();
    const byTag = new Map();
    for (const r of this.confirmed()) {
      if (isExpired(r, now)) continue;
      if (!kinds.includes(r.kind)) continue;
      if (r.crystallizedAt) continue; // already used
      for (const tag of r.tags) {
        if (tag === PENDING_TAG) continue;
        const g = byTag.get(tag) ?? [];
        g.push(r);
        byTag.set(tag, g);
      }
    }
    const ready = [];
    for (const [tag, recs] of byTag) {
      const totalImp = recs.reduce((s, r) => s + r.importance, 0);
      if (recs.length >= (this.config.crystallizeMinEvidence ?? 3) && totalImp >= minImportance) {
        ready.push({ tag, records: recs });
      }
    }
    return ready;
  }

  /**
   * All confirmed, non-expired, not-yet-crystallized procedural evidence grouped
   * by tag, with NO count/importance threshold applied. Lets the caller decide
   * crystallize-vs-refine thresholds (a tag whose skill already exists on disk
   * refines at a lower bar than a brand-new tag crystallizes).
   * @returns Map<tag, records[]>
   */
  evidenceByTag(kinds) {
    const now = Date.now();
    const byTag = new Map();
    for (const r of this.confirmed()) {
      if (isExpired(r, now)) continue;
      if (!kinds.includes(r.kind)) continue;
      if (r.crystallizedAt) continue;
      for (const tag of r.tags) {
        if (tag === PENDING_TAG) continue;
        const g = byTag.get(tag) ?? [];
        g.push(r);
        byTag.set(tag, g);
      }
    }
    return byTag;
  }

  /** Stamp records as crystallized so they aren't reused as evidence. */
  async markCrystallized(ids) {
    const ts = nowIso();
    for (const id of ids) {
      const rec = this.table.get(id);
      if (rec) {
        try { await this.table.put(id, { ...rec, crystallizedAt: ts }); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Warn when the memory char budget is exceeded. Reports; never deletes.
   *
   * Renamed from _evict: that name outlived its behaviour by two versions and an
   * external review read it as dead code that still deleted records. The body is
   * unchanged -- the rename is about the name telling the truth.
   */
  async _reportOverBudget() {
    // v0.4.2: automatic PHYSICAL deletion is RETIRED. Capacity governance is now
    // "detect automatically, dispose explicitly": the char budget
    // (memoryBudgetStatus) + the prune panel own disposal, honoring soft-delete
    // and pinned/protected. Silently deleting live records here bypassed all of
    // that — and worse, soft-deleted tombstones still count toward table.size,
    // so panel soft-deletes could trigger eviction of LIVE records. Report only.
    // (Call site at remember()'s tail is intentionally kept so over-budget still
    // surfaces a warning; do NOT remove the call.)
    const status = this.memoryBudgetStatus();
    if (status.enabled && status.overBudget) {
      this.logger.warn?.(`[dsh-evolve] memory over budget (${status.used}/${status.max} chars) — review trim candidates via memory_budget or the prune panel`);
    }
  }

  // ── Markdown mirror + git checkpoints (human-owned, git-friendly) ─────────
  /**
   * Keep the workspace's runtime data out of the user's git history.
   *
   * The workspace often lives inside a repo the user commits, and the audit logs
   * and reservation sidecars contain memory content and quarantine metadata.
   * This narrows the leak surface -- it does NOT make anything safe on disk; the
   * real defence is not storing the original secret in the first place.
   *
   * Written once, never overwritten: the user may have edited it.
   */
  _ensureWorkspaceGitignore() {
    if (!this.workspaceDir) return;
    const path = join(this.workspaceDir, '.gitignore');
    const required = [
      '# dsh-evolve runtime data -- not source, and it contains memory content.',
      '# Narrows the git leak surface only; it does not protect the files on disk.',
      '*.jsonl',
      'skill-proposals/',
      '.curator-backups/',
      '.evolve-owner.json',
      '.evolve-reservations.json',
      'secret-incidents/',
      '.ops/',
      '.locks/',
      '.wal/',
      '.orphans/',
    ];
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = current.split('\n');
    const missing = required.filter((line) => !lines.includes(line));
    if (missing.length === 0) return;
    writeFileSync(path, `${current.replace(/\s*$/, '')}${current.trim() ? '\n' : ''}${missing.join('\n')}\n`);
  }

  _renderMirror() {
    if (!this.workspaceDir) return;
    mkdirSync(this.workspaceDir, { recursive: true });
    try { this._ensureWorkspaceGitignore(); } catch { /* best-effort */ }
    const live = this.all().filter((r) => !r.forgottenAt);
    const forgotten = this.all().filter((r) => r.forgottenAt);
    const recs = live.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    const lines = ['# Memory mirror (dsh-evolve)', '', '> Human-readable mirror of the JSON truth store. Edit memories via the memory_* tools; this file is regenerated after each write.', ''];
    let curKind = '';
    for (const r of recs) {
      if (r.kind !== curKind) { curKind = r.kind; lines.push(`## ${curKind}`, ''); }
      const flags = [`imp${r.importance}`, r.scope, ...(r.pinned ? ['PINNED'] : []), ...(r.tags.includes(PENDING_TAG) ? ['PENDING'] : [])].join(' ');
      lines.push(`- [${r.id}] (${flags}) ${r.content.replace(/\n/g, ' ')}`);
    }
    // v0.4.2: soft-deleted records live in their own section, clearly flagged —
    // never mixed silently into the active mirror.
    if (forgotten.length > 0) {
      lines.push('', '## Forgotten (recoverable)', '');
      for (const r of forgotten) {
        lines.push(`- [${r.id}] (FORGOTTEN ${r.kind} imp${r.importance}) ${r.content.replace(/\n/g, ' ')}`);
      }
    }
    lines.push('');
    writeFileSync(join(this.workspaceDir, 'MEMORY.md'), lines.join('\n'));
  }

  _scheduleCommit() {
    if (!this.workspaceDir || !existsSync(join(this.workspaceDir, '.git'))) return;
    if (this._commitTimer) clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(() => {
      this._commitTimer = null;
      this._commit();
    }, 1500);
  }

  _commit() {
    const ws = this.workspaceDir;
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' });
      if (dirty.trim() === '') return;
      execFileSync('git', ['add', '-A'], { cwd: ws, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=dsh-evolve', '-c', 'user.email=evolve@dsh.local',
        'commit', '-m', `memory: checkpoint ${new Date().toISOString().slice(0, 16)}`], { cwd: ws, stdio: 'ignore' });
      this.logger.info?.('[dsh-evolve] memory checkpoint committed');
      if (this.onCommit) { try { this.onCommit(); } catch { /* best-effort */ } }
    } catch { /* commit failure is non-fatal */ }
  }
}
