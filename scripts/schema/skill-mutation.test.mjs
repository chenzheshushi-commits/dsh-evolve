/**
 * Every mutation of SKILL.md goes through applySkillMutation().
 *
 * This is primarily a wiring contract. A perfect gate nobody calls is no gate;
 * therefore the last test scans the REAL lib/index.js and forbids every direct
 * low-level mutator call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applySkillMutation, SKILL_MUTATION_ACTIONS } from '../../lib/skill-mutation.js';
import { writeCrystallizedSkill } from '../../lib/skills.js';

const OWNER = 'a'.repeat(32);

function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mut-'));
  const skillsDir = join(root, 'skills');
  const archiveDir = join(root, 'ws', 'archived-skills');
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  return { root, skillsDir, archiveDir, ownerId: OWNER, logger: { warn() {} } };
}

function evidence(tag = 'alpha') {
  return [{ id: `m_${tag}`, kind: 'lesson', importance: 2, content: `lesson ${tag}`, tags: [tag] }];
}

function create(e, name = 'alpha', tag = name, ownerId = OWNER) {
  return writeCrystallizedSkill(e.skillsDir, name, tag, evidence(tag), { warn() {} },
    '# Steps\n\nDo the thing.', undefined, { ownerId });
}

test('the public action inventory is explicit', () => {
  assert.deepEqual([...SKILL_MUTATION_ACTIONS], [
    'crystallize', 'refine', 'fold', 'converge', 'archive', 'restore', 'rollback',
  ]);
});

test('crystallize creates through the throat and returns a receipt', () => {
  const e = env();
  try {
    const r = applySkillMutation({ ...e, action: 'crystallize', source: 'model-tool', payload: {
      name: 'alpha', tag: 'alpha', records: evidence(), body: '# Alpha\n\nDo it.',
    } });
    assert.equal(r.ok, true, 'the throat must give callers an unambiguous success bit');
    assert.equal(r.name, 'alpha');
    assert.equal(r.mutation.status, 'applied');
    assert.equal(r.mutation.beforeHash, null);
    assert.ok(existsSync(join(e.skillsDir, 'alpha', 'SKILL.md')));
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('foreign prose can never pass a mutation action', () => {
  const e = env();
  try {
    const dir = join(e.skillsDir, 'theirs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), [
      '---', 'name: theirs', 'description: theirs', 'author: human', '---', '',
      '# Notes', '', 'The author marker is `dsh-evolve (crystallized)`.', '',
    ].join('\n'));
    for (const action of ['refine', 'fold', 'archive', 'rollback']) {
      const r = applySkillMutation({ ...e, action, source: 'model-tool', payload: {
        name: 'theirs', tag: 'theirs', records: evidence('theirs'), body: '# replacement',
      } });
      assert.equal(r.ok, false, `${action} must refuse their file`);
      assert.match(r.reason, /ownership refused/);
    }
    assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /# Notes/,
      'the foreign file is byte-preserved');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('an automatic source cannot mutate a legacy/unclaimed skill', () => {
  const e = env();
  try {
    create(e, 'legacy', 'legacy', null); // low-level fixture: old version, no ownerId
    const auto = applySkillMutation({ ...e, action: 'archive', source: 'turn-end-auto', payload: { name: 'legacy' } });
    assert.equal(auto.ok, false, 'turn/end may not silently adopt legacy output');
    assert.match(auto.reason, /legacy-unclaimed/);
    assert.ok(existsSync(join(e.skillsDir, 'legacy', 'SKILL.md')));

    const manual = applySkillMutation({ ...e, action: 'archive', source: 'model-tool', payload: { name: 'legacy' } });
    assert.equal(manual.archived, true, 'manual, reversible operation keeps legacy usable');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('refine and fold use one backup-before-rewrite rule', () => {
  const e = env();
  try {
    create(e);
    const refined = applySkillMutation({ ...e, action: 'refine', source: 'model-tool', payload: {
      name: 'alpha', tag: 'alpha', records: evidence('new'), body: 'A better rule.',
    } });
    assert.equal(refined.refined, true, refined.reason ?? '');
    assert.ok(refined.mutation.beforeHash);
    const backupRoot = join(e.root, 'ws', '.curator-backups');
    assert.ok(readdirSync(backupRoot).some((d) => d.endsWith('-refine')),
      'refine itself -- not a later action -- must create its recovery tarball');

    const folded = applySkillMutation({ ...e, action: 'fold', source: 'model-tool', payload: {
      name: 'alpha', body: '# Clean body\n\nOne canonical rule.',
    } });
    assert.equal(folded.folded, true, folded.reason ?? '');
    assert.match(readFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), 'utf8'), /One canonical rule/);

    assert.ok(readdirSync(backupRoot).some((d) => d.endsWith('-fold')),
      'fold itself must create a separate recovery tarball');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('converge preflights every original before creating the umbrella', () => {
  const e = env();
  try {
    create(e, 'one');
    create(e, 'two');
    const bad = join(e.skillsDir, 'human');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'SKILL.md'), '---\nname: human\nauthor: human\n---\n# Mine\n');

    const refused = applySkillMutation({ ...e, action: 'converge', source: 'model-tool', payload: {
      name: 'umbrella', tag: 'combined', records: [], body: '# Combined', originals: ['one', 'human'],
    } });
    assert.equal(refused.ok, false);
    assert.ok(!existsSync(join(e.skillsDir, 'umbrella')), 'preflight means no half-merge');
    assert.ok(existsSync(join(e.skillsDir, 'one', 'SKILL.md')), 'the good original also stays put');

    const good = applySkillMutation({ ...e, action: 'converge', source: 'model-tool', payload: {
      name: 'umbrella', tag: 'combined', records: [], body: '# Combined', originals: ['one', 'two'],
    } });
    assert.equal(good.converged, 'umbrella', good.reason ?? '');
    assert.deepEqual(good.archivedOriginals.sort(), ['one', 'two']);
    assert.ok(existsSync(join(e.skillsDir, 'umbrella', 'SKILL.md')));
    assert.ok(existsSync(join(e.archiveDir, 'one', 'SKILL.md')));
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('an installed policy is fail-closed', () => {
  const e = env();
  try {
    const base = { ...e, action: 'crystallize', source: 'model-tool', payload: {
      name: 'blocked', tag: 'x', records: [], body: '# X',
    } };
    const no = applySkillMutation({ ...base, policy: () => ({ allowed: false, reason: 'needs proposal' }) });
    assert.equal(no.ok, false);
    assert.equal(no.reason, 'needs proposal');
    assert.ok(!existsSync(join(e.skillsDir, 'blocked')));

    const broken = applySkillMutation({ ...base, policy: () => { throw new Error('policy offline'); } });
    assert.equal(broken.ok, false);
    assert.match(broken.reason, /failed closed/);
    assert.ok(!existsSync(join(e.skillsDir, 'blocked')));
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('restore and rollback enter the throat too', () => {
  const e = env();
  try {
    create(e);
    const archived = applySkillMutation({ ...e, action: 'archive', source: 'model-tool', payload: { name: 'alpha' } });
    assert.equal(archived.archived, true);
    const restored = applySkillMutation({ ...e, action: 'restore', source: 'model-tool', payload: { name: 'alpha' } });
    assert.equal(restored.restored, true);

    // refine creates a tar backup; overwrite live content, then roll it back.
    const refined = applySkillMutation({ ...e, action: 'refine', source: 'model-tool', payload: {
      name: 'alpha', tag: 'alpha', records: evidence('v2'), body: 'remember this',
    } });
    assert.equal(refined.refined, true);
    writeFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), readFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), 'utf8') + '\nBAD EDIT\n');
    const rolled = applySkillMutation({ ...e, action: 'rollback', source: 'model-tool', payload: { name: 'alpha' } });
    assert.equal(rolled.restored, true, rolled.reason ?? '');
    assert.doesNotMatch(readFileSync(join(e.skillsDir, 'alpha', 'SKILL.md'), 'utf8'), /BAD EDIT/);
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('protocol-D move refuses EXDEV and never copy+deletes', () => {
  const src = readFileSync(new URL('../../lib/skills.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('function moveDir'), src.indexOf('/**', src.indexOf('function moveDir')));
  assert.match(block, /cross-filesystem skill move refused/);
  assert.equal(/cpSync|copyFile|rmSync/.test(block), false);
  const archive = src.slice(src.indexOf('export function archiveSkill'), src.indexOf('export function restoreSkill'));
  assert.match(archive, /archive target already exists/);
  assert.equal(/existsSync\(dst\)\) rmSync/.test(archive), false);
});

test('REAL index.js reaches the filesystem only through the transaction layer', () => {
  const src = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');
  // Checked at the import face rather than by scanning for call text: a name that
  // was never imported cannot be called, and this cannot be defeated by aliasing
  // or by reformatting a call across lines.
  const imports = [...src.matchAll(/^import\s+(?:([\w*\s{},]+?)\s+from\s+)?['"]([^'"]+)['"];?$/gm)]
    .map((m) => ({ names: (m[1] ?? '').replace(/[{}]/g, ' '), from: m[2] }));
  const writers = [
    'writeCrystallizedSkill', 'refineCrystallizedSkill', 'foldSkillBody',
    'archiveSkill', 'restoreSkill', 'restoreFromBackup', 'applySkillMutation',
  ];
  for (const { names, from } of imports) {
    for (const w of writers) {
      assert.equal(new RegExp(`\\b${w}\\b`).test(names), false,
        `index.js imports ${w} from ${from}; every mutation must go through `
        + 'lib/skill-operations.js so it gets a manifest, a WAL and recovery');
    }
  }
  // And the transaction layer is genuinely in use, not merely imported.
  assert.match(src, /new SkillOperations\(\{/, 'the transaction service must be constructed');
  assert.ok((src.match(/skillTx\.\w+\(/g) ?? []).length >= 10,
    'tools, web apply, web prune and turn/end must all publish through the service');
  assert.ok((src.match(/mutationOrProposal\(/g) ?? []).length >= 4,
    'proposal-first model tools must keep entering the same authorization gate');
});

test('the transaction layer authorizes through applySkillMutation, never around it', () => {
  const src = readFileSync(new URL('../../lib/skill-operations.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ applySkillMutation \}/,
    'skill-operations.js is where authorization is consulted');
  assert.match(src, /dryRun: true/,
    'authorization must run as a dry run so the verdict and the write cannot diverge');
  // Publishing happens in the protocols; a direct low-level writer call inside the
  // service would skip the WAL and the single commit point.
  for (const w of ['writeCrystallizedSkill(', 'refineCrystallizedSkill(', 'foldSkillBody(']) {
    assert.equal(src.includes(w), false,
      `${w} inside the service would publish outside a protocol`);
  }
});

test('a dry run authorizes without touching the filesystem', () => {
  const e = env();
  try {
    const before = readdirSync(e.skillsDir);
    const verdict = applySkillMutation({
      ...e, action: 'crystallize', source: 'autonomous-tool', dryRun: true,
      payload: { name: 'dry-run-probe', tag: 'probe', records: evidence('probe'), body: '# body' },
    });
    assert.equal(verdict.ok, true, verdict.reason ?? 'dry run should authorize');
    assert.equal(verdict.dryRun, true, 'the caller must be able to tell a verdict from a write');
    assert.deepEqual(readdirSync(e.skillsDir), before,
      'a dry run that created a directory would mean the authorization step writes');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('a dry run still refuses what the real call would refuse', () => {
  const e = env();
  try {
    create(e, 'owned-elsewhere', 'owned-elsewhere', 'b'.repeat(32));
    const verdict = applySkillMutation({
      ...e, action: 'refine', source: 'autonomous-tool', dryRun: true,
      payload: { name: 'owned-elsewhere', tag: 'owned-elsewhere', records: evidence('x') },
    });
    assert.equal(verdict.ok, false,
      'a dry run that says yes where the real call says no would make the '
      + 'transaction layer publish changes authorization rejected');
  } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test('skill_style boundary stays outside because it never touches SKILL.md', () => {
  const src = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');
  const begin = src.indexOf("name: 'skill_style'");
  const end = src.indexOf("name: 'evolve_maintain'", begin);
  assert.ok(begin > 0 && end > begin);
  const block = src.slice(begin, end);
  assert.match(block, /setStyle\(|clearStyle\(/, 'it only changes the overlay');
  assert.equal(/applySkillMutation/.test(block), false,
    'putting style through the throat would falsely claim it mutates the skill itself');
});
