// Smoke test for dsh-evolve v0.2.0. Run with node22 from the package dir
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
  createdAt: new Date.toISOString, updatedAt: new Date.toISOString,
  accessedAt: '', accessCount: 0, expiresAt: '', crystallizedAt: '',
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
const idx = await fts.createFtsIndex({ warn {}, info {} }, true);
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
  idx.close;
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

// ── skills: naming contract (post hash-suffix; never degenerate) ──────────────
const skills = await import('./lib/skills.js');
const nm = skills.skillNameFromTag('Warehouse 安全!');
assert.ok(NAME_RE.test(nm) && nm.startsWith('warehouse-') && nm !== 'skill', `skill name kebab+hash: ${nm}`);
assert.equal(nm, skills.skillNameFromTag('Warehouse 安全!'), 'skill name deterministic');
assert.notEqual(skills.skillNameFromTag('反代'), skills.skillNameFromTag('网关超时'), 'distinct CJK tags -> distinct names');
assert.ok(NAME_RE.test(skills.skillNameFromTag('反代')) && skills.skillNameFromTag('反代') !== 'skill', 'pure-CJK tag -> legal non-degenerate name');

// SKILL.md render + state block round-trip
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

// ── skills lifecycle: crystallize -> refine -> archive -> restore -> states ───
const root = mkdtempSync(join(tmpdir, 'evolve-smoke-'));
const skillsDir = join(root, 'skills');
const archiveDir = join(root, 'workspace', 'archived-skills');
mkdirSync(skillsDir, { recursive: true });
try {
  // crystallize
  const w = skills.writeCrystallizedSkill(skillsDir, 'reverse-proxy-xy', 'reverse-proxy', seed, { warn {} });
  assert.ok(w && w.version === '1.0.0' && existsSync(w.path), 'crystallize writes v1.0.0 SKILL.md');

  // refine with NEW evidence -> version bumps, new section, sourceIds grow, human edits preserved
  const humanEdit = '\n<!-- HUMAN NOTE: keep this line -->\n';
  writeFileSync(w.path, readFileSync(w.path, 'utf8').replace('# reverse-proxy-xy', `# reverse-proxy-xy${humanEdit}`));
  const fresh = [mkRec({ id: 's3', content: '教训：外网504先分诊反代vs服务', kind: 'lesson', importance: 3 })];
  const r1 = skills.refineCrystallizedSkill(skillsDir, 'reverse-proxy-xy', 'reverse-proxy', [...seed,...fresh], { warn {} });
  assert.ok(r1 && r1.refined === true && r1.added === 1, 'refine folds in only NEW evidence (1)');
  const md2 = readFileSync(w.path, 'utf8');
  assert.ok(md2.includes('HUMAN NOTE: keep this line'), 'refine PRESERVES human edits');
  assert.ok(md2.includes('## Refinement v1.1.0'), 'refine appends versioned section');
  assert.match(md2, /^version:\s*1\.1\.0$/m, 'refine bumps frontmatter version');
  const st2 = skills.readState(md2);
  assert.ok(st2.version === '1.1.0' && st2.sourceIds.includes('s3') && st2.refinements.length === 1, 'state block updated (v1.1.0, +s3, 1 refinement)');

  // refine again with SAME evidence -> no-op (never double-counts)
  const r2 = skills.refineCrystallizedSkill(skillsDir, 'reverse-proxy-xy', 'reverse-proxy', [...seed,...fresh], { warn {} });
  assert.ok(r2 && r2.refined === false, 'refine is idempotent on already-folded evidence');

  // refuse to touch a non-evolve-owned skill
  const foreign = join(skillsDir, 'human-skill');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'SKILL.md'), '---\nname: human-skill\ndescription: "hand written"\n---\n# human\n');
  assert.ok(skills.archiveSkill(skillsDir, archiveDir, 'human-skill', { warn {} }).archived === false, 'archive refuses non-evolve-owned');
  assert.ok(skills.writeCrystallizedSkill(skillsDir, 'human-skill', 't', seed, { warn {} }) === null, 'crystallize refuses to clobber non-evolve skill');

  // states report: our skill is active, human-skill is NOT counted (not owned)
  const s0 = skills.listSkillStates(skillsDir, archiveDir, { staleDays: 30 });
  assert.equal(s0.counts.active, 1, 'exactly 1 evolve-owned active skill');
  assert.equal(s0.active[0].name, 'reverse-proxy-xy', 'active skill listed');
  assert.equal(s0.counts.archived, 0, 'nothing archived yet');

  // archive -> leaves active dir, lands in archive dir (reversible, not deleted)
  const a = skills.archiveSkill(skillsDir, archiveDir, 'reverse-proxy-xy', { warn {} });
  assert.ok(a.archived === true, 'archive succeeds');
  assert.ok(!existsSync(join(skillsDir, 'reverse-proxy-xy', 'SKILL.md')), 'archived skill left active dir (catalog shrinks)');
  assert.ok(existsSync(join(archiveDir, 'reverse-proxy-xy', 'SKILL.md')), 'archived skill preserved in archive (not deleted)');
  const s1 = skills.listSkillStates(skillsDir, archiveDir, { staleDays: 30 });
  assert.equal(s1.counts.active, 0, 'no active after archive');
  assert.equal(s1.counts.archived, 1, 'one archived');

  // restore -> back to active
  const rr = skills.restoreSkill(skillsDir, archiveDir, 'reverse-proxy-xy', { warn {} });
  assert.ok(rr.restored === true && existsSync(join(skillsDir, 'reverse-proxy-xy', 'SKILL.md')), 'restore returns skill to active dir');
  assert.equal(skills.countCrystallizedSkills(skillsDir), 1, 'countCrystallizedSkills counts restored skill');
  console.log('OK skills: crystallize->refine(preserve edits,+version,no-dup)->archive(reversible)->restore + ownership guards');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('\nALL SMOKE TESTS PASSED');
