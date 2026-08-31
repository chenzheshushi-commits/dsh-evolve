/**
 * R4 检索质量基线 (Phase 0, v0.5.0)。
 *
 * ⚠️ 口径 = top-K 命中集合 + MRR，NOT scoreRecord 原始分数（评审 B6：fuseRRF 只吃名次，
 * 融合后分数变化用户无感）。
 *
 * 复用生产 search.js 的 rankRecords/fuseRRF + fts.js 的 createFtsIndex，与运行态同一套逻辑，
 * 不手搓打分器。灌真实 evolve_memory.json（只读，不改库）。
 *
 * 用法: PATH=$HOME/.local/node22/bin:$PATH node baseline/retrieval-baseline.mjs
 *   可选环境: EVOLVE_DB=<path>（默认 ~/.dsh/storages/evolve_memory.json）
 *
 * 查询组三类（评审 B6 要求）：
 *   - 转述型（用户用自己的话，非记忆原词）
 *   - 对抗性假阳性（部分词误命中，如"回复语言" vs 含"编程语言"的噪音）
 *   - 既有正常查询（回归对照，改动后不能退化）
 *
 * 每条查询标注 expectIds（应召回的目标记录 id 前缀关键词，用 content 子串近似），
 * 脚本算：目标是否进 topK / 目标的 MRR / topK 命中列表。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { rankRecords, fuseRRF } from '../lib/search.js';
import { createFtsIndex } from '../lib/fts.js';

const DB = process.env.EVOLVE_DB || join(homedir(), '.dsh/storages/evolve_memory.json');
const TOPK = 5;

function loadRecords() {
  const raw = JSON.parse(readFileSync(DB, 'utf8'));
  const recs = raw?.tables?.records ?? raw?.records ?? {};
  const list = Array.isArray(recs) ? recs : Object.values(recs);
  // 只取 live（非 pending、非 forgotten）——与 recall 注入池一致
  return list.filter((r) => r && !r.forgottenAt && !(Array.isArray(r.tags) && r.tags.includes('pending')));
}

/**
 * 查询组。matcher: content 需包含的关键词（用于判定"哪条是正解"）。
 * 没有正解的（noise 探测）matcher=null，只看 topK 返回了什么。
 */
const QUERIES = [
  // —— 转述型（记忆里写的是别的词面）——
  { q: '要求用什么语言回复', matcher: ['中文', '语言'], type: '转述' },
  { q: '回复语言', matcher: ['中文', '语言'], type: '转述' },
  { q: '反向代理超时', matcher: ['反代', '超时', '504'], type: '转述' },
  // —— 对抗性假阳性（防 R1 子串降权引入噪音）——
  { q: '编程语言', matcher: null, type: '对抗', note: '库里应无"编程语言"，看是否误召回中文偏好' },
  // —— 既有正常查询（回归对照）——
  { q: '超时', matcher: ['超时', '504', '反代'], type: '对照' },
  { q: '反代', matcher: ['反代'], type: '对照' },
];

function recall(records, query, ftsIndex) {
  const want = TOPK;
  const bigramHits = rankRecords(records, query, want, { recencyHalfLifeDays: 90 });
  let hits = bigramHits;
  let path = 'bigram-only';
  if (ftsIndex?.available) {
    const allowed = new Set(records.map((r) => r.id));
    const byId = new Map(records.map((r) => [r.id, r]));
    const ftsIds = ftsIndex.search(query, Math.max(want * 4, 20)).filter((id) => allowed.has(id));
    if (ftsIds.length > 0) {
      hits = fuseRRF(bigramHits, ftsIds, byId, want);
      path = 'fused';
    }
  }
  return { hits, path };
}

function matches(rec, matcher) {
  if (!matcher) return false;
  const c = String(rec.content || '');
  return matcher.some((m) => c.includes(m));
}

async function main() {
  const records = loadRecords();
  const ftsIndex = await createFtsIndex({ warn() {}, info() {} }, true);
  if (ftsIndex.available) ftsIndex.backfill(records);

  console.log(`# R4 检索基线  (db=${DB})`);
  console.log(`# live 记录数 = ${records.length}  |  FTS = ${ftsIndex.available ? 'on' : 'OFF(bigram-only)'}  |  topK=${TOPK}`);
  console.log(`# 口径: top-K 命中 + MRR (NOT 原始分数)\n`);

  let hitCount = 0; let mrrSum = 0; let scored = 0;
  for (const { q, matcher, type, note } of QUERIES) {
    const { hits, path } = recall(records, q, ftsIndex);
    const topContents = hits.map((h) => String(h.record.content).replace(/\s+/g, ' ').slice(0, 34));
    let line = `[${type}] "${q}"  (${path})`;
    if (matcher) {
      scored += 1;
      const rank = hits.findIndex((h) => matches(h.record, matcher)) + 1; // 1-based, 0=miss
      const inTopK = rank > 0;
      if (inTopK) { hitCount += 1; mrrSum += 1 / rank; }
      line += `  -> 正解命中: ${inTopK ? `第${rank}名 (RR=${(1 / rank).toFixed(3)})` : 'MISS'}`;
    } else {
      line += `  -> 噪音探测${note ? ' ('+note+')' : ''}: 返回${hits.length}条`;
    }
    console.log(line);
    hits.forEach((h, i) => console.log(`    ${i + 1}. [${h.record.kind}/imp${h.record.importance}] ${topContents[i]}`));
    console.log('');
  }

  const recallRate = scored ? (hitCount / scored) : 0;
  const mrr = scored ? (mrrSum / scored) : 0;
  console.log(`## 汇总 (仅计有正解的 ${scored} 条查询)`);
  console.log(`   top-${TOPK} 召回率 = ${hitCount}/${scored} = ${(recallRate * 100).toFixed(1)}%`);
  console.log(`   MRR         = ${mrr.toFixed(4)}`);
  console.log(`\n# 基线锚点(改 R1/R2/R3/R6 后重跑对比，召回率与 MRR 不得下降；对抗查询不得召回中文偏好)`);
  ftsIndex.close?.();
}

main().catch((e) => { console.error('baseline failed:', e); process.exit(1); });
