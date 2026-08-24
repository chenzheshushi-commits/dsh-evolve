// Smoke test for dsh-evolve v0.3.0. Run with node22 from the package dir
// so bare @deepseek-ai/* imports resolve via its deps:
//   ~/.local/node22/bin/node smoke.mjs
// Exercises pure logic + filesystem lifecycle (no live ctx needed). Assertions
// verify CONTRACTS (grammar/shape/monotonicity), not hardcoded outputs, so they
// survive tuning. Must print "ALL SMOKE TESTS PASSED".
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const mkRec = (o) => ({
  id: o.id, content: o.content, kind: o.kind ?? 'lesson',
  tags: o.tags ?? [], scope: o.scope ?? 'user', project: '',
  importance: o.importance ?? 2,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  accessedAt: '', accessCount: 0, injectionCount: 0, expiresAt: '', crystallizedAt: '',
});

// ── index exports ────────────────────────────────────────────────────────────
const mod = await import('./lib/index.js');
assert.equal(mod.name, 'dsh-evolve', 'name export');
assert.ok(typeof mod.apply === 'function', 'apply export');
assert.ok(Array.isArray(mod.inject) && mod.inject.includes('storageDomain'), 'inject export');
console.log('OK index exports:', mod.name, JSON.stringify(mod.inject));

// ── search: CJK recall + filler filter + RRF fusion ──────────────────────────
const search = await import('./lib/search.js');
const rec = mkRec({ id: 'mem_1', content: '写操作测试绝不使用真实生产记录作为样本', tags: ['warehouse', 'safety'], importance: 3 });
const hits = search.rankRecords([rec], '生产库 测写 样本', 5, {});
assert.ok(hits.length === 1 && hits[0].score > 0, 'CJK recall hits');
assert.equal(search.rankRecords([rec], 'ok了吗', 5, {}).length, 0, 'filler query no hit');

// fuseRRF: a doc found by BOTH retrievers must outrank docs found by only one.
const rA = mkRec({ id: 'A', content: '反代 504 超时', importance: 2 });
const rB = mkRec({ id: 'B', content: '客户投诉处理流程', importance: 2 });
const rC = mkRec({ id: 'C', content: '无关记录', importance: 2 });
const byId = new Map([[rA.id, rA], [rB.id, rB], [rC.id, rC]]);
const bigram = [{ record: rA, score: 5 }, { record: rB, score: 3 }]; // A,B
const ftsIds = ['A', 'C']; // A (both), C (fts-only)
const fused = search.fuseRRF(bigram, ftsIds, byId, 5);
assert.equal(fused[0].record.id, 'A', 'RRF: doc present in BOTH retrievers wins over single-list docs');
assert.ok(fused.some((h) => h.record.id === 'C'), 'RRF: FTS-only doc still surfaced');
assert.ok(fused.some((h) => h.record.id === 'B'), 'RRF: bigram-only doc still surfaced');
assert.equal(search.fuseRRF([], [], byId, 5).length, 0, 'RRF: empty in -> empty out');
console.log('OK search: CJK hit score=', hits[0].score.toFixed(3), '| filler filtered | RRF both>single + surfaces single-list');

// ── adjudicator: tiered auto-confirm (v0.4.0 direction 1) ────────────────────
// Contract assertions (not hardcoded outputs): verify the DECISION LOGIC, esp.
// the ironclad rule that kind NEVER drives auto-confirm.
const adj = await import('./lib/adjudicator.js');
const conf = []; // empty confirmed set for the basic cases
// 1. reversible (imp<3) + anchored to a user utterance → auto.
assert.equal(
  adj.adjudicate({ content: '用户偏好简洁回复', kind: 'preference', scope: 'user', importance: 2, anchoredToUser: true }, conf).decision,
  adj.DECISION_AUTO, 'adj: reversible + user-anchored → auto');
// 2. same content but NOT anchored and not known → pending (conservative default).
assert.equal(
  adj.adjudicate({ content: '用户偏好简洁回复', kind: 'preference', scope: 'user', importance: 2 }, conf).decision,
  adj.DECISION_PENDING, 'adj: reversible but unanchored/unknown → pending');
// 3. high importance (imp>=3, less reversible) → pending EVEN IF anchored.
assert.equal(
  adj.adjudicate({ content: '删库前必须全量备份', kind: 'lesson', scope: 'project', importance: 3, anchoredToUser: true }, conf).decision,
  adj.DECISION_PENDING, 'adj: high-importance → pending even when anchored');
// 4. ⭐ kind must NOT drive the decision: two records identical except kind must
//    get the SAME decision (proves kind isn't a shortcut to auto-confirm).
const asPref = adj.adjudicate({ content: 'x同样的内容y', kind: 'preference', scope: 'user', importance: 2 }, conf).decision;
const asFact = adj.adjudicate({ content: 'x同样的内容y', kind: 'fact', scope: 'user', importance: 2 }, conf).decision;
assert.equal(asPref, asFact, 'adj: IRONCLAD — kind field does not change the decision');
// 5. conflict with a confirmed record (topically similar + sentiment reversed) → pending.
const confirmedSet = [mkRec({ id: 'c1', content: '以后都用中文回复', kind: 'preference', scope: 'user', importance: 2 })];
const conflict = adj.adjudicate({ content: '以后不要用中文回复', kind: 'preference', scope: 'user', importance: 2, anchoredToUser: true }, confirmedSet);
assert.equal(conflict.decision, adj.DECISION_PENDING, 'adj: conflict with confirmed → pending (even anchored)');
assert.ok(conflict.signals.conflict === true, 'adj: conflict signal set');
// 6. master switch off → always pending (restores v0.3.x behavior).
assert.equal(
  adj.adjudicate({ content: '任何内容', kind: 'preference', scope: 'user', importance: 1, anchoredToUser: true }, conf, { autoConfirmEnabled: false }).decision,
  adj.DECISION_PENDING, 'adj: autoConfirmEnabled:false → always pending');
// 7. decision is always one of the two known outcomes (no undefined leak).
for (const d of [asPref, asFact, conflict.decision]) {
  assert.ok(d === adj.DECISION_AUTO || d === adj.DECISION_PENDING, 'adj: decision is auto|pending');
}
console.log('OK adjudicator: tiered auto-confirm — anchored→auto, high-imp/conflict/unknown→pending, kind-neutral, switch-off→pending');

// ── review: background-review parse + snapshot collector (v0.4.0 direction 3) ─
const review = await import('./lib/review.js');
// parseReviewOutput: well-formed MEM lines parse; NONE → empty; junk skipped.
const reviewParsed = review.parseReviewOutput([
  'MEM | preference | 2 | user | yes | 用户希望始终用中文回复',
  'MEM | fact | 1 | project | no | 项目用 pnpm 装依赖',
  'garbage line that is not a MEM',
  'MEM | boguskind | 2 | user | yes | should be dropped (bad kind)',
  'MEM | note | 9 | user | yes | should be dropped (bad importance)',
].join('\n'));
assert.equal(reviewParsed.length, 2, 'review: only 2 valid MEM lines survive (bad kind/importance dropped)');
assert.equal(reviewParsed[0].kind, 'preference', 'review: kind parsed');
assert.equal(reviewParsed[0].anchoredToUser, true, 'review: anchored=yes parsed');
assert.equal(reviewParsed[1].anchoredToUser, false, 'review: anchored=no parsed');
assert.equal(review.parseReviewOutput('NONE').length, 0, 'review: NONE → no suggestions');
assert.equal(review.parseReviewOutput('').length, 0, 'review: empty → no suggestions');
// think-block stripping: CoT must not leak into parsing.
const withThink = '<think>let me consider what to save...</think>\nMEM | lesson | 3 | project | yes | 删库前先备份';
const rvThink = review.parseReviewOutput(withThink);
assert.equal(rvThink.length, 1, 'review: parses MEM after stripping <think>');
assert.ok(!JSON.stringify(rvThink).includes('consider'), 'review: <think> content not leaked into suggestion');
// content may contain the pipe char — everything after the 5th | is content.
const rvPipes = review.parseReviewOutput('MEM | note | 1 | project | no | a|b|c pipes kept');
assert.equal(rvPipes[0].content, 'a|b|c pipes kept', 'review: content preserves internal pipes');
// TurnSnapshotCollector: accumulate + reset + bound.
const rvCol = new review.TurnSnapshotCollector({ maxChars: 1000 });
assert.equal(rvCol.hasContent, false, 'collector: empty initially');
rvCol.add('user', '帮我查一下库存');
rvCol.add('assistant', '好的，正在查询');
assert.ok(rvCol.hasContent, 'collector: has content after add');
assert.ok(rvCol.snapshot().includes('USER:') && rvCol.snapshot().includes('ASSISTANT:'), 'collector: labels roles');
rvCol.reset();
assert.equal(rvCol.hasContent, false, 'collector: empty after reset');
console.log('OK review: MEM parse (kind/importance/anchored/pipes), NONE/empty, <think> stripped, collector accumulate+reset');

// ── converge: near-dup merge detection + refinement-bloat + body split ───────
const converge = await import('./lib/converge.js');
const EVOLVE_MARK = 'dsh-evolve (crystallized)';
const cvDir = mkdtempSync(join(tmpdir(), 'evolve-converge-'));
const mkSkill = (nm, tag, body, refinements = 0) => {
  mkdirSync(join(cvDir, nm), { recursive: true });
  let md = `---\nname: ${nm}\ndescription: t\nauthor: ${EVOLVE_MARK}\nversion: 1.0.0\n---\n# ${nm}\n\n${body}\n`;
  for (let i = 1; i <= refinements; i += 1) md += `\n## Refinement v1.${i} (2026-01-0${i})\n\n- extra point ${i}\n`;
  md += `\n<!--dsh-evolve-state:${JSON.stringify({ tag, version: '1.0.0', sourceIds: [], refinements: [] })}-->\n`;
  writeFileSync(join(cvDir, nm, 'SKILL.md'), md);
};
// two near-identical skills (should be flagged to merge) + one unrelated.
mkSkill('reverse-proxy-timeout', 'rp1', '反代 504 超时 网关 超时 排查 nginx upstream 超时配置 proxy_read_timeout 调大');
mkSkill('gateway-504', 'gw1', '网关 504 超时 反代 超时 排查 nginx upstream proxy_read_timeout 超时配置 调大');
mkSkill('pixel-art-palette', 'px1', '像素画 调色板 NES Game Boy PICO-8 颜色 受限 复古');
// a human-authored (NON-evolve) skill must be IGNORED.
mkdirSync(join(cvDir, 'human-skill'), { recursive: true });
writeFileSync(join(cvDir, 'human-skill', 'SKILL.md'), '---\nname: human-skill\n---\n# human\n反代 504 超时 网关 超时 排查 nginx upstream proxy_read_timeout 超时配置 调大\n');
// a refinement-bloated skill.
mkSkill('bloated-skill', 'bl1', '主体正文', 5);

const cands = converge.findMergeCandidates(cvDir, { mergeSimilarity: 0.5 });
assert.ok(cands.length >= 1, 'converge: finds at least one merge candidate');
const top = cands[0];
const topPair = [top.a, top.b].sort().join(',');
assert.equal(topPair, 'gateway-504,reverse-proxy-timeout', 'converge: flags the two near-duplicate skills (not the unrelated one)');
assert.ok(!cands.some((c) => c.a === 'human-skill' || c.b === 'human-skill'), 'converge: NEVER flags a non-evolve (human) skill');
assert.ok(!cands.some((c) => c.a === 'pixel-art-palette' || c.b === 'pixel-art-palette'), 'converge: unrelated skill not flagged');
const bloat = converge.findRefinementBloat(cvDir, { maxRefinements: 4 });
assert.ok(bloat.some((b) => b.name === 'bloated-skill' && b.refinementCount === 5), 'converge: detects refinement-bloated skill (5 sections)');
// bodyBeforeRefinements splits at the first Refinement header.
const bloatedMd = readFileSync(join(cvDir, 'bloated-skill', 'SKILL.md'), 'utf8');
const preBody = converge.bodyBeforeRefinements(bloatedMd);
assert.ok(preBody && preBody.includes('主体正文') && !preBody.includes('Refinement'), 'converge: bodyBeforeRefinements keeps body, drops refinements');
assert.equal(converge.bodyBeforeRefinements('# no refinements here\n\njust body'), null, 'converge: null when no refinements');
// buildMergeInput labels each source skill.
const mi = converge.buildMergeInput([{ name: 'a', body: 'AAA' }, { name: 'b', body: 'BBB' }]);
assert.ok(mi.includes('From skill "a"') && mi.includes('From skill "b"') && mi.includes('AAA') && mi.includes('BBB'), 'converge: buildMergeInput labels + includes bodies');
// report shape.
const rep = converge.convergenceReport(cvDir, { mergeSimilarity: 0.5, maxRefinements: 4 });
assert.ok(rep.hasSuggestions && rep.topMerge && rep.bloated.length >= 1, 'converge: report surfaces topMerge + bloated');
rmSync(cvDir, { recursive: true, force: true });
console.log('OK converge: near-dup merge detection (evolve-only, human skills ignored), refinement-bloat, body split, merge-input labeling');

// ── style: per-skill user-style overlay (v0.4.0 direction 2B) ────────────────
const style = await import('./lib/style.js');
const styWs = mkdtempSync(join(tmpdir(), 'evolve-style-'));
try {
  // deriveStyleFromProfile: turns profile preferences into an instruction block.
  const derived = style.deriveStyleFromProfile({ byKind: { preference: [{ content: '始终用中文回复' }, { content: '少过渡词、直接给结论' }] } });
  assert.ok(derived.includes('始终用中文回复') && derived.includes('少过渡词'), 'style: derives overlay from profile preferences');
  assert.equal(style.deriveStyleFromProfile({ byKind: {} }), '', 'style: empty profile → empty overlay (skip attach)');
  // set / get / list / clear round-trip.
  assert.equal(style.getStyle(styWs, 'my-skill'), null, 'style: no overlay initially');
  const setRes = style.setStyle(styWs, 'my-skill', derived);
  assert.ok(setRes.set === true, 'style: setStyle attaches overlay');
  assert.ok(style.getStyle(styWs, 'my-skill')?.includes('中文'), 'style: getStyle reads overlay back');
  assert.deepEqual(style.listStyled(styWs), ['my-skill'], 'style: listStyled lists the styled skill');
  assert.equal(style.setStyle(styWs, 'my-skill', '').set, false, 'style: refuses to write an empty overlay');
  assert.ok(style.setStyle(styWs, '../evil', 'x').set === false, 'style: rejects unsafe skill names');
  const cleared = style.clearStyle(styWs, 'my-skill');
  assert.ok(cleared.cleared === true, 'style: clearStyle removes overlay');
  assert.equal(style.getStyle(styWs, 'my-skill'), null, 'style: overlay gone after clear (vanilla skill restored)');
  assert.deepEqual(style.listStyled(styWs), [], 'style: nothing styled after clear');
  console.log('OK style: overlay set/get/list/clear round-trip, derive-from-profile, empty+unsafe-name guards');
} finally { rmSync(styWs, { recursive: true, force: true }); }

// ── memory-convergence: budget + near-dup/thin gate + promotion (v0.4.1 dir4) ─
const mc = await import('./lib/memory-convergence.js');
const mkR = (o) => ({ id: o.id, content: o.content, kind: o.kind ?? 'fact', scope: o.scope ?? 'user', importance: o.importance ?? 2, observationCount: o.observationCount ?? 1, updatedAt: o.updatedAt ?? '2026-01-01', tags: o.tags ?? [] });
// g3 budget: under vs over, trim candidates prefer low-importance/low-obs.
const recs = [mkR({ id: 'a', content: 'x'.repeat(50), importance: 1, observationCount: 1 }), mkR({ id: 'b', content: 'y'.repeat(50), importance: 3, observationCount: 5 })];
const under = mc.budgetStatus(recs, 1000);
assert.ok(!under.overBudget && under.used === 100, 'mc budget: under budget');
const over = mc.budgetStatus(recs, 80);
assert.ok(over.overBudget && over.overBy === 20, 'mc budget: over budget reports overBy');
assert.equal(over.trimCandidates[0].id, 'a', 'mc budget: lowest-importance/obs is first trim candidate');
// g4 gate: thin, near-duplicate, ok.
assert.equal(mc.assessWriteQuality({ content: 'ab', kind: 'fact', scope: 'user' }, [], { minPromoteChars: 8 }).verdict, 'thin', 'mc gate: thin content flagged');
const existing = [mkR({ id: 'e', content: '用户希望回复始终使用中文并且尽量简洁', kind: 'preference', scope: 'user' })];
const dup = mc.assessWriteQuality({ content: '用户希望回复始终使用中文并且尽量简洁一点', kind: 'preference', scope: 'user' }, existing, { minPromoteChars: 5, maxContentOverlap: 0.5 });
assert.equal(dup.verdict, 'near-duplicate', 'mc gate: reworded near-dup flagged');
assert.equal(dup.similarTo, 'e', 'mc gate: points at the similar record');
assert.equal(mc.assessWriteQuality({ content: '一条全新的、与已有毫不相关的独立事实记录', kind: 'fact', scope: 'user' }, existing, { minPromoteChars: 5, maxContentOverlap: 0.5 }).verdict, 'ok', 'mc gate: novel content passes');
// g5 promotion: reinforced project-scope memory is a candidate; user-scope not.
const promo = mc.findPromotionCandidates([
  mkR({ id: 'p1', content: '项目里反复确认的做法', kind: 'lesson', scope: 'project', observationCount: 4 }),
  mkR({ id: 'p2', content: '只出现一次的项目事实', kind: 'fact', scope: 'project', observationCount: 1 }),
  mkR({ id: 'u1', content: '已经是全局的', kind: 'preference', scope: 'user', observationCount: 9 }),
], { promoteMinObservations: 3 });
assert.ok(promo.length === 1 && promo[0].id === 'p1', 'mc promotion: only reinforced project-scope memory is a candidate');
console.log('OK memory-convergence: char budget (trim candidates), thin/near-dup write gate, local→global promotion candidates');

// ── fts: encode is ASCII + query is safe OR of quoted terms ───────────────────
const fts = await import('./lib/fts.js');
const { encodeToken, encodeText, encodeQuery } = fts._internals;
assert.equal(encodeToken('abc'), 'abc', 'ascii token passthrough');
assert.ok(/^z[0-9a-f]+$/.test(encodeToken('测写')), 'CJK bigram -> zhex ascii token');
assert.ok(/^[\x00-\x7F]+$/.test(encodeText('测写操作 abc')), 'encoded text is pure ASCII');
const q = encodeQuery('测写 abc');
assert.ok(q.includes(' OR ') && q.includes('"'), 'query is quoted OR terms');
assert.equal(encodeQuery('  '), '', 'empty-ish query -> empty match');
// live FTS (skips gracefully if node:sqlite/FTS5 missing)
const idx = await fts.createFtsIndex({ warn() {}, info() {} }, true);
if (idx.available) {
  idx.backfill([
    mkRec({ id: 'd1', content: '去年处理 XX 客户投诉时我们先道歉再补发赠品' }),
    mkRec({ id: 'd2', content: '水果摊卖的苹果很新鲜' }),
    mkRec({ id: 'd3', content: '苹果公司发布新手机' }),
  ]);
  const ids = idx.search('客户投诉', 5);
  assert.ok(ids.includes('d1'), 'FTS: 2-char+ CJK query matches (trigram would miss)');
  const apple = idx.search('苹果', 5);
  assert.ok(apple.includes('d3') && apple.includes('d2'), 'FTS: 苹果 matches both 苹果 docs');
  assert.ok(!idx.search('苹果', 5).includes('d1'), 'FTS: 苹果 does NOT leak to unrelated doc');
  idx.close();
  console.log('OK fts: available; bigram-token BM25 CJK-correct (客户投诉 hit, 苹果 precise)');
} else {
  console.log('OK fts: node:sqlite/FTS5 unavailable -> NullFts fallback (recall stays bigram-only)');
}

// ── spec: schema defaults + new config knobs ──────────────────────────────────
const spec = await import('./lib/spec.js');
const parsed = spec.MemoryRecordSchema({ id: 'x', content: 'c', createdAt: 't', updatedAt: 't' });
assert.equal(parsed.kind, 'note', 'schema default kind');
assert.equal(parsed.scope, 'project', 'schema default scope');
assert.equal(parsed.importance, 2, 'schema default importance');
assert.ok(Array.isArray(parsed.tags), 'schema default tags array');
for (const k of ['refineMinNewEvidence', 'curatorStaleDays', 'curatorArchiveDays', 'ftsEnabled']) {
  assert.ok(k in spec.SKILL_DEFAULTS, `SKILL_DEFAULTS has ${k}`);
}
assert.ok(spec.SKILL_DEFAULTS.curatorArchiveDays >= spec.SKILL_DEFAULTS.curatorStaleDays, 'archiveDays >= staleDays');
console.log('OK spec: defaults + new curator/refine/fts knobs present');

// ── skills: naming contract (READABILITY FIRST; hash only as fallback) ────────
const skills = await import('./lib/skills.js');
// Readable ASCII tag -> verbatim, NO hash suffix (the whole point of this fix).
assert.equal(skills.skillNameFromTag('dsh'), 'dsh', 'readable ASCII tag -> verbatim (no hash)');
assert.equal(skills.skillNameFromTag('reverse-proxy'), 'reverse-proxy', 'multi-word ASCII tag -> kebab verbatim');
assert.equal(skills.skillNameFromTag('Warehouse 安全'), 'warehouse', 'mixed tag -> ASCII skeleton, no hash');
// Pure-CJK / empty skeleton -> skill-<hash>, never a bare "skill", deterministic + distinct.
const cjk1 = skills.skillNameFromTag('反代');
const cjk2 = skills.skillNameFromTag('网关超时');
assert.ok(NAME_RE.test(cjk1) && cjk1.startsWith('skill-') && cjk1 !== 'skill', `pure-CJK -> skill-<hash>: ${cjk1}`);
assert.notEqual(cjk1, cjk2, 'distinct CJK tags -> distinct hash names');
assert.equal(cjk1, skills.skillNameFromTag('反代'), 'CJK name deterministic');
// sanitizeSkillName: coerces an LLM-proposed name, or null when unusable.
assert.equal(skills.sanitizeSkillName('Reverse Proxy Timeout!'), 'reverse-proxy-timeout', 'sanitize LLM name -> kebab');
assert.equal(skills.sanitizeSkillName('   '), null, 'sanitize empty -> null');
assert.equal(skills.sanitizeSkillName('反代'), null, 'sanitize pure-CJK -> null (caller falls back)');

// parseRefineResponse: strips <think>, parses NAME/DESC/BODY, tolerant fallback.
const llmref = await import('./lib/llm-refine.js');
const p1 = llmref.parseRefineResponse('<think>reasoning noise here</think>\nNAME: reverse-proxy-timeout\nDESC: Use when a reverse proxy 504s.\nBODY:\n## Summary\nbody text');
assert.equal(p1.name, 'reverse-proxy-timeout', 'parse NAME');
assert.ok(p1.description.startsWith('Use when'), 'parse DESC');
assert.ok(p1.body.includes('## Summary') && !p1.body.includes('reasoning noise'), 'parse BODY strips think block');
const p2 = llmref.parseRefineResponse('just a plain body, no markers');
assert.ok(!p2.name && !p2.description && p2.body === 'just a plain body, no markers', 'no-marker -> body-only back-compat');
const p3 = llmref.parseRefineResponse('<think>unclosed think leaking everything');
assert.ok(!p3.body, 'unclosed think with no real content -> empty body (caller falls back)');
console.log('OK skills naming: readable-first (dsh->dsh), CJK->skill-<hash>, sanitize + parseRefineResponse(think-stripped)');

// SKILL.md render + state block round-trip (deterministic path, no llmDescription)
const seed = [
  mkRec({ id: 's1', content: '决策：统一走多平台接口', kind: 'decision', importance: 3 }),
  mkRec({ id: 's2', content: '教训：反代默认60s会504', kind: 'lesson', importance: 3 }),
];
const md = skills.renderSkillMd('warehouse-abc123', 'warehouse', seed);
assert.ok(md.startsWith('---\nname: warehouse-abc123'), 'SKILL.md frontmatter');
assert.ok(md.includes('description:') && md.includes('## Lessons') && md.includes('## Decisions'), 'SKILL.md sections');
assert.ok(NAME_RE.test(md.match(/name:\s*(\S+)/)[1]), 'frontmatter name grammar');
const st = skills.readState(md);
assert.ok(st && st.version === '1.0.0' && st.sourceIds.length === 2 && Array.isArray(st.refinements), 'state block parses (v1.0.0, sourceIds, refinements[])');
// LLM-supplied description overrides the tag-template; body distilled replaces sections.
const mdLlm = skills.renderSkillMd('dsh', 'dsh', seed, '## Summary\ndistilled body', 'Use when working with DSH plugins.');
assert.ok(mdLlm.includes('description: "Use when working with DSH plugins."'), 'llmDescription overrides tag-template');
assert.ok(mdLlm.includes('distilled body') && !mdLlm.includes('## Decisions'), 'distilledBody replaces deterministic sections');
assert.ok(!/relates to: dsh/.test(mdLlm.split('\n').find((l) => l.startsWith('description:'))), 'no tag-template when llmDescription given');

// ── skills lifecycle: crystallize -> refine -> archive -> restore -> states ───
const root = mkdtempSync(join(tmpdir(), 'evolve-smoke-'));
const skillsDir = join(root, 'skills');
const archiveDir = join(root, 'workspace', 'archived-skills');
mkdirSync(skillsDir, { recursive: true });
try {
  // crystallize
  const w = skills.writeCrystallizedSkill(skillsDir, 'reverse-proxy-xy', 'reverse-proxy', seed, { warn() {} });
  assert.ok(w && w.version === '1.0.0' && existsSync(w.path), 'crystallize writes v1.0.0 SKILL.md');

  // ⭐ CORE OF THIS FIX: locate BY TAG via the state block, NOT by recomputing a
  // name. The on-disk dir 'reverse-proxy-xy' is NOT what skillNameFromTag('reverse-proxy')
  // returns ('reverse-proxy'), yet findSkillByTag must still find it via state.tag.
  assert.equal(skills.findSkillByTag(skillsDir, 'reverse-proxy'), 'reverse-proxy-xy', 'findSkillByTag locates by state-block tag, not by recomputed name');
  assert.equal(skills.findSkillByTag(skillsDir, 'no-such-tag'), null, 'findSkillByTag returns null for unknown tag');
  // proposeSkillName: same tag re-propose reuses existing dir (idempotent, no dup);
  // a different tag that sanitizes to the SAME base gets a disambiguating hash.
  assert.equal(skills.proposeSkillName(skillsDir, 'reverse-proxy'), 'reverse-proxy-xy', 'proposeSkillName reuses existing dir for same tag (no split)');
  assert.equal(skills.proposeSkillName(skillsDir, 'brand-new-tag', 'brand-new-tag'), 'brand-new-tag', 'proposeSkillName takes free readable name as-is');

  // refine with NEW evidence -> version bumps, new section, sourceIds grow, human edits preserved
  const humanEdit = '\n<!-- HUMAN NOTE: keep this line -->\n';
  writeFileSync(w.path, readFileSync(w.path, 'utf8').replace('# reverse-proxy-xy', `# reverse-proxy-xy${humanEdit}`));
  const fresh = [mkRec({ id: 's3', content: '教训：外网504先分诊反代vs服务', kind: 'lesson', importance: 3 })];
  const r1 = skills.refineCrystallizedSkill(skillsDir, 'reverse-proxy-xy', 'reverse-proxy', [...seed, ...fresh], { warn() {} });
  assert.ok(r1 && r1.refined === true && r1.added === 1, 'refine folds in only NEW evidence (1)');
  const md2 = readFileSync(w.path, 'utf8');
  assert.ok(md2.includes('HUMAN NOTE: keep this line'), 'refine PRESERVES human edits');
  assert.ok(md2.includes('## Refinement v1.1.0'), 'refine appends versioned section');
  assert.match(md2, /^version:\s*1\.1\.0$/m, 'refine bumps frontmatter version');
  const st2 = skills.readState(md2);
  assert.ok(st2.version === '1.1.0' && st2.sourceIds.includes('s3') && st2.refinements.length === 1, 'state block updated (v1.1.0, +s3, 1 refinement)');

  // refine again with SAME evidence -> no-op (never double-counts)
  const r2 = skills.refineCrystallizedSkill(skillsDir, 'reverse-proxy-xy', 'reverse-proxy', [...seed, ...fresh], { warn() {} });
  assert.ok(r2 && r2.refined === false, 'refine is idempotent on already-folded evidence');

  // refuse to touch a non-evolve-owned skill
  const foreign = join(skillsDir, 'human-skill');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'SKILL.md'), '---\nname: human-skill\ndescription: "hand written"\n---\n# human\n');
  assert.ok(skills.archiveSkill(skillsDir, archiveDir, 'human-skill', { warn() {} }).archived === false, 'archive refuses non-evolve-owned');
  assert.ok(skills.writeCrystallizedSkill(skillsDir, 'human-skill', 't', seed, { warn() {} }) === null, 'crystallize refuses to clobber non-evolve skill');

  // states report: our skill is active, human-skill is NOT counted (not owned)
  const s0 = skills.listSkillStates(skillsDir, archiveDir, { staleDays: 30 });
  assert.equal(s0.counts.active, 1, 'exactly 1 evolve-owned active skill');
  assert.equal(s0.active[0].name, 'reverse-proxy-xy', 'active skill listed');
  assert.equal(s0.counts.archived, 0, 'nothing archived yet');

  // archive -> leaves active dir, lands in archive dir (reversible, not deleted)
  const a = skills.archiveSkill(skillsDir, archiveDir, 'reverse-proxy-xy', { warn() {} });
  assert.ok(a.archived === true, 'archive succeeds');
  assert.ok(!existsSync(join(skillsDir, 'reverse-proxy-xy', 'SKILL.md')), 'archived skill left active dir (catalog shrinks)');
  assert.ok(existsSync(join(archiveDir, 'reverse-proxy-xy', 'SKILL.md')), 'archived skill preserved in archive (not deleted)');
  const s1 = skills.listSkillStates(skillsDir, archiveDir, { staleDays: 30 });
  assert.equal(s1.counts.active, 0, 'no active after archive');
  assert.equal(s1.counts.archived, 1, 'one archived');

  // restore -> back to active
  const rr = skills.restoreSkill(skillsDir, archiveDir, 'reverse-proxy-xy', { warn() {} });
  assert.ok(rr.restored === true && existsSync(join(skillsDir, 'reverse-proxy-xy', 'SKILL.md')), 'restore returns skill to active dir');
  assert.equal(skills.countCrystallizedSkills(skillsDir), 1, 'countCrystallizedSkills counts restored skill');
  console.log('OK skills: crystallize->refine(preserve edits,+version,no-dup)->archive(reversible)->restore + ownership guards');
} finally {
  rmSync(root, { recursive: true, force: true });
}


// ── store: injectionCount is observability-only (must NOT affect ranking) ────
const { MemoryStore } = await import('./lib/store.js');
function makeStoreTable() {
  const m = new Map();
  return {
    put(k, v) { m.set(k, v); return true; }, get(k) { return m.get(k); },
    delete(k) { return m.delete(k); }, entries() { return [...m.entries()]; },
    get size() { return m.size; },
  };
}
{
  const ws = mkdtempSync(join(tmpdir(), 'evolve-store-'));
  try {
    const st = new MemoryStore(makeStoreTable(), { workspaceDir: ws, logger: { warn() {}, info() {} } });
    const a = await st.remember({ content: '反代 504 超时默认60秒会导致网关错误', kind: 'lesson', importance: 3, tags: ['t'], confirm: true });
    const b = await st.remember({ content: '客户投诉先道歉再补发赠品最后折扣码', kind: 'note', importance: 2, tags: ['t'], confirm: true });

    // Reinforcement (v0.4.1 direction-2 kernel): re-observing the SAME understanding
    // bumps observationCount and, past reinforceEvery, raises importance.
    const r1 = await st.remember({ content: '用户希望回复尽量简洁不要过渡词', kind: 'preference', importance: 1, scope: 'user', tags: ['style'], confirm: true });
    assert.equal(r1.observationCount, 1, 'reinforce: first observation count=1');
    // near-duplicate re-writes of the same preference reinforce the SAME record
    let last = r1;
    for (let i = 0; i < 3; i += 1) {
      last = await st.remember({ content: '用户希望回复尽量简洁不要过渡词啰嗦', kind: 'preference', importance: 1, scope: 'user', tags: ['style'], confirm: true });
    }
    assert.ok(last.id === r1.id, 'reinforce: re-observation folds into the SAME record (not a new row)');
    assert.ok(last.observationCount >= 4, `reinforce: observationCount accumulates across turns (got ${last.observationCount})`);
    assert.ok(last.importance > 1, `reinforce: repeated evidence raised importance (1 -> ${last.importance})`);
    assert.ok(last.reinforcedAt !== '', 'reinforce: reinforcedAt stamped');
    // problem-1 fix: a WORSE (shorter, same-importance) re-observation must NOT
    // overwrite the better existing phrasing — reinforcement keeps quality.
    // (Uses a phrasing near-dup enough to fold, but shorter = lower quality.)
    const goodPhrasing = last.content;
    const afterWorse = await st.remember({ content: '用户希望回复尽量简洁不要过渡', kind: 'preference', importance: 1, scope: 'user', tags: ['style'], confirm: true });
    assert.equal(afterWorse.id, last.id, 'reinforce: worse re-observation still folds into same record');
    assert.equal(afterWorse.content, goodPhrasing, 'reinforce: keeps the higher-quality phrasing (does NOT overwrite with a vaguer/shorter one)');
    assert.ok(afterWorse.observationCount > last.observationCount, 'reinforce: still counts the observation even when phrasing is kept');

    // baseline ranking for a query that matches BOTH
    const q = '反代 超时';
    const before = await st.recall(q, 5, { includePending: false });
    const beforeTop = before[0]?.record.id;
    const beforeScores = before.map((h) => `${h.record.id}:${h.score.toFixed(4)}`).join(',');

    // hammer injectionCount on record b MANY times
    for (let i = 0; i < 50; i += 1) st.noteInjection([b.id]);
    assert.equal(st.effectiveInjectionCount(b), 50, 'effectiveInjectionCount reflects in-memory delta');
    assert.equal(st.effectiveInjectionCount(a), 0, 'untouched record has 0 injectionCount');

    // ranking MUST be identical — injectionCount must not enter scoreRecord/recencyBoost
    const after = await st.recall(q, 5, { includePending: false });
    const afterScores = after.map((h) => `${h.record.id}:${h.score.toFixed(4)}`).join(',');
    assert.equal(afterScores, beforeScores, 'injectionCount does NOT change recall ranking/scores');
    assert.equal(after[0]?.record.id, beforeTop, 'injectionCount does NOT change top hit');

    // flush persists injectionCount but must NOT touch accessedAt/updatedAt (ranking fields)
    const bBeforeFlush = st.table.get(b.id);
    await st.flushInjections();
    const bAfter = st.table.get(b.id);
    assert.equal(bAfter.injectionCount, 50, 'flush persists injectionCount into the record');
    assert.equal(bAfter.accessedAt, bBeforeFlush.accessedAt, 'flush does NOT touch accessedAt');
    assert.equal(bAfter.updatedAt, bBeforeFlush.updatedAt, 'flush does NOT touch updatedAt');
    assert.equal(st.effectiveInjectionCount(st.table.get(b.id)), 50, 'after flush, a fresh record reads persisted injectionCount (delta drained to 0)');

    // stats: current snapshot, pending queue, top-by-injection
    await st.remember({ content: '一条待确认记忆', kind: 'note', importance: 1, tags: ['t'] }); // pending
    const stats = st.stats({ topN: 5 });
    assert.equal(stats.total, 4, 'stats total counts all records (a + b + reinforced r1 + pending)');
    assert.equal(stats.pending, 1, 'stats counts the pending record');
    assert.equal(stats.confirmed, 3, 'stats confirmed = total - pending');
    assert.equal(stats.pendingQueue.length, 1, 'pending queue lists the unconfirmed memory');
    assert.ok(stats.topByInjection[0]?.id === b.id && stats.topByInjection[0]?.injectionCount === 50, 'stats topByInjection surfaces the most-injected memory');
    console.log('OK store: injectionCount observability-only (ranking unchanged), lazy flush preserves accessedAt, stats snapshot + pending queue');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}


// ── v0.4.2: soft-delete / pinned / memory-black-hole guards ─────────────────
{
  const ws = mkdtempSync(join(tmpdir(), 'evolve-softdel-'));
  try {
    const st = new MemoryStore(makeStoreTable(), { workspaceDir: ws, logger: { warn() {}, info() {} } });
    // seed a confirmed record
    const x = await st.remember({ content: '部署前务必备份数据库到异地', kind: 'lesson', importance: 2, tags: ['ops'], confirm: true });

    // (1) softForget: record stays in all() but leaves confirmed/recall/tier1/evidence
    const sf = await st.softForget(x.id);
    assert.equal(sf.softDeleted, 1, 'softForget stamps tombstone');
    assert.ok(st.all().some((r) => r.id === x.id), 'soft-deleted record still physically present in all()');
    assert.ok(!st.confirmed().some((r) => r.id === x.id), 'soft-deleted excluded from confirmed()');
    const rec1 = await st.recall('备份 数据库', 5, { includePending: false });
    assert.ok(!rec1.some((h) => h.record.id === x.id), 'soft-deleted excluded from recall');
    const ev = st.crystallizationEvidence(['lesson', 'decision'], 1);
    assert.ok(!ev.some((g) => g.records.some((r) => r.id === x.id)), 'soft-deleted excluded from crystallization evidence');
    // (3) softForget does not change importance/observationCount (only tombstone)
    const raw = st.table.get(x.id);
    assert.equal(raw.importance, 2, 'softForget does not change importance');
    assert.ok(raw.forgottenAt !== '', 'softForget set forgottenAt');

    // (2) restore -> fully recallable again
    const rs = await st.restoreForgotten(x.id);
    assert.equal(rs.restored, 1, 'restoreForgotten clears tombstone');
    assert.ok(st.confirmed().some((r) => r.id === x.id), 'restored record back in confirmed()');

    // (9) memory-black-hole entry 1 (reinforcement loop): re-remember near-dup of a
    // TOMBSTONED record -> new record, tombstone untouched (not reinforced/revived)
    await st.softForget(x.id);
    const tomb = st.table.get(x.id);
    const y = await st.remember({ content: '部署前务必备份数据库到异地机房', kind: 'lesson', importance: 2, tags: ['ops'], confirm: true });
    assert.notEqual(y.id, x.id, 'black-hole guard1: near-dup of tombstone creates a NEW record');
    const tombAfter = st.table.get(x.id);
    assert.equal(tombAfter.observationCount, tomb.observationCount, 'black-hole: tombstone observationCount unchanged');
    assert.equal(tombAfter.importance, tomb.importance, 'black-hole: tombstone importance unchanged');
    assert.equal(tombAfter.updatedAt, tomb.updatedAt, 'black-hole: tombstone updatedAt unchanged');
    assert.ok(tombAfter.forgottenAt !== '', 'black-hole: tombstone stays forgotten (not revived)');

    // (11) memory-black-hole entry 2 (assessWrite quality gate): near-dup of a
    // tombstone must NOT be judged near-duplicate (would silently block the write).
    // Use an isolated store so the ONLY near-neighbor is the tombstone itself.
    {
      const stAW = new MemoryStore(makeStoreTable(), { workspaceDir: ws, logger: { warn() {}, info() {} } });
      const g = await stAW.remember({ content: '网关超时排查先看反代日志再看后端', kind: 'lesson', importance: 2, tags: ['ops'], confirm: true });
      await stAW.softForget(g.id); // only copy of this content is now a tombstone
      const aw = stAW.assessWrite({ content: '网关超时排查先看反代日志再看后端', kind: 'lesson', scope: 'project' });
      assert.notEqual(aw.verdict, 'near-duplicate', 'assessWrite: near-dup of a tombstone is NOT blocked (verdict!=near-duplicate)');
    }

    // (13) pinned write-protection (reinforcement): pin a record, re-remember near-dup
    // -> new record; pinned record's fields all unchanged
    const p = await st.remember({ content: '生产库测写操作绝不拿真实记录当样本', kind: 'lesson', importance: 3, tags: ['safety'], confirm: true });
    await st.table.put(p.id, { ...st.table.get(p.id), pinned: true });
    const pinnedBefore = st.table.get(p.id);
    const z = await st.remember({ content: '生产库测写操作绝不拿真实记录当样本啊', kind: 'lesson', importance: 3, tags: ['safety'], confirm: true });
    assert.notEqual(z.id, p.id, 'pinned write-protect: near-dup of pinned creates a NEW record (not reinforced into it)');
    const pinnedAfter = st.table.get(p.id);
    assert.equal(pinnedAfter.content, pinnedBefore.content, 'pinned: content unchanged');
    assert.equal(pinnedAfter.importance, pinnedBefore.importance, 'pinned: importance unchanged');
    assert.equal(pinnedAfter.observationCount, pinnedBefore.observationCount, 'pinned: observationCount unchanged');
    assert.equal(pinnedAfter.updatedAt, pinnedBefore.updatedAt, 'pinned: updatedAt unchanged');

    // (14) pinned delete-protection at DATA layer (bypasses panel authz)
    const d1 = await st.forget(p.id); // no confirm
    assert.equal(d1.skippedPinned, 1, 'pinned forget without confirm -> skippedPinned');
    assert.ok(st.table.get(p.id), 'pinned record NOT physically deleted');
    const d2 = await st.forget(p.id, true); // confirm
    assert.equal(d2.deleted, 1, 'pinned forget WITH confirm=true deletes');

    // (15) pinned soft-delete guard
    const p2 = await st.remember({ content: '另一条受保护记忆内容占位', kind: 'note', importance: 2, tags: ['x'], confirm: true });
    await st.table.put(p2.id, { ...st.table.get(p2.id), pinned: true });
    const s1 = await st.softForget(p2.id); // no confirm
    assert.equal(s1.skippedPinned, 1, 'pinned softForget without confirmSoft -> skippedPinned');
    assert.ok(!st.table.get(p2.id).forgottenAt, 'pinned record NOT tombstoned without confirm');
    const s2 = await st.softForget(p2.id, true);
    assert.equal(s2.softDeleted, 1, 'pinned softForget WITH confirmSoft=true tombstones');

    // (10) stats: total/byKind exclude tombstones, forgotten counted separately
    const st2 = new MemoryStore(makeStoreTable(), { workspaceDir: ws, logger: { warn() {}, info() {} } });
    const m1 = await st2.remember({ content: '活跃记忆一', kind: 'note', importance: 2, tags: ['t'], confirm: true });
    await st2.remember({ content: '活跃记忆二', kind: 'fact', importance: 2, tags: ['t'], confirm: true });
    await st2.softForget(m1.id);
    const s = st2.stats();
    assert.equal(s.total, 1, 'stats.total excludes tombstones');
    assert.equal(s.forgotten, 1, 'stats.forgotten counts tombstones separately');
    assert.equal(s.byKind.note ?? 0, 0, 'stats.byKind excludes tombstoned note');
    assert.equal(s.byKind.fact, 1, 'stats.byKind counts live fact');

    console.log('OK v0.4.2 store: soft-delete/restore, memory-black-hole guards (reinforce+assessWrite), pinned write/delete/softdelete protection, stats excludes tombstones');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}


// ── v0.3.0: Tier 1 snapshot (preference/fact, scope=user, imp>=2, char budget) ─
{
  const ws2 = mkdtempSync(join(tmpdir(), 'evolve-tier1-'));
  try {
    const st = new MemoryStore(makeStoreTable(), { workspaceDir: ws2, logger: { warn() {}, info() {} } });
    await st.remember({ content: '用户偏好中文回复、少过渡词', kind: 'preference', importance: 3, scope: 'user', confirm: true });
    await st.remember({ content: '生产库禁止拿真实记录当样本', kind: 'fact', importance: 3, scope: 'user', confirm: true });
    await st.remember({ content: '这是个 project 级低优先事实', kind: 'fact', importance: 1, scope: 'project', confirm: true });
    await st.remember({ content: '一条待确认偏好', kind: 'preference', importance: 3, scope: 'user' }); // pending -> excluded
    const snap = st.tier1Snapshot({ maxChars: 2200, kinds: ['preference', 'fact'], scope: 'user', minImportance: 2 });
    assert.ok(!snap.empty && snap.count === 2, `tier1 selects the 2 qualifying user prefs/facts (got ${snap.count})`);
    assert.ok(!snap.text.includes('project 级'), 'tier1 excludes project-scope / low-importance');
    assert.ok(!snap.text.includes('待确认'), 'tier1 excludes pending (unconfirmed) memories');
    assert.ok(snap.usedChars <= 2200, 'tier1 respects char budget');
    // budget truncation
    const tiny = st.tier1Snapshot({ maxChars: 20, kinds: ['preference', 'fact'], scope: 'user', minImportance: 2 });
    assert.ok(tiny.usedChars <= 20, 'tier1 truncates to a tiny budget');
    console.log('OK tier1: selects user preference/fact imp>=2, excludes pending/project/low-imp, respects budget');

    // profileView (v0.4.0 direction 2A): the auto-grown user profile.
    const profile = st.profileView();
    // 2 confirmed user prefs/facts (imp3 pref + imp3 fact); project + pending excluded.
    assert.equal(profile.total, 2, `profileView: only confirmed scope=user prefs/facts (got ${profile.total})`);
    assert.ok(profile.byKind.preference?.length === 1 && profile.byKind.fact?.length === 1, 'profileView: grouped by kind');
    const profStr = JSON.stringify(profile);
    assert.ok(!profStr.includes('project 级'), 'profileView: excludes project-scope');
    assert.ok(!profStr.includes('待确认'), 'profileView: excludes pending (unconfirmed) profile signals');
    console.log('OK profileView: auto-grown user profile (confirmed scope=user only, grouped by kind, pending/project excluded)');
  } finally { rmSync(ws2, { recursive: true, force: true }); }
}

// ── v0.3.0: LLM refine helper falls back to deterministic (null) when disabled/unavailable ─
{
  const { refineWithLLM, resolveRefineModel } = await import('./lib/llm-refine.js');
  // refineLLM off -> null (deterministic path)
  const off = await refineWithLLM({}, {}, { rawText: 'x', kind: 'crystallize', tag: 't', cfg: { refineLLM: false }, logger: { warn() {} } });
  assert.equal(off, null, 'refineWithLLM returns null when refineLLM disabled (fallback to deterministic)');
  // refineLLM on but no llm service -> null (never throws)
  const nollm = await refineWithLLM({}, {}, { rawText: 'x', kind: 'crystallize', tag: 't', cfg: { refineLLM: true }, logger: { warn() {} } });
  assert.equal(nollm, null, 'refineWithLLM returns null when no llm service (graceful, no throw)');
  // model-follow precedence: explicit override wins
  const over = resolveRefineModel({}, { refineProvider: 'p', refineModel: 'm' });
  assert.ok(over && over.provider === 'p' && over.model === 'm', 'resolveRefineModel: explicit config override wins');
  // no override -> follows current main model (request header config)
  const follow = resolveRefineModel({ agent: { session: { requestHeader: () => ({ config: { provider: 'main', model: 'M3' } }) } } }, { refineProvider: '', refineModel: '' });
  assert.ok(follow && follow.provider === 'main' && follow.model === 'M3', 'resolveRefineModel: empty config FOLLOWS current main model');
  // nothing resolvable -> null
  assert.equal(resolveRefineModel({}, { refineProvider: '', refineModel: '' }), null, 'resolveRefineModel: null when nothing resolvable');
  console.log('OK llm-refine: disabled/unavailable -> null fallback; model follows main unless overridden');
}

// ── v0.3.0: tar.gz backup + restoreFromBackup round-trip ─────────────────────
{
  const root2 = mkdtempSync(join(tmpdir(), 'evolve-backup-'));
  try {
    const skillsDir = join(root2, 'skills');
    const archiveDir = join(root2, 'workspace', 'archived-skills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    const recs = [{ id: 'm1', kind: 'lesson', importance: 3, content: '备份测试经验', tags: ['bk'] }];
    const w = skills.writeCrystallizedSkill(skillsDir, 'backup-test', 'bktag', recs, { warn() {} });
    assert.ok(w && existsSync(join(skillsDir, 'backup-test', 'SKILL.md')), 'skill written for backup test');
    const bk = skills.backupSkill(skillsDir, archiveDir, 'backup-test', 'manual');
    assert.ok(bk && existsSync(bk), `backupSkill produced a tar.gz (${bk})`);
    // delete active, then restore from backup
    rmSync(join(skillsDir, 'backup-test'), { recursive: true, force: true });
    const rb = skills.restoreFromBackup(skillsDir, archiveDir, 'backup-test', { warn() {} });
    assert.ok(rb.restored === true && existsSync(join(skillsDir, 'backup-test', 'SKILL.md')), 'restoreFromBackup recovers the skill');
    console.log('OK backup: tar.gz snapshot + restoreFromBackup round-trip');
  } finally { rmSync(root2, { recursive: true, force: true }); }
}


// ── v0.3.0 (option B): zero-token outcome triage recorder ────────────────────
{
  const { OutcomeTriage, triageSidecarPath } = await import('./lib/triage.js');
  const ws3 = mkdtempSync(join(tmpdir(), 'evolve-triage-'));
  try {
    const tr = new OutcomeTriage(triageSidecarPath(ws3), { warn() {} });
    // turn 1: loaded skill-a, no error -> success
    tr.noteSkillLoaded(1, 'skill-a');
    assert.equal(tr.flushTurn(1)?.success, true, 'triage: clean turn -> success=true');
    // turn 2: loaded skill-a, errored -> failure
    tr.noteSkillLoaded(2, 'skill-a');
    tr.noteError(2, 'ERR:boom');
    const t2 = tr.flushTurn(2);
    assert.ok(t2 && t2.success === false && t2.errors.length === 1, 'triage: errored turn -> success=false with fingerprint');
    // turn 3: nothing loaded, no error -> not recorded (noise skip)
    assert.equal(tr.flushTurn(3), null, 'triage: empty turn is not recorded');
    // summary aggregates per-skill load/success/error
    const sum = tr.summary();
    assert.ok(sum.totalTurns === 2 && sum.successes === 1 && sum.failures === 1, 'triage summary: 2 turns 1 ok 1 fail');
    assert.ok(sum.bySkill['skill-a'] && sum.bySkill['skill-a'].loaded === 2 && sum.bySkill['skill-a'].succeeded === 1 && sum.bySkill['skill-a'].errored === 1, 'triage summary: per-skill load/success/error counts');
    console.log('OK triage: zero-token (skillsLoaded,errors,success) per-turn record + per-skill summary; empty turns skipped');
  } finally { rmSync(ws3, { recursive: true, force: true }); }
}

console.log('\nALL SMOKE TESTS PASSED');
