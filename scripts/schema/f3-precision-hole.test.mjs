/**
 * F3: the precision hole is CLOSED. This file is now the regression that keeps it shut.
 *
 * The hole: a query sharing one 2-gram with a record recalled it. 「编程语言」 returned a
 * note about replying in Chinese, and 「这个技能的处理流程是怎样的」 returned an LM-79 lamp
 * report. Tracked as issue #2.
 *
 * ── WHY A FLOOR COULD NOT FIX IT ───────────────────────────────────────────────
 *
 * FRAGMENT was 0.6 and matchBaseMin's lower bound is also 0.6, so ONE shared 2-gram
 * reached the floor unaided. Worse, the lamp report scored 1.7541 against the real
 * paraphrase hit's 0.8393 -- the false positive outscored the true one, so no choice
 * of floor could admit one and reject the other. Raising MATCH_BASE_MIN only traded
 * recall away, which is why this file used to carry an assertion whose job was to go
 * red if anyone mistook that trade for a fix.
 *
 * ── WHAT FIXED IT (v0.7.0, three changes that only work together) ──────────────
 *
 *   1. Tag credit is matched per WORD, not by `tag.includes(entireQuery)`. The old
 *      test scored 0 for 「回复语言」 against tags ['语言','中文','回复风格'], so the
 *      queries tags existed to serve were the ones they could not serve.
 *   2. FRAGMENT 0.6 -> 0.3, so fragments must accumulate instead of one reaching the
 *      floor alone. Affordable only because (1) restored the recall fragments carried.
 *   3. Tag credit requires CORROBORATION: some query word OTHER than the one that
 *      matched the tag must appear in the content. 「回复语言」 corroborates through 回复;
 *      「编程语言」 has nothing (编程 / 程语 are absent).
 *
 * Substring tests in either direction, and word-equality after 2-gram splitting, were
 * all measured and rejected -- the 2-grams of 「编程语言」 literally contain 「语言」.
 *
 * ── MEASUREMENT BASIS ─────────────────────────────────────────────────────────
 *
 * Numbers here are `base` values: scoreRecord compares base against the floor BEFORE
 * applying importance/recency/access (search.js). v0.6.1 and v0.6.2 quoted RETURN
 * scores (1.411 / 1.469 / 3.070) as though they were base, so those numbers never met
 * any floor in the code. All fixtures keep the three multipliers at 1: importance 1,
 * age 0 (now === updatedAt), accessCount 0. Do not mix bases.
 *
 * Measured after the fix:
 *
 *   要求用什么语言回复   -> 中文偏好(无「语言」)       base 2.0393   recalled ✓
 *   回复语言            -> 中文偏好                 base 2.0523   recalled ✓
 *   语言                -> 中文偏好                 base 1.5471   recalled ✓
 *   编程语言            -> 中文偏好(含「语言」)       base 0        rejected ✓
 *   自然语言            -> 中文偏好(含「语言」)       base 0        rejected ✓
 *   这个技能的处理流程是怎样的 -> LM-79 报告          base 1.4541   still recalled, but
 *                                                   now BELOW the true positive
 *
 * The lamp report is still returned for that query; what changed is that it no longer
 * outscores a real hit, so ranking puts genuine matches first. Full corpus evidence is
 * in baseline/retrieval-baseline.mjs, which now fails on drift rather than printing.
 */
import { test } from 'node:test';
import assert from 'node:assert';

/** importance 1 + age 0 + accessCount 0 => scoreRecord returns `base` unmultiplied. */
const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const baseRec = (id, content, tags = []) => ({
  id, content, tags, kind: 'note', scope: 'project', importance: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  accessCount: 0, observationCount: 1,
});

const PREF_NO_LANG = '用户偏好：使用中文回复，技术术语可保留英文';
const PREF_WITH_LANG = '用户偏好：回复语言必须是中文，不要用英文';
const UNRELATED_REPORT = '灯泡光电报告的处理流程走 LM-79 标准';

/**
 * The hole itself, promoted from test.todo in v0.7.0.
 *
 * This is the assertion issue #2 was filed for: a query that merely shares the word
 * 「语言」 with a record's tag must not recall it.
 */
test('F3: an unrelated query must not false-match a 中文偏好 phrased with 「语言」', async () => {
  const { scoreRecord } = await import('../../lib/search.js');
  const rec = baseRec('m3', PREF_WITH_LANG, ['语言', '中文']);
  for (const q of ['编程语言', '自然语言']) {
    assert.equal(scoreRecord(rec, q, { now: NOW }), 0, `${q} false-matches`);
  }
});

/**
 * The reverse of the assertion this file used to carry.
 *
 * The old version asserted that the unrelated record OUTSCORED a real hit, because
 * while that held, no floor could separate them -- it existed so that "I raised
 * MATCH_BASE_MIN" could not be reported as a fix. That fact is now false (1.4541
 * against 2.0393), so the assertion is inverted rather than deleted: if the ordering
 * flips back, the hole has reopened by the same mechanism.
 */
test('F3: an unrelated record must not outscore a real paraphrase hit', async () => {
  const { scoreRecord, matchBaseMin } = await import('../../lib/search.js');
  const base = (content, q, tags = []) => scoreRecord(baseRec('x', content, tags), q, { now: NOW });

  const TRUE_Q = '要求用什么语言回复';
  const FALSE2_Q = '这个技能的处理流程是怎样的';

  const truePositive = base(PREF_NO_LANG, TRUE_Q, ['语言', '中文']);
  const false2 = base(UNRELATED_REPORT, FALSE2_Q);

  assert.ok(truePositive > 0,
    'the real paraphrase hit must still be recalled; if this is 0 the precision work '
    + 'traded recall away, which is the failure mode this file was written to catch');
  assert.ok(false2 < truePositive,
    `the unrelated record outscores a real hit again (unrelated=${false2.toFixed(4)} `
    + `real=${truePositive.toFixed(4)}). While that holds no floor can separate them -- `
    + 'see the header for why raising MATCH_BASE_MIN is not the answer.');

  // Tag credit must not be reachable by the tag word alone: that is the exact hole.
  for (const q of ['编程语言', '自然语言']) {
    assert.equal(base(PREF_WITH_LANG, q, ['语言', '中文']), 0,
      `${q} shares only the tag word 语言 and must score 0; corroboration is missing`);
  }

  // And the floor is still not what is doing the work.
  const floor = matchBaseMin(FALSE2_Q);
  assert.ok(false2 > floor,
    `the unrelated record is still above its own floor (base=${false2.toFixed(4)} `
    + `floor=${floor.toFixed(2)}), so ranking rather than the floor is what separates it`);
});

/**
 * Guards the correction itself: the numbers in this file are `base` values, so the
 * fixture must keep all three multipliers at 1. If someone "tidies" importance back
 * to 2, every number here silently becomes a return score again and the reasoning
 * breaks in the same way it did in v0.6.1/v0.6.2.
 */
test('F3 fixtures measure base, not the multiplied return score', async () => {
  const { scoreRecord } = await import('../../lib/search.js');
  const rec = baseRec('m', PREF_NO_LANG, ['语言', '中文']);
  assert.equal(rec.importance, 1, 'importance must be 1 or importanceBoost != 1');
  assert.equal(rec.accessCount, 0, 'accessCount must be 0 or accessBoost != 1');
  assert.equal(Date.parse(rec.updatedAt), NOW, 'age must be 0 or recencyBoost != 1');

  // Prove the multipliers really are inert: importance 2 must change the score, so
  // the fixture above is demonstrably measuring something different from it.
  const multiplied = scoreRecord({ ...rec, importance: 2 }, '要求用什么语言回复', { now: NOW });
  const plain = scoreRecord(rec, '要求用什么语言回复', { now: NOW });
  assert.ok(multiplied > plain,
    'importance no longer multiplies the score; the base-vs-return distinction this '
    + 'file depends on may no longer exist -- re-derive the numbers in the header');
});
