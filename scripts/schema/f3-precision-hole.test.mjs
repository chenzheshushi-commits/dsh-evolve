/**
 * F3: the R1 precision red-line passes for the wrong reason, and the hole it hides
 * cannot be closed by moving the threshold.
 *
 * smoke.mjs asserts `scoreRecord(pref,'编程语言') === 0` and it is green -- but only
 * because that fixture's content happens not to contain 「语言」. Phrase the same
 * preference the ordinary way and the red-line breaks while every test in the suite
 * stays green.
 *
 * ── MEASUREMENT BASIS (v0.6.3 correction) ──────────────────────────────────────
 *
 * Earlier versions of this file, of lib/search.js's comment and of two release
 * notes quoted numbers like 1.411 / 1.469 / 3.070. Those are RETURN scores, i.e.
 * `base * importanceBoost * recencyBoost * accessBoost` (search.js:245). The
 * threshold comparison happens on `base` alone, BEFORE those multipliers
 * (search.js:236). The quoted numbers therefore never met any floor inside the
 * code, and comparing them to each other proved nothing about what the floor does.
 *
 * Everything below is measured as `base`, by forcing all three multipliers to 1:
 * importance 1, age 0 (now === updatedAt), accessCount 0. Do not mix bases.
 *
 *   true   要求用什么语言回复      -> 中文偏好(无「语言」)      base 0.8393  floor 0.60
 *   false1 编程语言               -> 中文偏好(含「语言」)      base 0.8065  floor 0.80
 *   false2 这个技能的处理流程是怎样的 -> LM-79 报告(共享「处理流程」) base 1.7541  floor 0.60
 *
 * ── WHY A FLOOR CANNOT FIX IT ─────────────────────────────────────────────────
 *
 * The previous claim -- "any floor that rejects 1.411 also kills the 1.469 recall"
 * -- was WRONG in both bases. false1 (0.8065) scores BELOW the true positive
 * (0.8393); that pair is separable, by a margin of 0.0328 in base terms, or 0.0065
 * above its own floor. A tighter floor really would reject it.
 *
 * false2 is the one that cannot be reached: base 1.7541 is more than DOUBLE the
 * true positive's 0.8393. No floor rejects false2 while keeping the true positive,
 * because the false positive scores higher. That, not the near-tie of false1, is
 * the proof that the fragment rule itself has to change.
 *
 * Root cause: a CJK run whose ONLY signal is a shared 2-gram still earns FRAGMENT
 * (+0.6, search.js:195) -- and for false2 two fragments hit (处理/理流/流程), so it
 * collects the full FULL_WORD cap without matching a single whole word. Fixing that
 * changes ranking for every query, so it needs baseline/retrieval-baseline.mjs
 * recall+MRR evidence and belongs in v0.7.0. Tracked as issue #2.
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

/** The hole itself. Flip to `test(...)` the moment the fragment rule is fixed. */
test.todo('F3: an unrelated query must not false-match a 中文偏好 phrased with 「语言」', async () => {
  const { scoreRecord } = await import('../../lib/search.js');
  const rec = baseRec('m3', PREF_WITH_LANG, ['语言', '中文']);
  for (const q of ['编程语言', '自然语言']) {
    assert.equal(scoreRecord(rec, q, { now: NOW }), 0, `${q} false-matches`);
  }
});

/**
 * NOT todo. This pins the hole's shape so a v0.7.0 fix cannot "pass" by moving the
 * threshold and quietly trading recall away.
 *
 * It asserts on `base` against the ACTUAL floor each query gets, because that is
 * the comparison the code performs. The previous version compared return scores in
 * a 0.5x-1.5x band and, being anchored on the separable pair, went red when someone
 * merely raised MATCH_BASE_MIN -- reporting "F3 is fixed" for a change that left
 * false2 recalled at full strength.
 */
test('F3 evidence: no floor can separate the unrelated record from a real hit', async () => {
  const { scoreRecord, matchBaseMin } = await import('../../lib/search.js');
  const base = (content, q, tags = []) => scoreRecord(baseRec('x', content, tags), q, { now: NOW });

  const TRUE_Q = '要求用什么语言回复';
  const FALSE2_Q = '这个技能的处理流程是怎样的';

  const truePositive = base(PREF_NO_LANG, TRUE_Q, ['语言', '中文']);
  const false2 = base(UNRELATED_REPORT, FALSE2_Q);

  // Report the unrelated record's fate FIRST. Raising the floor kills the true
  // positive, and a message about recall alone reads as "the fix hurt recall" while
  // saying nothing about whether the hole actually closed -- which is how a floor
  // change could be mistaken for progress. State both facts in one breath.
  if (truePositive === 0) {
    assert.fail('the real paraphrase hit is no longer recalled, and the unrelated record '
      + `${false2 > 0 ? `IS STILL RECALLED (base ${false2.toFixed(4)})` : 'is also rejected'}. `
      + (false2 > 0
        ? 'So this change did not close the hole -- it only moved the floor and traded '
          + 'recall away. Raising MATCH_BASE_MIN cannot work: see the header.'
        : 'Verify with baseline/retrieval-baseline.mjs that real recall survived on the '
          + 'true corpus before treating this as fixed.'));
  }

  // The load-bearing fact: the unrelated record OUTSCORES the real hit. While that
  // holds, no choice of floor can admit one and reject the other.
  assert.ok(false2 > truePositive,
    'F3 looks fixed: the unrelated record no longer outscores a real hit '
    + `(unrelated=${false2.toFixed(4)} real=${truePositive.toFixed(4)}). Verify with `
    + 'baseline/retrieval-baseline.mjs, then promote the test.todo above and delete '
    + 'this test.');

  // Stated the other way, for the reader: it is over its own floor by a wide margin,
  // so the floor is not what is letting it through.
  const floor = matchBaseMin(FALSE2_Q);
  assert.ok(false2 > floor * 2,
    `the unrelated record should clear its floor by a wide margin `
    + `(base=${false2.toFixed(4)} floor=${floor.toFixed(2)})`);
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
