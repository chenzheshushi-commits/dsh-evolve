/**
 * Regression check for the measured numbers quoted in comments, README and tests.
 *
 * NOT a scanner, and deliberately not built like one. The three files next to it
 * (no-verdict-scan, window-scan, tautology-scan) enumerate a scope and diff findings
 * against a recorded list. This one has twelve hardcoded `check(label, actual, claim)`
 * calls, each of which imports the production scorer and reproduces one specific
 * number. There is no scope to enumerate, so it takes no `analyze(absPath)` entry
 * point and does not take part in the scanners' self-scan: "does a comment's number
 * match the code" is undefined for an arbitrary sample file. Its threshold is simply
 * "every check green".
 *
 * Why it exists: this project's comments argue for design decisions using measured
 * retrieval scores, and those scores depend on two things that are easy to conflate
 *   -- which quantity was measured (`base`, or the score after importance/recency/
 *      access multipliers), and
 *   -- what the baseline was (whether `now` was pinned).
 * Two releases quoted return scores as though they were base values, so the numbers
 * in the comments could never have met the floor they were being compared against.
 *
 * Checks, in order:
 *   - lib/search.js's three base values and each one's floor
 *   - the two margins claimed in f3-precision-hole.test.mjs's header
 *   - README's claim that 1.41 / 1.47 / 3.07 were RETURN scores, not base
 *   - that search.js's floor comment, its Math.max lower bound, and the measured
 *     lower bound are the same number (they were 0.5 against 0.6 once)
 *
 * Imports the real lib/search.js rather than reimplementing the scorer, because a
 * reimplementation would drift and then agree with itself.
 *
 * Usage: node scripts/schema/comment-claims.mjs [path to search.js]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Default to this repo's own search.js, resolved from here rather than from the
// caller's cwd: the probe's original default pointed at a scratch copy that does not
// exist in the repository, so running it with no argument failed on an import error
// that looked like a code fault.
const src = process.argv[2] ?? fileURLToPath(new URL('../../lib/search.js', import.meta.url));
const { scoreRecord, matchBaseMin, MATCH_BASE_MIN } = await import(pathToFileURL(src).href);

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
/** importance 1 + age 0 + accessCount 0 => scoreRecord 返回值 === base。 */
const baseRec = (id, content, tags = [], importance = 1) => ({
  id, content, tags, kind: 'note', scope: 'project', importance,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  accessCount: 0, observationCount: 1,
});

const PREF_NO_LANG = '用户偏好：使用中文回复，技术术语可保留英文';
const PREF_WITH_LANG = '用户偏好：回复语言必须是中文，不要用英文';
const UNRELATED_REPORT = '灯泡光电报告的处理流程走 LM-79 标准';
const TRUE_Q = '要求用什么语言回复';
const F1_Q = '编程语言';
const F2_Q = '这个技能的处理流程是怎样的';

const base = (content, q, tags = [], imp = 1) => scoreRecord(baseRec('x', content, tags, imp), q, { now: NOW });

let bad = 0;
function check(label, actual, claim, tol = 1e-4) {
  const ok = typeof claim === 'number' ? Math.abs(actual - claim) <= tol : actual === claim;
  if (!ok) bad += 1;
  const a = typeof actual === 'number' ? actual.toFixed(4) : String(actual);
  console.log(`  ${ok ? '✅' : '🔴'} ${label.padEnd(52)} 实测 ${String(a).padStart(8)}   声明 ${claim}`);
}

console.log(`\n════ src = ${src} ════\n`);
console.log(`MATCH_BASE_MIN = ${MATCH_BASE_MIN}`);
console.log('\n【1】lib/search.js 注释 + f3 测试头部 + README 的三组 base 值');
check('真阳性 base  (要求用什么语言回复 / PREF_NO_LANG)', base(PREF_NO_LANG, TRUE_Q, ['语言', '中文']), 0.8393);
check('false1   base  (编程语言 / PREF_WITH_LANG)', base(PREF_WITH_LANG, F1_Q, ['语言', '中文']), 0.8065);
check('false2   base  (处理流程 / 无关报告)', base(UNRELATED_REPORT, F2_Q), 1.7541);

console.log('\n【2】各自的 floor（阈值比较的对象）');
check('floor(编程语言)               注释写 0.80', matchBaseMin(F1_Q), 0.8);
check('floor(要求用什么语言回复)      注释写 0.60', matchBaseMin(TRUE_Q), 0.6);
check('floor(这个技能的处理流程是怎样的) 注释写 0.60', matchBaseMin(F2_Q), 0.6);

console.log('\n【3】f3 测试头部声称的两个余量');
const tp = base(PREF_NO_LANG, TRUE_Q, ['语言', '中文']);
const f1 = base(PREF_WITH_LANG, F1_Q, ['语言', '中文']);
check('"margin of 0.0328 in base terms"', tp - f1, 0.0328, 1e-4);
check('"0.0065 above its own floor"', f1 - matchBaseMin(F1_Q), 0.0065, 1e-4);

console.log('\n【4】README 声称旧的 1.41 / 1.47 / 3.07 是"返回分"（importance=2 基准）');
check('PREF_WITH_LANG + 编程语言 (imp 2)', base(PREF_WITH_LANG, F1_Q, ['语言', '中文'], 2), 1.411, 5e-3);
check('PREF_NO_LANG   + 要求用什么语言回复 (imp 2)', base(PREF_NO_LANG, TRUE_Q, ['语言', '中文'], 2), 1.469, 5e-3);
check('UNRELATED_REPORT + 处理流程 (imp 2)', base(UNRELATED_REPORT, F2_Q, [], 2), 3.070, 5e-3);

console.log('\n【5】search.js 的 floor 注释与实现是否同一个数');
let minFloor = Infinity;
let minQ = '';
for (const n of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30]) {
  const q = '字'.repeat(n);
  const f = matchBaseMin(q);
  if (f < minFloor) { minFloor = f; minQ = `${n} 字 CJK`; }
}
const searchSrc = readFileSync(src, 'utf8');
const inComment = /Floor never drops below ([\d.]+)/i.exec(searchSrc);
const inImpl = /Math\.max\(([\d.]+),\s*MATCH_BASE_MIN/.exec(searchSrc);
console.log(`  实测地板下界      = ${minFloor.toFixed(2)}（${minQ}）`);
console.log(`  注释声明的下界    = ${inComment ? inComment[1] : '(注释里找不到该句)'}`);
console.log(`  实现 Math.max 下界 = ${inImpl ? inImpl[1] : '(实现里找不到 Math.max 下界)'}`);
if (inComment && inImpl && Number(inComment[1]) === Number(inImpl[1]) && Number(inImpl[1]) === minFloor) {
  console.log('  ✅ 三处一致：注释 = 实现 = 实测下界');
} else {
  console.log('  🟡 注释、实现、实测下界三者不一致');
  bad += 1;
}

console.log('\n【6】search.js:236 的判据是 base 还是返回分（决定上面所有数字是否可比）');
const multRec = { ...baseRec('x', PREF_NO_LANG, ['语言', '中文'], 2), accessCount: 3 };
const asBase = scoreRecord(baseRec('x', PREF_NO_LANG, ['语言', '中文']), TRUE_Q, { now: NOW });
const asReturn = scoreRecord(multRec, TRUE_Q, { now: NOW });
console.log(`  同一个查询：base 口径 ${asBase.toFixed(4)}  返回分口径 ${asReturn.toFixed(4)}`);
console.log(asReturn > asBase ? '  ✅ 两者确实不同 —— 引用时必须声明口径' : '  ⚠️ 两者相同，检查 fixture');

console.log(`\n──── ${bad === 0 ? '全部声明与实测一致' : `${bad} 条声明与实测不符`} ────\n`);
process.exit(bad === 0 ? 0 : 1);
