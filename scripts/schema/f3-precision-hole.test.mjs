/**
 * F3: the R1 precision red-line passes for the wrong reason.
 *
 * smoke.mjs asserts `scoreRecord(pref,'编程语言') === 0`, and it is green -- but
 * only because that fixture's content happens not to contain 「语言」. Phrase the
 * same preference the ordinary way and the red-line breaks while every test in
 * the suite stays green:
 *
 *   '用户偏好：使用中文回复，技术术语可保留英文'   q=编程语言 -> 0.000  (asserted)
 *   '用户偏好：回复语言必须是中文，不要用英文'      q=编程语言 -> 0.982  (never asserted)
 *
 * The failing assertion is kept HERE as test.todo, deliberately, instead of in
 * smoke.mjs: a comment saying "known issue" cannot go red, and deleting the case
 * loses it. `node --test` reports todo separately from pass, so the suite stays
 * releasable while the hole stays visible.
 *
 * WHY NOT FIXED IN v0.6.1: the obvious fix (raise the long-query floor) does not
 * work -- measured on the real scorer, false positives and true positives OVERLAP:
 *
 *   true  q=要求用什么语言回复           1.469
 *   false q=编程语言                    1.411
 *   false q=这个技能的处理流程是怎样的      3.070   <- outscores the true positive
 *
 * Any floor that rejects 1.411 also kills the 1.469 recall. The real root cause is
 * that a CJK run whose ONLY signal is one 2-gram fragment still earns FRAGMENT
 * (+0.6) -- 编程/程语 both miss, 语言 alone carries it. Fixing that changes ranking
 * for every query, so it needs baseline/retrieval-baseline.mjs recall+MRR evidence
 * and belongs in v0.7.0, not in a platform-safety patch release.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const mkRec = (id, content, tags = [], importance = 2) => ({
  id, content, tags, kind: 'note', scope: 'project', importance,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  accessCount: 0, observationCount: 1,
});
const NOW = Date.parse('2026-08-01T00:00:00.000Z');

/** The hole itself. Flip to `test(...)` the moment the fragment rule is fixed. */
test.todo('F3/F2: an unrelated query must not false-match a 中文偏好 phrased with 「语言」', async () => {
  const { scoreRecord } = await import('../../lib/search.js');
  const prefLang = mkRec('m3', '用户偏好：回复语言必须是中文，不要用英文', ['语言', '中文']);
  for (const q of ['编程语言', '自然语言']) {
    assert.equal(scoreRecord(prefLang, q, { now: NOW }), 0, `${q} false-matches`);
  }
});

/**
 * This one is NOT todo: it pins the hole's exact shape so a v0.7.0 fix cannot
 * "pass" by shifting the threshold and silently trading the recall away. If the
 * overlap ever disappears this test fails and tells you to promote the todo.
 */
test('F3 evidence: floor tuning alone cannot close the hole (recall/precision overlap)', async () => {
  const { scoreRecord } = await import('../../lib/search.js');
  const s = (content, q) => scoreRecord(mkRec('x', content, ['语言', '中文']), q, { now: NOW });

  const truePositive = s('用户偏好：使用中文回复，技术术语可保留英文', '要求用什么语言回复');
  const falsePositive = s('用户偏好：回复语言必须是中文，不要用英文', '编程语言');

  assert.ok(truePositive > 0, 'the real paraphrase hit must still be recalled');
  assert.ok(falsePositive > 0,
    'F3 is fixed! The fragment rule now rejects a lone 2-gram -- promote the test.todo above and delete this test.');
  assert.ok(falsePositive < truePositive * 1.5 && falsePositive > truePositive * 0.5,
    `scores must stay in the same band to prove a floor cannot separate them `
    + `(true=${truePositive.toFixed(3)} false=${falsePositive.toFixed(3)})`);
});
