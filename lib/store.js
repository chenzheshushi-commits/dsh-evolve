/**
 * Memory store: JSON truth (via ctx.storageDomain) + human-owned approval gate
 * + Markdown mirror + git checkpoints.
 *
 *  - Truth lives in the harness storage domain (stock json backend →
 *    $DSH_HOME/storages/*.json). Deterministic, zero-LLM.
 *  - Approval gate: model writes land as status implied by
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEMORY_DEFAULTS, isValidKind, isValidScope, clampImportance,
} from './spec.js';
import {
  rankRecords, isExpired, tokenSetBigram, jaccard, fuseRRF,
} from './search.js';

const PENDING_TAG = 'pending';

function nowIso {
  return new Date.toISOString;
}
function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max);
}
function newId {
  return `mem_${Date.now.toString(36)}_${Math.random.toString(36).slice(2, 8)}`;
}

export class MemoryStore {
  /**
   * @param table   the opened domain table (put/get/delete/entries/update/size)
   * @param options { workspaceDir, config, logger, fts, onCommit }
   */
  constructor(table, options = {}) {
    this.table = table;
    this.config = {...MEMORY_DEFAULTS,...(options.config ?? {}) };
    this.workspaceDir = options.workspaceDir;
    this.logger = options.logger ?? { warn {}, info {} };
    this.onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;
    // Optional derived FTS5 index (NullFts when unavailable). Backfilled from
    // the current record set so recall fuses BM25 with bigram-Jaccard.
    this.fts = options.fts ?? null;
    this._commitTimer = null;
    if (this.fts?.available) {
      try { this.fts.backfill(this.all); } catch { /* best-effort */ }
    }
  }

  all {
    return [...this.table.entries].map(([, v]) => v);
  }

  /** Map<id, record> over the current set (for FTS-only id resolution in fusion). */
  recordsById {
    const m = new Map;
    for (const r of this.all) m.set(r.id, r);
    return m;
  }

  /** Confirmed = not carrying the pending tag. Only these auto-inject. */
  confirmed {
    return this.all.filter((r) => !r.tags.includes(PENDING_TAG));
  }

  async _afterWrite {
    try { this._renderMirror; } catch (e) { this.logger.warn(`mirror failed: ${e?.message ?? e}`); }
    this._scheduleCommit;
  }

  /** Insert or merge one memory. Model writes are pending unless confirm=true. */
  async remember(input) {
    const now = input.now ?? Date.now;
    const kind = isValidKind(input.kind) ? input.kind : 'note';
    const scope = isValidScope(input.scope) ? input.scope : 'project';
    const importance = clampImportance(input.importance);
    const content = truncate(String(input.content ?? '').trim, this.config.maxContentChars);
    if (content === '') return null;

    const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((t) => String(t).toLowerCase))] : [];
    // Human-approval gate: unless explicitly confirmed, mark pending.
    if (input.confirm !== true && !tags.includes(PENDING_TAG)) tags.push(PENDING_TAG);

    // Near-duplicate merge (Jaccard over bigrams >= mergeSimilarity).
    const incoming = tokenSetBigram(content);
    for (const [key, rec] of [...this.table.entries]) {
      if (rec.scope !== scope || rec.kind !== kind) continue;
      if (jaccard(incoming, tokenSetBigram(rec.content)) >= this.config.mergeSimilarity) {
        const merged = {...rec,
          content,
          tags: [...new Set([...rec.tags.filter((t) => t !== PENDING_TAG),...tags])],
          importance: Math.max(rec.importance, importance),
          updatedAt: new Date(now).toISOString,
        };
        await this.table.put(key, merged);
        await this._afterWrite;
        try { this.fts?.upsert(merged); } catch { /* best-effort */ }
        return merged;
      }
    }

    const id = newId;
    const record = {
      id, content, kind, tags, scope,
      project: String(input.project ?? ''),
      importance,
      createdAt: new Date(now).toISOString,
      updatedAt: new Date(now).toISOString,
      accessedAt: '', accessCount: 0,
      expiresAt: input.expiresAt ?? '',
      crystallizedAt: '',
    };
    await this.table.put(id, record);
    await this._evict;
    await this._afterWrite;
    try { this.fts?.upsert(record); } catch { /* best-effort */ }
    return record;
  }

  /** Confirm a pending memory (human-owned). Strips the pending tag. */
  async confirm(id) {
    const rec = this.table.get(id);
    if (!rec) return null;
    const updated = {...rec, tags: rec.tags.filter((t) => t !== PENDING_TAG), updatedAt: nowIso };
    await this.table.put(id, updated);
    await this._afterWrite;
    return updated;
  }

  /** Recall by query. touch=true refreshes access (recall counts as activity). */
  async recall(query, limit, options = {}) {
    const pool = options.includePending ? this.all : this.confirmed;
    const want = limit ?? this.config.recallLimit;
    const bigramHits = rankRecords(pool, query, want, {
      recencyHalfLifeDays: this.config.recencyHalfLifeDays,
    });

    // Fuse with BM25 (FTS5) when available. FTS indexes ALL records, so scope
    // its ids to the same pool (confirmed-only for injection) before fusing —
    // pending memories must never leak into auto-injection via the lexical path.
    let hits = bigramHits;
    if (this.fts?.available) {
      try {
        const allowed = new Set(pool.map((r) => r.id));
        const now = Date.now;
        const ftsIds = this.fts.search(query, Math.max(want * 4, 20)).filter((id) => {
            if (!allowed.has(id)) return false;
            const r = this.table.get(id);
            return r && !isExpired(r, now);
          });
        if (ftsIds.length > 0) {
          hits = fuseRRF(bigramHits, ftsIds, this.recordsById, want);
        }
      } catch { /* fusion is best-effort; fall back to bigramHits */ }
    }

    if (options.touch) {
      for (const { record } of hits) {
        try {
          await this.table.put(record.id, {...record, accessedAt: nowIso, accessCount: record.accessCount + 1,
          });
        } catch { /* best-effort */ }
      }
    }
    return hits;
  }

  async forget(id, confirmDelete) {
    const rec = this.table.get(id);
    if (!rec) return { deleted: 0 };
    if (rec.importance === 3 && confirmDelete !== true) {
      return { deleted: 0, skippedImportant: 1 };
    }
    const ok = await this.table.delete(id);
    if (ok) { await this._afterWrite; try { this.fts?.remove(id); } catch { /* best-effort */ } }
    return { deleted: ok ? 1 : 0 };
  }

  list(filter = {}) {
    let pool = this.all;
    if (filter.kind) pool = pool.filter((r) => r.kind === filter.kind);
    if (filter.scope) pool = pool.filter((r) => r.scope === filter.scope);
    if (filter.pending === true) pool = pool.filter((r) => r.tags.includes(PENDING_TAG));
    if (filter.pending === false) pool = pool.filter((r) => !r.tags.includes(PENDING_TAG));
    return pool;
  }

  /** Evidence for skill crystallization: confirmed procedural records by tag. */
  crystallizationEvidence(kinds, minImportance) {
    const now = Date.now;
    const byTag = new Map;
    for (const r of this.confirmed) {
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
    const now = Date.now;
    const byTag = new Map;
    for (const r of this.confirmed) {
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
    const ts = nowIso;
    for (const id of ids) {
      const rec = this.table.get(id);
      if (rec) {
        try { await this.table.put(id, {...rec, crystallizedAt: ts }); } catch { /* ignore */ }
      }
    }
  }

  async _evict {
    const excess = this.table.size - this.config.maxRecords;
    if (excess <= 0) return;
    const all = this.all;
    const sortKey = (r) => r.accessedAt || r.updatedAt;
    const nonCritical = all.filter((r) => r.importance < 3).sort((a, b) => (
      a.importance !== b.importance ? a.importance - b.importance
        : (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)
    ));
    const critical = all.filter((r) => r.importance === 3).sort((a, b) => (
      sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0
    ));
    const victims = [...nonCritical,...critical].slice(0, excess);
    for (const v of victims) {
      try { await this.table.delete(v.id); } catch { /* ignore */ }
      try { this.fts?.remove(v.id); } catch { /* ignore */ }
    }
  }

  // ── Markdown mirror + git checkpoints (human-owned, git-friendly) ─────────
  _renderMirror {
    if (!this.workspaceDir) return;
    mkdirSync(this.workspaceDir, { recursive: true });
    const recs = this.all.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    const lines = ['# Memory mirror (dsh-evolve)', '', '> Human-readable mirror of the JSON truth store. Edit memories via the memory_* tools; this file is regenerated after each write.', ''];
    let curKind = '';
    for (const r of recs) {
      if (r.kind !== curKind) { curKind = r.kind; lines.push(`## ${curKind}`, ''); }
      const flags = [`imp${r.importance}`, r.scope,...(r.tags.includes(PENDING_TAG) ? ['PENDING'] : [])].join(' ');
      lines.push(`- [${r.id}] (${flags}) ${r.content.replace(/\n/g, ' ')}`);
    }
    lines.push('');
    writeFileSync(join(this.workspaceDir, 'MEMORY.md'), lines.join('\n'));
  }

  _scheduleCommit {
    if (!this.workspaceDir || !existsSync(join(this.workspaceDir, '.git'))) return;
    if (this._commitTimer) clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout( => {
      this._commitTimer = null;
      this._commit;
    }, 1500);
  }

  _commit {
    const ws = this.workspaceDir;
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' });
      if (dirty.trim === '') return;
      execFileSync('git', ['add', '-A'], { cwd: ws, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=dsh-evolve', '-c', 'user.email=evolve@dsh.local',
        'commit', '-m', `memory: checkpoint ${new Date.toISOString.slice(0, 16)}`], { cwd: ws, stdio: 'ignore' });
      this.logger.info?.('[dsh-evolve] memory checkpoint committed');
      if (this.onCommit) { try { this.onCommit; } catch { /* best-effort */ } }
    } catch { /* commit failure is non-fatal */ }
  }
}
