/**
 * Optional FTS5 lexical index over memory records (v0.2.0).
 *
 * WHY: pure bigram-Jaccard (search.js) is precise on short CJK but weak on long,
 * multi-topic documents and spaced/ASCII-heavy text — exactly the "我去年那次处理
 * XX 客户的话怎么回应" recall case. FTS5 BM25 handles length normalization and
 * term saturation properly. We KEEP bigram-Jaccard and ADD BM25 as a
 * complementary signal, fused via RRF in the store (neither replaces the other).
 *
 * DESIGN:
 *  - Source of truth stays in the JSON storage domain. This index is DERIVED:
 *    built in memory at boot from the store, kept in sync on writes. Never
 *    persisted → no corruption/staleness risk, rebuild is trivial (store capped
 *    at MEMORY_DEFAULTS.maxRecords).
 *  - Uses node:sqlite (built into Node 22.5+; verified present + FTS5 compiled
 *    in on this host's node22). If unavailable, createFtsIndex() returns a
 *    NullFts and the store silently falls back to bigram-only recall — no throw,
 *    no behavior regression, honoring the "never brick the harness" contract.
 *  - CJK correctness: FTS5's stock tokenizers do NOT segment Chinese (trigram
 *    needs >=3 chars so 2-char queries like "客户" miss; unicode61 keeps CJK runs
 *    whole so "苹果公司" is one un-queryable token). We sidestep this by feeding
 *    FTS5 our OWN tokens (search.js tokenizeBigram: ASCII word runs + CJK
 *    bigrams), each encoded to a pure-ASCII term that unicode61 cannot further
 *    split or case/diacritic-fold. BM25 then ranks over exactly the tokens
 *    bigram-Jaccard uses — same recall surface, better ranking. (Verified:
 *    "苹果" matches only docs containing 苹果, never 水果 via shared 果.)
 *
 * No LLM. No session-log writes. Every method best-effort.
 *
 * @module @local/dsh-evolve/fts
 */
import { tokenizeBigram } from './search.js';

/**
 * Encode one bigram/word token into a pure-ASCII FTS term. ASCII words pass
 * through; anything containing non-[a-z0-9] (i.e. CJK bigrams) becomes
 * `z<hex codepoints>` so unicode61 treats it as one atomic, fold-proof token.
 */
function encodeToken(tok) {
  if (/^[a-z0-9]+$/.test(tok)) return tok;
  let s = 'z';
  for (const ch of tok) s += ch.codePointAt(0).toString(16);
  return s;
}

/** Space-joined encoded tokens for indexing a record's content. */
function encodeText(text) {
  return tokenizeBigram(text).map(encodeToken).join(' ');
}

/**
 * Build an FTS5 MATCH expression (OR of quoted encoded terms) for a query, or
 * '' when the query yields no tokens. Terms are pure ASCII post-encoding, but
 * we quote defensively so an FTS5 operator can never leak in from content.
 */
function encodeQuery(text) {
  const toks = [...new Set(tokenizeBigram(text).map(encodeToken))];
  if (toks.length === 0) return '';
  return toks.map((t) => `"${t}"`).join(' OR ');
}

/** No-op index used when node:sqlite / FTS5 is unavailable or disabled. */
class NullFts {
  get available() { return false; }
  backfill() {}
  upsert() {}
  remove() {}
  search() { return []; }
  close() {}
}

/** In-memory FTS5 index keyed by record id. */
class FtsIndex {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger ?? { warn() {} };
    this._insert = db.prepare('INSERT INTO m(rid, toks) VALUES (?, ?)');
    this._delete = db.prepare('DELETE FROM m WHERE rid = ?');
  }

  get available() { return true; }

  /** Replace the whole index from the current record set (boot / resync). */
  backfill(records) {
    try {
      this.db.exec('DELETE FROM m');
      for (const r of records) this.upsert(r);
    } catch (e) { this.logger.warn?.(`[dsh-evolve] fts backfill failed: ${e?.message ?? e}`); }
  }

  /** Insert-or-replace one record's tokens. */
  upsert(record) {
    if (!record?.id) return;
    try {
      this._delete.run(record.id);
      this._insert.run(record.id, encodeText(record.content ?? ''));
    } catch (e) { this.logger.warn?.(`[dsh-evolve] fts upsert failed: ${e?.message ?? e}`); }
  }

  /** Drop one record from the index. */
  remove(id) {
    if (!id) return;
    try { this._delete.run(id); } catch { /* best-effort */ }
  }

  /**
   * BM25-ranked record ids for a query, best first. Returns [] on empty query,
   * no matches, or any error (caller fuses with bigram list either way).
   */
  search(query, limit = 20) {
    const match = encodeQuery(query);
    if (match === '') return [];
    try {
      const rows = this.db
        .prepare('SELECT rid FROM m WHERE m MATCH ? ORDER BY bm25(m) LIMIT ?')
        .all(match, Math.max(1, limit));
      return rows.map((r) => r.rid);
    } catch (e) {
      this.logger.warn?.(`[dsh-evolve] fts search failed: ${e?.message ?? e}`);
      return [];
    }
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

/**
 * Create an FTS index, or a NullFts if node:sqlite/FTS5 is unavailable or the
 * feature is disabled. Async because node:sqlite is imported dynamically so a
 * missing built-in can never throw at module-load and brick plugin boot.
 */
export async function createFtsIndex(logger, enabled = true) {
  if (enabled === false) return new NullFts();
  try {
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    // rid = record id (unindexed payload); toks = our encoded token stream.
    db.exec("CREATE VIRTUAL TABLE m USING fts5(rid UNINDEXED, toks, tokenize='unicode61')");
    logger?.info?.('[dsh-evolve] FTS5 index ready (bigram-token + BM25, RRF-fused)');
    return new FtsIndex(db, logger);
  } catch (e) {
    logger?.warn?.(`[dsh-evolve] FTS5 unavailable, bigram-only recall: ${e?.message ?? e}`);
    return new NullFts();
  }
}

// Exposed for unit tests.
export const _internals = { encodeToken, encodeText, encodeQuery };
