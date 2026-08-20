/**
 * Zero-dependency, zero-LLM deterministic retrieval for memory records.
 *
 * Ported to plain ESM from Culeot/dsh-memory `src/search.ts` (MIT) and kept
 * behaviourally identical: exact substring + query-word + bigram Jaccard +
 * CJK-unigram fallback, weighted by importance, recency half-life and access
 * count. No vector DB, no embedding, no LLM call — recomputed per query, cheap
 * because the store is capped (see spec.js MEMORY_DEFAULTS.maxRecords).
 *
 * Source: https://github.com/Culeot/dsh-memory (MIT). Local port for
 * dsh-evolve; scoring constants unchanged.
 *
 * @module dsh-evolve/search
 */

/** Split text into lowercase tokens: ASCII word runs + individual CJK chars. */
export function tokenize(text) {
  const lower = String(text).toLowerCase;
  const tokens = [];
  const ascii = /[a-z0-9_]+/g;
  let match;
  while ((match = ascii.exec(lower)) !== null) tokens.push(match[0]);
  for (const ch of lower) {
    const code = ch.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) tokens.push(ch);
  }
  return tokens;
}

/**
 * Bigram tokenizer: ASCII word runs + CJK bigrams (sliding windows of two
 * consecutive CJK chars; a CJK run shorter than 2 chars contributes the single
 * char). Bigrams carry far more information than single chars, making Chinese
 * recall precise — "苹果" no longer partially matches "水果摊" via shared "果".
 */
export function tokenizeBigram(text) {
  const lower = String(text).toLowerCase;
  const tokens = [];
  const ascii = /[a-z0-9_]+/g;
  let match;
  while ((match = ascii.exec(lower)) !== null) tokens.push(match[0]);
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

export function tokenSetBigram(text) {
  return new Set(tokenizeBigram(text));
}

/** Loose matching signal: pure CJK unigrams (never used alone). */
export function cjkUnigrams(text) {
  const set = new Set;
  const runs = String(text).toLowerCase.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) for (const ch of run) set.add(ch);
  return set;
}

/** Jaccard similarity of two token sets, 0..1. */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

const ACCESS_BOOST_CAP = 1.5;

/** Most-recent activity time: updates and recall hits both refresh freshness. */
function lastActive(record) {
  const updated = Date.parse(record.updatedAt);
  if (record.accessedAt) {
    const accessed = Date.parse(record.accessedAt);
    return accessed > updated ? accessed : updated;
  }
  return updated;
}

/**
 * Minimum matching strength (base score) for a record to be a hit.
 * Base: substring = 3, tag = 1.5, query-word = 1.2 each, bigram Jaccard ≤ 2,
 * unigram Jaccard ≤ 0.8. Threshold 1.0 keeps strong matches, drops pure
 * single-char coincidence (the "unrelated association" on short queries).
 */
export const MATCH_BASE_MIN = 1.0;

/** Common filler words that carry no retrieval information. */
const STOPWORDS = new Set([
  '的', '了', '吗', '呢', '啊', '哦', '嗯', '哟', '吧', '呀', '哈', '嘿', '喂',
  '是', '在', '和', '与', '或', '及', '把', '被', '给', '向', '从', '到', '于', '对', '就', '都', '也', '还', '但', '而', '则', '且',
  '我', '你', '他', '她', '它', '咱', '您', '们',
  '这', '那', '哪', '什', '么', '怎', '为', '何', '啥',
  '可', '以', '能', '好', '不', '别', '请', '先', '再', '又', '很', '太', '真', '挺', '会', '想', '要', '帮', '看', '说', '做', '弄', '搞', '整',
  'ok', 'ok了', '好的', '嗯嗯', '哈哈', '谢谢', '感谢', '谢了', '可以了', '明白了', '懂了', '知道', '看看', '请问',
]);

/**
 * Whether a query carries enough retrieval information to bother searching.
 * Requires ≥2 meaningful CJK chars or ≥1 ASCII word of length ≥3.
 */
export function hasMeaningfulQuery(query) {
  let meaningfulCjk = 0;
  for (const ch of String(query)) {
    const code = ch.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff && !STOPWORDS.has(ch)) meaningfulCjk += 1;
  }
  const asciiWords = String(query).toLowerCase.match(/[a-z]{3,}/g);
  return meaningfulCjk >= 2 || (asciiWords !== null && asciiWords.length >= 1);
}

/**
 * Score one record against a query. 0 when the query is empty or too weak.
 * score = base * importanceBoost * recencyBoost * accessBoost.
 */
export function scoreRecord(record, query, options = {}) {
  const q = String(query).trim;
  if (q === '') return 0;

  const contentLower = record.content.toLowerCase;
  const queryLower = q.toLowerCase;

  let base = 0;
  if (contentLower.includes(queryLower)) base += 3;
  if (record.tags.some((tag) => tag.toLowerCase.includes(queryLower))) base += 1.5;

  const qWords = new Set(q.match(/[\u4e00-\u9fff]{2,}|[a-z][a-z0-9_]{2,}/gi) ?? []);
  for (const w of qWords) if (contentLower.includes(w.toLowerCase)) base += 1.2;

  const qBigrams = tokenSetBigram(q);
  const cBigrams = tokenSetBigram(record.content);
  base += jaccard(qBigrams, cBigrams) * 2;

  const qUnis = cjkUnigrams(q);
  const cUnis = cjkUnigrams(record.content);
  base += jaccard(qUnis, cUnis) * 0.8;

  if (base < MATCH_BASE_MIN) return 0;

  const importanceBoost = 1 + (record.importance - 1) * 0.75; // 1.0 / 1.75 / 2.5
  const halfLifeDays = options.recencyHalfLifeDays ?? 90;
  const now = options.now ?? Date.now;
  const ageMs = now - lastActive(record);
  const recencyBoost = Math.pow(0.5, ageMs / (halfLifeDays * 24 * 3600 * 1000));
  const accessBoost = Math.min(ACCESS_BOOST_CAP, 1 + Math.log(1 + record.accessCount) * 0.15);

  return base * importanceBoost * recencyBoost * accessBoost;
}

/** Retired records: expired by TTL. */
export function isExpired(record, now = Date.now) {
  return record.expiresAt !== null && record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}

/**
 * Rank non-expired records against a query; return top `limit`.
 * Records scoring 0 are dropped; ties keep insertion order (stable).
 */
export function rankRecords(records, query, limit, options = {}) {
  const now = options.now ?? Date.now;
  const scored = [];
  for (const record of records) {
    if (isExpired(record, now)) continue;
    const score = scoreRecord(record, query, {...options, now });
    if (score > 0) scored.push({ record, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit));
}
