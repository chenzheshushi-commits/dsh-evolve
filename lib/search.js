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
 * Base: substring = 3, tag = 1.5 (corroborated), query-word = 1.2 each (fragment 0.3), bigram
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
 * gate — this must not surface unrelated records. Floor never drops below 0.6 (the
 * `Math.max` lower bound below) so a lone single-char coincidence still can't pass.
 */
export function matchBaseMin(query) {
  const q = String(query);
  const cjkChars = (q.match(new RegExp(`[${CJK_CLASS}]`, 'g')) ?? []).length;
  const asciiWords = (q.match(/[a-z][a-z0-9_]{2,}/gi) ?? []).length;
  // Short query → strict 1.0 noise guard: a 1–2 char CN query or a single ASCII
  // word, where a lone single-char/bigram coincidence is the real false-positive
  // risk. (语言/超时/反代 all pass on their own strong signals well above 1.0.)
  if (cjkChars <= 2 && asciiWords <= 1) return MATCH_BASE_MIN;
  // Longer query → relax toward a 0.6 floor, so a paraphrase still recalls its
  // record. Relax 0.1 per CJK char beyond the 2nd (plus ASCII words).
  //
  // ⚠ CORRECTION (v0.6.2, re-derived in v0.6.3). This comment used to claim that
  // unrelated records "score exactly 0 — a wide safety gap" and that the 0.6 floor
  // "still rejects lone-fragment coincidence". BOTH ARE FALSE.
  //
  // The v0.6.2 correction then quoted the wrong quantity: 1.41 / 1.47 / 3.07 are
  // RETURN scores (base x importance x recency x access, :245), while the floor is
  // compared against `base` alone (:236). Numbers below are `base`, measured with
  // all three multipliers forced to 1:
  //
  // The hole those numbers described is CLOSED in v0.7.0 (issue #2). It was:
  //
  //   编程语言    vs 中文偏好 containing 「语言」        base 0.8065  (floor 0.80)
  //   这个技能的处理流程是怎样的 vs an unrelated report  base 1.7541  (floor 0.60)
  //   要求用什么语言回复 vs 中文偏好 (a REAL hit)         base 0.8393  (floor 0.60)
  //
  // FRAGMENT was 0.6 and this floor's lower bound is also 0.6, so ONE shared 2-gram
  // reached it unaided and any Jaccard credit carried it over. The floor could not fix
  // that: the unrelated report (1.7541) outscored the real hit (0.8393) by more than
  // 2x, so no threshold admitted one and rejected the other.
  //
  // Measured now, same basis (all three multipliers forced to 1):
  //
  //   编程语言    vs 中文偏好 containing 「语言」        base 0       rejected
  //   这个技能的处理流程是怎样的 vs an unrelated report  base 1.4541  BELOW the real hit
  //   要求用什么语言回复 vs 中文偏好 (a REAL hit)         base 2.0393  recalled
  //
  // Three changes, load-bearing together: tag credit matched per WORD instead of
  // `tag.includes(entireQuery)`, FRAGMENT halved to 0.3 so fragments must accumulate,
  // and tag credit requiring corroboration from another query word present in the
  // content. See scoreRecord below, scripts/schema/f3-precision-hole.test.mjs, and
  // baseline/retrieval-baseline.mjs (which now fails on drift rather than printing).
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
 * Words of a query, for comparing against a record's TAGS.
 *
 * Deliberately the same tokenization the content scorer uses below -- ASCII word runs,
 * whole CJK runs, and the 2-grams of a CJK run -- so "this word matched a tag" and
 * "this word appears in the content" cannot mean two different things. Two tokenizers
 * that disagree is how a tag could be credited for a word the content check would
 * never have found.
 *
 * Stopword-laden 2-grams are dropped for the reason the scorer drops them: 要求/什么
 * coincide with long unrelated records and carry no retrieval signal. They must not be
 * able to act as corroboration either.
 */
export function queryTokens(text) {
  const lower = String(text).toLowerCase();
  const out = new Set();
  for (const w of (lower.match(/[a-z][a-z0-9_]{2,}/g) ?? [])) out.add(w);
  for (const run of (lower.match(CJK_RUN_RE) ?? [])) {
    if (run.length === 1) { if (!STOPWORDS.has(run)) out.add(run); continue; }
    out.add(run);                                   // the whole run counts as a word
    for (let i = 0; i < run.length - 1; i += 1) {
      const bg = run.slice(i, i + 2);
      if (STOPWORDS.has(bg[0]) || STOPWORDS.has(bg[1])) continue;
      out.add(bg);
    }
  }
  return [...out];
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

  // Tag credit is per-WORD, and only with corroboration.
  //
  // The old test was `tag.includes(entireQuery)`, which asked whether the whole query
  // was a substring of one tag. Measured consequences on the 60-record store: the
  // record tagged ["语言","中文","回复风格"] scored ZERO for the query 「回复语言」,
  // because "回复语言" is not a substring of "语言" -- so the queries this tag existed
  // to serve were the ones it could not serve, and they had to survive on fragment
  // credit alone. That is why simply lowering FRAGMENT costs recall: it removes the
  // only thing holding up the genuine hits.
  //
  // Matching per word fixes recall and immediately opens a precision hole -- 「编程语言」
  // also contains the word 「语言」. Substring tests cannot separate the two, in either
  // direction, and neither can word-equality after 2-gram splitting, because the
  // 2-grams of 「编程语言」 literally contain 「语言」. All three were measured and
  // rejected.
  //
  // What does separate them is CORROBORATION: besides the word that matched the tag,
  // some other word of the query must actually appear in the record's content.
  //   「回复语言」 tag 语言 ✓, and 回复 appears in the content        -> credit
  //   「编程语言」 tag 语言 ✓, but neither 编程 nor 程语 appears      -> no credit
  const queryWords = queryTokens(q);
  const tagWords = new Set();
  for (const tag of record.tags) for (const t of queryTokens(tag)) tagWords.add(t);
  const tagHits = queryWords.filter((w) => tagWords.has(w));
  if (tagHits.length > 0) {
    // Corroboration: the query must ALSO connect to the record's content, through a
    // word other than the single tag word that matched. Three versions of this were
    // measured, and the first two were wrong in opposite directions:
    //
    //   - "any query word not present in any tag" rejected 「回复语言」 against tags
    //     ['语言','中文','回复风格']: 回复 IS in the content, but it also appears inside
    //     the tag 回复风格, so it was excluded and the query scored 0. That is the very
    //     query per-word tag matching exists to serve.
    //   - "any query word present in the content" let 「编程语言」 corroborate with 语言
    //     itself -- the tag hit -- leaving the hole open (measured 2.0065, not 0).
    //
    // What works: a word that is IN THE CONTENT and is not merely the tag word that
    // matched. 回复 is in the content, so 「回复语言」 is credited even though 回复 also
    // occurs in a tag; 「编程语言」 has only 语言 in the content, and that is the tag hit
    // itself, so it is not credited.
    // Corroboration asks whether the query touches the CONTENT at all, beyond the one
    // tag word that let it in.
    //
    // Measured on the real record (content 「用户偏好：使用中文回复，技术术语可保留英文…」,
    // tags ['语言','中文','回复风格']):
    //
    //   「回复语言」          query words 回复语言/回复/复语/语言   in content: [回复]
    //   「要求用什么语言回复」  query words …/求用/语言/言回/回复     in content: [回复]
    //   「编程语言」          query words 编程语言/编程/程语/语言   in content: []
    //
    // So the separating fact is simply whether ANY query word occurs in the content:
    // the two genuine queries reach 回复, the adversarial one reaches nothing. Earlier
    // versions required that word to be something other than a tag hit, which is
    // unsatisfiable here -- 回复 is both the content word and a tag word (via 回复风格),
    // so both real queries scored 0. The tag-only case is handled by the fact that a
    // record whose tag matches but whose content shares nothing has an empty list.
    // The corroborating word must not be the tag hit itself, but "is it a tag word"
    // is the wrong exclusion (回复 is both). The right one is per-hit: for each tag word
    // that matched, is there some OTHER query word in the content?
    //
    // Measured, all four cases that matter (tags shown, content words = query words
    // actually present in the content):
    //
    //   回复语言       tags [语言,中文,回复风格]  tagHits [回复,语言]  content [回复]
    //                  -> for hit 语言, 回复 is another content word        ✓ credit
    //   要求用什么语言回复 same record             tagHits [语言,回复]  content [回复]
    //                  -> for hit 语言, 回复 is another content word        ✓ credit
    //   编程语言       same record                tagHits [语言]       content []
    //                  -> nothing in the content at all                    ✗ reject
    //   编程语言       content 「…回复语言必须是中文」, tags [语言,中文]
    //                  tagHits [语言]  content [语言]
    //                  -> the only content word IS the tag hit             ✗ reject
    //
    // The last row is why the comparison is per-hit (`w !== hit`) rather than "is w a
    // tag word": 回复 is both a content word and a tag word, so excluding tag words
    // rejects the two genuine queries (measured: they scored 0).
    const corroborated = tagHits.some((hit) => queryWords
      .some((w) => w !== hit && contentLower.includes(w)));
    // A query that is ONLY the tag (「语言」 on its own) has nothing left to corroborate
    // with, so it keeps its credit rather than being silently unsearchable.
    // 「语言」 on its own: every word matched the tag, so there is nothing left that
    // could corroborate. Keeping credit here is what makes a tag searchable by name.
    const queryIsJustTheTag = queryWords.every((w) => tagHits.includes(w));
    if (corroborated || queryIsJustTheTag) base += 1.5;
  }

  // Query-word signal. R1 (v0.5.0) fix: the old `/[\u4e00-\u9fff]{2,}/` was GREEDY —
  // it swallowed an entire Chinese query run into ONE "word", so any multi-word CN
  // query (回复语言, 反向代理超时) produced a single token that content.includes()
  // almost never matched → the 1.2/word signal was dead on all long CN queries
  // (score cliff: 语言=2.47 vs 回复语言=0). Now: ASCII words score full; for each CN
  // run, a FULL-run substring hit scores full (+1.2), else fall back to 2-gram
  // fragments at a DOWN-WEIGHTED +0.6 so a full-word match still ranks above a
  // fragment coincidence. v0.7.0: FRAGMENT is 0.3, so one lone 2-gram no longer
  // reaches the floor by itself -- 「编程语言」 against a 中文偏好 record now scores 0
  // rather than clearing it on a single shared word.
  //
  // Two guards learned from the R4 baseline (评审 B6 精度红线):
  //   (a) SKIP fragments that contain a stopword char (要/求/什/么/…): a chatty query
  //       like 要求用什么语言回复 otherwise sprays 要求/什么/… fragments that coincide
  //       with long unrelated records and pile up above the real hit.
  //   (b) CAP total fragment credit per run at FULL_WORD, so fragment accumulation
  //       can never outscore a genuine full-word match (keeps precision).
  // FRAGMENT was 0.6, which is exactly matchBaseMin's lower bound -- so ONE shared
  // 2-gram reached the floor by itself and any Jaccard credit at all carried it over.
  // That is the mechanism behind issue #2: 「编程语言」 recalling a note about replying
  // in Chinese. Halved to 0.3 so fragments must accumulate, which is only affordable
  // because per-word tag credit above restores the recall fragments used to carry.
  const FULL_WORD = 1.2; const FRAGMENT = 0.3;
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
export function fuseRRF(bigramHits, ftsIds, recordsById, limit, query, scoreOptions = {}) {
  // `query` is required: without it the score check below cannot run, and a fusion
  // that silently skips it is exactly the fail-open behaviour this change removes.
  if (typeof query !== 'string' || query === '') {
    throw new TypeError('fuseRRF needs the query so an FTS hit can be re-checked against '
      + 'the scorer; a fusion that cannot check is how a zero-scoring record gets recalled');
  }
  const contrib = new Map(); // id -> { rrf, record, bigramScore }
  const add = (id, rank, record, bigramScore) => {
    if (!record) return;
    const cur = contrib.get(id) ?? { rrf: 0, record, bigramScore: bigramScore ?? 0 };
    cur.rrf += 1 / (RRF_K + rank);
    if (bigramScore !== undefined) cur.bigramScore = bigramScore;
    contrib.set(id, cur);
  };
  bigramHits.forEach((h, i) => add(h.record.id, i + 1, h.record, h.score));
  // An FTS id only joins the fusion if the SCORER would also have kept the record.
  //
  // Without this check, BM25 rank alone was enough to be recalled: FTS matches its
  // tokens with OR semantics, so a query sharing one 2-gram with a record's tag
  // brought that record back even when scoreRecord() rated it exactly 0. Measured for
  // 「编程语言」 on the 60-record store: five records returned, every one of them
  // scoring 0.000. That is the other half of the recall defect -- fixing the score
  // alone changed nothing, because nothing consulted the score on this path.
  //
  // The scorer owns precision (floor, tag corroboration, fragment weighting); FTS
  // contributes RANKING over the records that pass it. Keeping them in that order is
  // what makes a scoring fix actually reach the results.
  ftsIds.forEach((id, i) => {
    const record = recordsById.get(id);
    if (!record) return;
    if (scoreRecord(record, query, scoreOptions) <= 0) return;
    add(id, i + 1, record);
  });

  const fused = [...contrib.values()];
  fused.sort((a, b) => (
    b.rrf - a.rrf
    || b.record.importance - a.record.importance
    || b.bigramScore - a.bigramScore
  ));
  return fused.slice(0, Math.max(0, limit)).map((c) => ({ record: c.record, score: c.rrf }));
}
