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
  const lower = String(text).toLowerCase();
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
 * CJK character ranges for tokenization (R6, v0.5.0). Extends the old bare
 * `\u4e00-\u9fff` (BMP basic block only) to cover the common ideograph blocks that
 * real memory content can hit:
 *   \u3400-\u4dbf  CJK Extension A (rarer but real Hanzi)
 *   \u4e00-\u9fff  CJK Unified Ideographs (basic — the original range)
 *   \uf900-\ufaff  CJK Compatibility Ideographs
 * Deliberately NOT adding kana/hangul (different languages; would change bigram
 * semantics for non-Chinese text with no evidence they appear in this store).
 * ⚠️ Changing this shifts the bigram-Jaccard distribution that adjudicator.js
 * keys duplicateSimilarity(0.82)/conflictSimilarity(0.5) off — recalibration +
 * a "decisions don't flip on the real DB" regression are REQUIRED (评审 A2).
 * Extension B+ (\u20000+) is astral-plane (surrogate pairs) — left out to keep the
 * simple per-code-unit sliding window correct.
 */
const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]+`, 'g');

/**
 * Bigram tokenizer: ASCII word runs + CJK bigrams (sliding windows of two
 * consecutive CJK chars; a CJK run shorter than 2 chars contributes the single
 * char). Bigrams carry far more information than single chars, making Chinese
 * recall precise — "苹果" no longer partially matches "水果摊" via shared "果".
 */
export function tokenizeBigram(text) {
  const lower = String(text).toLowerCase();
  const tokens = [];
  const ascii = /[a-z0-9_]+/g;
  let match;
  while ((match = ascii.exec(lower)) !== null) tokens.push(match[0]);
  const cjkRuns = lower.match(CJK_RUN_RE) ?? [];
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
  const set = new Set();
  const runs = String(text).toLowerCase().match(CJK_RUN_RE) ?? [];
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
 * Base: substring = 3, tag = 1.5, query-word = 1.2 each (fragment 0.6), bigram
 * Jaccard ≤ 2, unigram Jaccard ≤ 0.8. Floor 1.0 keeps strong matches, drops pure
 * single-char coincidence (the "unrelated association" on short queries).
 */
export const MATCH_BASE_MIN = 1.0;

/**
 * R2 (v0.5.0): query-length-adaptive threshold.
 *
 * The fixed MATCH_BASE_MIN=1.0 is structurally lethal to paraphrased long queries
 * (cjk skill: Jaccard's denominator grows with query length → a transposed long
 * query vs a short record has intersection of 1–2, Jaccard≈0.03, ×2 can't clear
 * 1.0 even with R1's fragment credit). Fix: keep the strict floor for SHORT queries
 * (≤2 effective tokens — where single-char coincidence is the real risk), and RELAX
 * it as the query lengthens (more tokens = more independent evidence, a couple of
 * genuine fragment/bigram hits should pass).
 *
 * ⚠️ Precision/recall are in tension here (cjk skill): relaxing admits false
 * positives too. The R4 baseline's adversarial group (编程语言 vs 中文偏好) is the
 * gate — this must not surface unrelated records. Floor never drops below 0.5 so a
 * lone single-char coincidence still can't pass.
 */
export function matchBaseMin(query) {
  const q = String(query);
  const cjkChars = (q.match(new RegExp(`[${CJK_CLASS}]`, 'g')) ?? []).length;
  const asciiWords = (q.match(/[a-z][a-z0-9_]{2,}/gi) ?? []).length;
  // Short query → strict 1.0 noise guard: a 1–2 char CN query or a single ASCII
  // word, where a lone single-char/bigram coincidence is the real false-positive
  // risk. (语言/超时/反代 all pass on their own strong signals well above 1.0.)
  if (cjkChars <= 2 && asciiWords <= 1) return MATCH_BASE_MIN;
  // Longer query → relax toward a 0.6 floor. Empirically (R4 baseline on the real
  // DB) genuine paraphrase hits land at 0.66–0.74 while unrelated records (编程语言,
  // 自然语言 vs 中文偏好) score exactly 0 — a wide safety gap. 0.6 admits the real
  // hits and still rejects lone-fragment coincidence. Relax 0.1 per CJK char beyond
  // the 2nd (plus ASCII words), floored at 0.6 — never lower, to keep the gap.
  const over = Math.max(0, cjkChars - 2) + Math.max(0, asciiWords - 1);
  return Math.max(0.6, MATCH_BASE_MIN - 0.1 * over);
}

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
  const asciiWords = String(query).toLowerCase().match(/[a-z]{3,}/g);
  return meaningfulCjk >= 2 || (asciiWords !== null && asciiWords.length >= 1);
}

/**
 * Score one record against a query. 0 when the query is empty or too weak.
 * score = base * importanceBoost * recencyBoost * accessBoost.
 */
export function scoreRecord(record, query, options = {}) {
  const q = String(query).trim();
  if (q === '') return 0;

  const contentLower = record.content.toLowerCase();
  const queryLower = q.toLowerCase();

  let base = 0;
  if (contentLower.includes(queryLower)) base += 3;
  if (record.tags.some((tag) => tag.toLowerCase().includes(queryLower))) base += 1.5;

  // Query-word signal. R1 (v0.5.0) fix: the old `/[\u4e00-\u9fff]{2,}/` was GREEDY —
  // it swallowed an entire Chinese query run into ONE "word", so any multi-word CN
  // query (回复语言, 反向代理超时) produced a single token that content.includes()
  // almost never matched → the 1.2/word signal was dead on all long CN queries
  // (score cliff: 语言=2.47 vs 回复语言=0). Now: ASCII words score full; for each CN
  // run, a FULL-run substring hit scores full (+1.2), else fall back to 2-gram
  // fragments at a DOWN-WEIGHTED +0.6 so a full-word match still ranks above a
  // fragment coincidence (评审 A3/B6: 召回↑ 但防碎片假阳性, "语言"命中"编程语言"只拿0.6).
  //
  // Two guards learned from the R4 baseline (评审 B6 精度红线):
  //   (a) SKIP fragments that contain a stopword char (要/求/什/么/…): a chatty query
  //       like 要求用什么语言回复 otherwise sprays 要求/什么/… fragments that coincide
  //       with long unrelated records and pile up above the real hit.
  //   (b) CAP total fragment credit per run at FULL_WORD, so fragment accumulation
  //       can never outscore a genuine full-word match (keeps precision).
  const FULL_WORD = 1.2; const FRAGMENT = 0.6;
  for (const w of (q.match(/[a-z][a-z0-9_]{2,}/gi) ?? [])) {
    if (contentLower.includes(w.toLowerCase())) base += FULL_WORD;
  }
  for (const run of (q.match(new RegExp(`[${CJK_CLASS}]{2,}`, 'g')) ?? [])) {
    if (contentLower.includes(run)) {
      base += FULL_WORD;                         // full CN run present → full credit
    } else {
      const seen = new Set();                    // dedupe fragments within this run
      let fragCredit = 0;
      for (let i = 0; i < run.length - 1; i += 1) {
        const bg = run.slice(i, i + 2);
        if (seen.has(bg)) continue;
        seen.add(bg);
        // (a) skip stopword-laden fragments — no retrieval signal, only noise.
        if (STOPWORDS.has(bg[0]) || STOPWORDS.has(bg[1])) continue;
        if (contentLower.includes(bg)) fragCredit += FRAGMENT;
      }
      base += Math.min(fragCredit, FULL_WORD);   // (b) cap: fragments ≤ one full word
    }
  }

  const qBigrams = tokenSetBigram(q);
  const cBigrams = tokenSetBigram(record.content);
  base += jaccard(qBigrams, cBigrams) * 2;

  const qUnis = cjkUnigrams(q);
  const cUnis = cjkUnigrams(record.content);
  base += jaccard(qUnis, cUnis) * 0.8;

  if (base < matchBaseMin(q)) return 0;

  const importanceBoost = 1 + (record.importance - 1) * 0.75; // 1.0 / 1.75 / 2.5
  const halfLifeDays = options.recencyHalfLifeDays ?? 90;
  const now = options.now ?? Date.now();
  const ageMs = now - lastActive(record);
  const recencyBoost = Math.pow(0.5, ageMs / (halfLifeDays * 24 * 3600 * 1000));
  const accessBoost = Math.min(ACCESS_BOOST_CAP, 1 + Math.log(1 + record.accessCount) * 0.15);

  return base * importanceBoost * recencyBoost * accessBoost;
}

/** Retired records: expired by TTL. */
export function isExpired(record, now = Date.now()) {
  return record.expiresAt !== null && record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}

/**
 * Rank non-expired records against a query; return top `limit`.
 * Records scoring 0 are dropped; ties keep insertion order (stable).
 */
export function rankRecords(records, query, limit, options = {}) {
  const now = options.now ?? Date.now();
  const scored = [];
  for (const record of records) {
    if (isExpired(record, now)) continue;
    const score = scoreRecord(record, query, { ...options, now });
    if (score > 0) scored.push({ record, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit));
}

/** Reciprocal Rank Fusion constant (standard k=60; dampens top-rank dominance). */
export const RRF_K = 60;

/**
 * Fuse two ranked id lists (best-first) via Reciprocal Rank Fusion, then map
 * back to `{record, score}` hits. RRF is parameter-free and scale-free: it
 * needs only the ORDER each retriever produced, so BM25's negative log-scores
 * and bigram-Jaccard's 0..N scores combine without normalization headaches.
 *
 * fusedScore(d) = Σ_retriever 1 / (RRF_K + rank_retriever(d))
 *
 * A record present in both lists outranks one strong in a single retriever —
 * precisely the "lexical AND semantic-ish agree" boost we want. Records only
 * the lexical (FTS) retriever found are still surfaced (long/ASCII docs the
 * bigram threshold dropped), and vice-versa. Ties broken by importance then by
 * the bigram score (keeps deterministic, importance-aware ordering).
 *
 * @param bigramHits  [{record, score}] from rankRecords (already thresholded).
 * @param ftsIds      record ids from FtsIndex.search (best-first) — may be [].
 * @param recordsById Map<id, record> for resolving FTS-only ids.
 * @param limit       max fused hits to return.
 * @returns [{record, score}] where score is the RRF score (for transparency).
 */
export function fuseRRF(bigramHits, ftsIds, recordsById, limit) {
  const contrib = new Map(); // id -> { rrf, record, bigramScore }
  const add = (id, rank, record, bigramScore) => {
    if (!record) return;
    const cur = contrib.get(id) ?? { rrf: 0, record, bigramScore: bigramScore ?? 0 };
    cur.rrf += 1 / (RRF_K + rank);
    if (bigramScore !== undefined) cur.bigramScore = bigramScore;
    contrib.set(id, cur);
  };
  bigramHits.forEach((h, i) => add(h.record.id, i + 1, h.record, h.score));
  ftsIds.forEach((id, i) => add(id, i + 1, recordsById.get(id)));

  const fused = [...contrib.values()];
  fused.sort((a, b) => (
    b.rrf - a.rrf
    || b.record.importance - a.record.importance
    || b.bigramScore - a.bigramScore
  ));
  return fused.slice(0, Math.max(0, limit)).map((c) => ({ record: c.record, score: c.rrf }));
}
