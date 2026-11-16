/**
 * Built-in memory history: restorable snapshots of the record table, with no
 * external binary and no network.
 *
 * WHY THIS EXISTS (2026-11-16): "rollback" used to be delegated to `git` in the
 * plugin workspace, and `MemoryStore._scheduleCommit()` returns immediately when
 * `<workspace>/.git` is absent. On any machine without git on PATH (a default
 * Windows install, a slim Linux image, a container) every write therefore
 * produced NO history at all and the plugin said nothing about it. The settings
 * page, the web profile and the desktop app all lost the feature identically,
 * because this code runs on the HOST, not in the UI.
 *
 * Even WITH git it was not a rollback: the checkpoint committed MEMORY.md (a
 * human-readable mirror) while the truth store lives in
 * `$DSH_HOME/storages/evolve_memory.json`, outside that repository — and no code
 * reads MEMORY.md back into the store. So the old feature could show you what
 * memory used to say; it could not put it back.
 *
 * Layout (inside the plugin workspace, gitignored):
 *   memory-history/<UTC stamp>-<rand>.json   one complete snapshot per change
 *   memory-history/index.json                cheap listing for the panel
 *
 * Two deliberate semantics:
 *   - USAGE_FIELDS are not restored. Reverting heat makes a memory that was just
 *     used look cold again, and the tidy tier would then read it as waste.
 *     "Rollback" means content and state, not telemetry.
 *   - A restore never physically deletes anything: records created after the
 *     snapshot are soft-deleted through the same tombstone the tidy tier writes,
 *     and the pre-restore state is snapshotted first, so a wrong restore is
 *     itself reversible.
 *
 * @module dsh-evolve/memory-history
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';

/** Subdirectory of the plugin workspace that holds snapshots. */
export const HISTORY_DIRNAME = 'memory-history';
/** How many snapshots the ring keeps (newest win). */
export const MAX_SNAPSHOTS = 40;
/** Total size cap for the ring; old snapshots are dropped past this. */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** Snapshot document version. A document from another version is refused, not guessed at. */
export const SNAPSHOT_VERSION = 1;
/** `<YYYYMMDD>T<HHMMSSmmm>-<6 hex>` — UTC so lexical order == chronological order. */
export const SNAPSHOT_ID_RE = /^(\d{8})T(\d{9})-([0-9a-f]{6})$/;

/**
 * The fields a restore writes back: content and state a human chose.
 *
 * Deliberately explicit (not "everything except usage"): a future record field
 * added for telemetry must not silently start participating in rollback. A test
 * pins this list against the record schema so a new user-visible field cannot be
 * forgotten either.
 */
export const RESTORE_FIELDS = Object.freeze([
  'content', 'kind', 'tags', 'scope', 'project', 'importance',
  'createdAt', 'updatedAt', 'expiresAt', 'crystallizedAt',
  'forgottenAt', 'pinned', 'sourceContext',
]);

/**
 * Fields that describe USE or AUDIT ORIGIN, not user intent, kept from the live
 * record when it still exists. Heat is a current signal: restoring an old counter
 * would make a memory that was used five minutes ago look cold — and `tidy`
 * disposes what looks cold. `provenance` records how THIS record came to exist;
 * the restore did not create it, so the live value stays honest.
 *
 * A test pins RESTORE_FIELDS ∪ USAGE_FIELDS ∪ {id} against the record schema, so a
 * new field cannot be added to the schema without a decision about rollback.
 */
export const USAGE_FIELDS = Object.freeze([
  'accessCount', 'injectionCount', 'observationCount', 'accessedAt', 'reinforcedAt',
  'forgottenGeneration', 'provenance',
]);

/** Canonical JSON: sorted object keys at every depth, so a hash is stable. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The rollback-relevant view of a record (content + state, no usage telemetry). */
export function restorableView(record) {
  const out = {};
  for (const field of RESTORE_FIELDS) if (record && field in record) out[field] = record[field];
  return out;
}

/** Canonical string of the rollback-relevant view — what "changed" means. */
export function restorableKey(record) {
  return canonicalJson(restorableView(record));
}

/** Keep the live usage counters for a record that still exists. */
export function pickUsage(record) {
  const out = {};
  for (const field of USAGE_FIELDS) if (record && field in record) out[field] = record[field];
  return out;
}

/** One hash for a whole record table's restorable view (used in the listing). */
export function stateHashOf(records) {
  const ordered = [...(records ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(ordered.map(restorableKey).join('\n'));
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Snapshot id for a moment in time: UTC, fixed width, lexically sortable. */
export function snapshotIdFor(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`
    + `-${randomBytes(3).toString('hex')}`;
}

/** Inverse of {@link snapshotIdFor}: the ISO time a snapshot was taken. */
export function takenAtOf(id) {
  const m = SNAPSHOT_ID_RE.exec(String(id ?? ''));
  if (!m) return null;
  const [, day, time] = m;
  return new Date(Date.UTC(
    Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)),
    Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6)), Number(time.slice(6, 9)),
  )).toISOString();
}

/** Truncate a memory body for a diff sample (never the whole snapshot). */
function sample(record) {
  return {
    id: record.id,
    kind: record.kind ?? 'note',
    content: String(record.content ?? '').replace(/\n/g, ' ').slice(0, 120),
  };
}

export class MemoryHistory {
  constructor({
    workspaceDir = null, logger = null,
    maxSnapshots = MAX_SNAPSHOTS, maxTotalBytes = MAX_TOTAL_BYTES,
    debounceMs = 2000, now = () => Date.now(),
  } = {}) {
    this.workspaceDir = workspaceDir || null;
    this.logger = logger;
    this.maxSnapshots = Math.max(1, Number(maxSnapshots) || MAX_SNAPSHOTS);
    this.maxTotalBytes = Math.max(1024, Number(maxTotalBytes) || MAX_TOTAL_BYTES);
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.now = now;
    this._timer = null;
    this._pending = null;
    this._index = null;
  }

  /** Whether this instance can store anything at all. */
  get enabled() { return Boolean(this.workspaceDir); }

  /** Absolute snapshot directory (null when disabled). */
  get dir() { return this.workspaceDir ? join(this.workspaceDir, HISTORY_DIRNAME) : null; }

  _ensureDir() {
    if (!this.dir) throw new Error('memory-history: no workspace');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Resolve a snapshot id to a path INSIDE the snapshot dir, or null. */
  _pathOf(id) {
    if (!this.dir || typeof id !== 'string' || !SNAPSHOT_ID_RE.test(id)) return null;
    return join(this.dir, `${id}.json`);
  }

  _idsOnDisk() {
    if (!this.dir || !existsSync(this.dir)) return [];
    try {
      return readdirSync(this.dir)
        .filter((name) => SNAPSHOT_ID_RE.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, ''))
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    } catch { return []; }
  }

  _entryOf(id, overrides = {}) {
    const file = this._pathOf(id);
    let count = 0;
    let bytes = 0;
    let contentHash = '';
    if (file && existsSync(file)) {
      try {
        bytes = statSync(file).size;
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        if (doc && Number.isInteger(doc.count)) count = doc.count;
        if (doc && typeof doc.contentHash === 'string') contentHash = doc.contentHash;
      } catch { /* an unreadable file is listed as an empty snapshot */ }
    }
    return { id, takenAt: takenAtOf(id), count, bytes, contentHash, ...overrides };
  }

  /**
   * Read the index, rebuilding it from the directory when it is missing or
   * corrupt. The index exists so the settings page can list snapshots without
   * parsing 40 × 150 KB of JSON on every poll.
   */
  _loadIndex() {
    if (this._index) return this._index;
    let entries = null;
    const file = this.dir ? join(this.dir, 'index.json') : null;
    if (file && existsSync(file)) {
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        if (doc && Number.isInteger(doc.version) && Array.isArray(doc.entries)) {
          entries = doc.entries.filter((e) => e && SNAPSHOT_ID_RE.test(String(e.id ?? '')));
        }
      } catch { entries = null; }
    }
    if (!entries) entries = this._idsOnDisk().map((id) => this._entryOf(id));
    // A snapshot file deleted behind our back must not linger in the listing.
    const onDisk = new Set(this._idsOnDisk());
    entries = entries.filter((e) => onDisk.has(e.id))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    this._index = entries;
    return entries;
  }

  _writeIndex(entries) {
    if (!this.dir) return;
    this._ensureDir();
    const body = `${JSON.stringify({ version: SNAPSHOT_VERSION, entries }, null, 0)}\n`;
    try { writeFileAtomic(join(this.dir, 'index.json'), body, 0o600); } catch (e) {
      // A stale index is survivable (it is rebuilt from the directory); never let
      // it break the write that triggered the snapshot.
      this.logger?.warn?.(`[dsh-evolve] memory-history index write failed: ${e?.message ?? e}`);
    }
    this._index = entries;
  }

  /** Newest snapshot's entry, or null. */
  latest() {
    const entries = this._loadIndex();
    return entries.length > 0 ? entries[0] : null;
  }

  /**
   * Take a snapshot of `records` right now.
   *
   * Deduplicated by content: a write that leaves the restorable view identical
   * (a mirror re-render, a usage-counter flush) does not mint a second snapshot.
   *
   * @returns {{ok:boolean, id?:string, takenAt?:string, count?:number, bytes?:number, skipped?:string, pruned?:number}}
   */
  captureNow(records) {
    if (!this.enabled) return { ok: false, skipped: 'no-workspace' };
    if (!Array.isArray(records)) return { ok: false, skipped: 'no-records' };
    try {
      this._ensureDir();
      const ordered = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const contentHash = sha256(ordered.map(restorableKey).join('\n'));
      const latest = this.latest();
      if (latest && latest.contentHash === contentHash) {
        return { ok: true, skipped: 'unchanged', id: latest.id, takenAt: latest.takenAt, count: latest.count };
      }
      const takenAt = new Date(this.now()).toISOString();
      const id = snapshotIdFor(this.now());
      const doc = {
        version: SNAPSHOT_VERSION,
        plugin: 'dsh-evolve',
        takenAt,
        count: ordered.length,
        contentHash,
        records: ordered,
      };
      const body = `${JSON.stringify(doc)}\n`;
      const bytes = Buffer.byteLength(body);
      const file = this._pathOf(id);
      if (!file) return { ok: false, skipped: 'bad-id' };
      writeFileAtomic(file, body, 0o600);
      const entry = { id, takenAt, count: ordered.length, bytes, contentHash };
      const pruned = this._prune([entry, ...this._loadIndex().filter((e) => e.id !== id)]);
      return { ok: true, id, takenAt, count: ordered.length, bytes, pruned };
    } catch (e) {
      this.logger?.warn?.(`[dsh-evolve] memory snapshot failed: ${e?.message ?? e}`);
      return { ok: false, skipped: 'write-failed', error: String(e?.message ?? e) };
    }
  }

  /**
   * Drop the oldest snapshots past the count/size caps.
   *
   * The newest entry is always kept: a ring that pruned itself to zero would
   * silently remove the very risk the feature exists for.
   */
  _prune(entries) {
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    let kept = sorted.slice(0, this.maxSnapshots);
    let total = kept.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
    while (kept.length > 1 && total > this.maxTotalBytes) {
      const dropped = kept[kept.length - 1];
      total -= dropped.bytes ?? 0;
      kept = kept.slice(0, -1);
      try { rmSync(this._pathOf(dropped.id), { force: true }); } catch { /* best-effort */ }
    }
    for (const dropped of sorted.slice(kept.length)) {
      try { rmSync(this._pathOf(dropped.id), { force: true }); } catch { /* best-effort */ }
    }
    this._writeIndex(kept);
    return sorted.length - kept.length;
  }

  /**
   * Schedule a snapshot (trailing debounce, like the git commit).
   *
   * Bursts (confirm-all on 50 pending records) produce one snapshot, not fifty:
   * the rollback point that matters is the state before the burst, and it is
   * already on disk.
   *
   * The timer is unref'd so a snapshot never keeps the process alive; the store
   * flushes on dispose for the case where the process exits within the window.
   */
  schedule(getRecords) {
    if (!this.enabled || typeof getRecords !== 'function') return;
    if (this.debounceMs === 0) { this.captureNow(getRecords()); return; }
    this._pending = getRecords;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      const provider = this._pending;
      this._pending = null;
      if (!provider) return;
      try { this.captureNow(provider()); } catch { /* captureNow already logs */ }
    }, this.debounceMs);
    this._timer.unref?.();
  }

  /** Snapshot immediately, cancelling any pending timer. Safe to call on dispose. */
  flush(getRecords) {
    const provider = this._pending ?? (typeof getRecords === 'function' ? getRecords : null);
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending = null;
    if (!provider) return null;
    try { return this.captureNow(provider()); } catch { return null; }
  }

  /** Cancel a pending snapshot without writing one. */
  cancel() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending = null;
  }

  /** Listing for the settings page (index-only; never parses snapshot bodies). */
  list() {
    if (!this.enabled) {
      return { enabled: false, snapshots: [], totalBytes: 0, latestAt: null,
        limits: { maxSnapshots: this.maxSnapshots, maxBytes: this.maxTotalBytes, dir: null } };
    }
    const entries = this._loadIndex();
    return {
      enabled: true,
      snapshots: entries.map((e) => ({ id: e.id, takenAt: e.takenAt, count: e.count, bytes: e.bytes })),
      totalBytes: entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
      latestAt: entries[0]?.takenAt ?? null,
      limits: { maxSnapshots: this.maxSnapshots, maxBytes: this.maxTotalBytes, dir: this.dir },
    };
  }

  /**
   * Read one snapshot back.
   *
   * The file hash is returned alongside the records: the restore capability is
   * bound to it, so a snapshot edited on disk between the preview and the click
   * cannot authorize the restore of different content.
   */
  read(id) {
    const file = this._pathOf(id);
    if (!file) return { ok: false, error: 'invalid-snapshot-id' };
    if (!existsSync(file)) return { ok: false, error: 'unknown-snapshot' };
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    let doc;
    try { doc = JSON.parse(raw); } catch { return { ok: false, error: 'unreadable-snapshot' }; }
    if (!doc || doc.version !== SNAPSHOT_VERSION) return { ok: false, error: 'unsupported-snapshot-version' };
    if (!Array.isArray(doc.records)) return { ok: false, error: 'unreadable-snapshot' };
    if (Number.isInteger(doc.count) && doc.count !== doc.records.length) {
      return { ok: false, error: 'snapshot-count-mismatch' };
    }
    const records = doc.records.filter((r) => r && typeof r.id === 'string');
    return {
      ok: true,
      id,
      takenAt: doc.takenAt ?? takenAtOf(id),
      contentHash: doc.contentHash ?? null,
      sha256: sha256(raw),
      records,
    };
  }

  /** What the capability is minted against: the snapshot's identity and bytes. */
  mintTarget(id) {
    const snap = this.read(id);
    if (!snap.ok) throw new Error(snap.error);
    return { snapshotId: snap.id, snapshotSha256: snap.sha256 };
  }

  /**
   * Difference between a snapshot and the live table, in the same terms a restore
   * acts on (content + state; usage telemetry ignored).
   *
   * A completed restore converges: the same diff then reports zeros, so "did it
   * actually apply" is answerable from the panel rather than from the response text.
   *
   * `retired` is the number of live records a restore would soft-delete — the
   * panel shows it and sends it back, so a store that gained records between the
   * preview and the click is refused with a fresh diff instead of quietly
   * tombstoning memories the operator never saw.
   */
  diff(id, currentRecords) {
    const snap = this.read(id);
    if (!snap.ok) return snap;
    const before = new Map(snap.records.map((r) => [r.id, r]));
    const now = new Map((currentRecords ?? []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [rid, rec] of now) {
      const old = before.get(rid);
      // A record the snapshot does not know AND that is already a tombstone is not a
      // change a restore would make -- listing it would make a completed restore look
      // like it still has work to do.
      if (!old) { if (!rec.forgottenAt) added.push(sample(rec)); }
      else if (restorableKey(old) !== restorableKey(rec)) {
        changed.push({ ...sample(rec), before: String(old.content ?? '').replace(/\n/g, ' ').slice(0, 120) });
      }
    }
    for (const [rid, rec] of before) if (!now.has(rid)) removed.push(sample(rec));
    const wouldRetire = [...now.values()].filter((r) => !before.has(r.id) && !r.forgottenAt).length;
    return {
      ok: true,
      snapshot: { id: snap.id, takenAt: snap.takenAt, count: snap.records.length, sha256: snap.sha256 },
      counts: { added: added.length, removed: removed.length, changed: changed.length, wouldRetire },
      samples: { added: added.slice(0, 50), removed: removed.slice(0, 50), changed: changed.slice(0, 50) },
    };
  }
}
