// Smoke test: import dsh-evolve the way DSH boot does, and exercise the
// pure logic (no ctx needed) to prove APIs resolve + behave. Run with node22
// from the package dir so bare @deepseek-ai/* imports resolve via its deps.
import assert from 'node:assert';

const mod = await import('./lib/index.js');
assert.equal(mod.name, 'dsh-evolve', 'name export');
assert.ok(typeof mod.apply === 'function', 'apply export');
assert.ok(Array.isArray(mod.inject) && mod.inject.includes('storageDomain'), 'inject export');
console.log('OK index exports:', mod.name, JSON.stringify(mod.inject));

const search = await import('./lib/search.js');
const rec = {
  id: 'mem_1', content: '写操作测试绝不使用真实生产记录作为样本', kind: 'lesson',
  tags: ['warehouse', 'safety'], scope: 'user', project: '', importance: 3,
  createdAt: new Date.toISOString, updatedAt: new Date.toISOString,
  accessedAt: '', accessCount: 0, expiresAt: '', crystallizedAt: '',
};
const hits = search.rankRecords([rec], '生产库 测写 样本', 5, {});
assert.ok(hits.length === 1 && hits[0].score > 0, 'CJK recall hits');
assert.equal(search.rankRecords([rec], 'ok了吗', 5, {}).length, 0, 'filler query no hit');
console.log('OK search: CJK hit score=', hits[0].score.toFixed(3), '| filler filtered');

const spec = await import('./lib/spec.js');
const parsed = spec.MemoryRecordSchema({
  id: 'x', content: 'c', createdAt: 't', updatedAt: 't',
});
assert.equal(parsed.kind, 'note', 'schema default kind');
assert.equal(parsed.scope, 'project', 'schema default scope');
assert.equal(parsed.importance, 2, 'schema default importance');
assert.ok(Array.isArray(parsed.tags), 'schema default tags array');
console.log('OK spec: defaults applied ->', JSON.stringify({ kind: parsed.kind, scope: parsed.scope, imp: parsed.importance }));

const skills = await import('./lib/skills.js');
// Naming contract (post hash-suffix upgrade): <ascii-skeleton>-<hash>, always
// DSH-legal, never degenerates to bare "skill", deterministic + collision-free.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nm = skills.skillNameFromTag('Warehouse 安全!');
assert.ok(NAME_RE.test(nm) && nm.startsWith('warehouse-') && nm !== 'skill', `skill name kebab+hash: ${nm}`);
assert.equal(nm, skills.skillNameFromTag('Warehouse 安全!'), 'skill name deterministic');
assert.notEqual(skills.skillNameFromTag('反代'), skills.skillNameFromTag('网关超时'), 'distinct CJK tags -> distinct names');
assert.ok(NAME_RE.test(skills.skillNameFromTag('反代')) && skills.skillNameFromTag('反代') !== 'skill', 'pure-CJK tag -> legal non-degenerate name');
const md = skills.renderSkillMd('warehouse-safety', 'safety', [rec]);
assert.ok(md.startsWith('---\nname: warehouse-safety'), 'SKILL.md frontmatter');
assert.ok(md.includes('description:') && md.includes('## Lessons'), 'SKILL.md sections');
// Validate the frontmatter is parseable + name grammar DSH requires
const fmName = md.match(/name:\s*(\S+)/)[1];
assert.ok(NAME_RE.test(fmName), 'kebab name grammar');
console.log('OK skills: name/md render + frontmatter grammar valid');

console.log('\nALL SMOKE TESTS PASSED');
