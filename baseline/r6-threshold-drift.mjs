/**
 * R6 阈值漂移回归 (v0.5.0)。
 *
 * 背景：R6 扩展了 CJK 分词区间（search.js CJK_CLASS：基本汉字 + 扩展A + 兼容表意字）。
 * 分词一变，bigram-Jaccard 相似度分布会平移，可能跨越 adjudicator 用来决定
 * auto/pending 的两个阈值——duplicateSimilarity(0.82) / conflictSimilarity(0.5)——
 * 从而**悄悄改变自治档的自动通过率**（评审 A2 标记的最高危项）。
 *
 * 本脚本是那次校准的**可复现回归产物**（不再一次性验完即弃）：
 *   - 内联一份 R6 之前的旧区间 tokenizer（BASELINE，仅 \u4e00-\u9fff）；
 *   - 用当前生产 tokenizer（search.js，扩展区间）作对照；
 *   - 灌真实库所有记录对，算 sim delta，统计有多少对跨越 0.82 / 0.5。
 * 期望：0 跨越（真实库全为基本汉字区时 delta 恒 0，扩区间对现有数据零影响）。
 *
 * ⚠️ 将来任何人再动 CJK_CLASS / tokenizeBigram，**先跑这个**：
 *   PATH="$HOME/.local/node22/bin:$PATH" node baseline/r6-threshold-drift.mjs
 * 若报非 0 跨越 → 必须用真实库重新校准 duplicateSimilarity / conflictSimilarity，
 * 不能直接合分词改动（否则自治档自动率被静默改变）。
 *
 * 退出码：0 = 无漂移（安全）；1 = 有跨越（需重新校准）。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tokenSetBigram as prodTokenSetBigram } from '../lib/search.js';
import { ADJUDICATOR_DEFAULTS } from '../lib/adjudicator.js';

const DB = process.env.EVOLVE_DB || join(homedir(), '.dsh/storages/evolve_memory.json');
const DUP = ADJUDICATOR_DEFAULTS.duplicateSimilarity;   // 0.82 — near-dup → auto-confirm
const CONF = ADJUDICATOR_DEFAULTS.conflictSimilarity;   // 0.5  — conflict → force pending

/**
 * R6-PRE baseline tokenizer: the OLD CJK range (basic block only, \u4e00-\u9fff).
 * Frozen copy of tokenizeBigram before R6 extended the range — this is the
 * reference distribution we must not drift the adjudicator thresholds across.
 */
function baselineTokenSet(text) {
  const lower = String(text).toLowerCase();
  const tokens = [];
  const ascii = /[a-z0-9_]+/g;
  let m;
  while ((m = ascii.exec(lower)) !== null) tokens.push(m[0]);
  const runs = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return new Set(tokens);
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function loadRecords() {
  const raw = JSON.parse(readFileSync(DB, 'utf8'));
  const recs = raw?.tables?.records ?? raw?.records ?? {};
  const list = Array.isArray(recs) ? recs : Object.values(recs);
  return list.filter((r) => r && !r.forgottenAt);
}

function main() {
  const recs = loadRecords();
  let pairs = 0; let maxDelta = 0; let crossedDup = 0; let crossedConf = 0;
  const crossings = [];
  for (let i = 0; i < recs.length; i += 1) {
    for (let j = i + 1; j < recs.length; j += 1) {
      pairs += 1;
      const a = String(recs[i].content ?? '');
      const b = String(recs[j].content ?? '');
      const oldSim = jaccard(baselineTokenSet(a), baselineTokenSet(b));
      const newSim = jaccard(prodTokenSetBigram(a), prodTokenSetBigram(b));
      const d = Math.abs(oldSim - newSim);
      if (d > maxDelta) maxDelta = d;
      if ((oldSim >= DUP) !== (newSim >= DUP)) { crossedDup += 1; crossings.push({ pair: [i, j], type: 'dup', oldSim, newSim }); }
      if ((oldSim >= CONF) !== (newSim >= CONF)) { crossedConf += 1; crossings.push({ pair: [i, j], type: 'conflict', oldSim, newSim }); }
    }
  }

  console.log(`# R6 阈值漂移回归  (db=${DB})`);
  console.log(`# 记录数=${recs.length}  记录对=${pairs}`);
  console.log(`# 阈值: duplicateSimilarity=${DUP}  conflictSimilarity=${CONF}`);
  console.log(`最大 sim 变化 (旧区间→扩区间): ${maxDelta.toFixed(6)}`);
  console.log(`跨越 duplicateSimilarity(${DUP}) 的对数: ${crossedDup}`);
  console.log(`跨越 conflictSimilarity(${CONF}) 的对数: ${crossedConf}`);
  if (crossings.length > 0) {
    console.log('\n跨越明细:');
    for (const c of crossings) console.log(`  [${c.type}] pair ${c.pair}  ${c.oldSim.toFixed(3)} → ${c.newSim.toFixed(3)}`);
  }

  const total = crossedDup + crossedConf;
  if (total === 0) {
    console.log('\n✅ 无漂移：扩区间对现有库的相似度分布零影响，adjudicator 阈值无需重标定。');
    process.exit(0);
  }
  console.log(`\n❌ 检测到 ${total} 处阈值跨越 — 分词改动改变了自治档的自动通过率。`);
  console.log('   必须用真实库重新校准 duplicateSimilarity / conflictSimilarity 后再合分词改动。');
  process.exit(1);
}

main();
