/**
 * Skill ownership, decided structurally instead of by substring.
 *
 * The hole this closes: ownership used to be
 *
 *     readFileSync(file, 'utf8').includes('dsh-evolve (crystallized)')
 *
 * so any skill whose PROSE mentioned that phrase was treated as ours and became
 * eligible for overwrite, fold and archive. A hand-written skill documenting
 * dsh-evolve itself qualifies. Before autonomous apply that was a
 * misclassification; with it, it is an authorization hole.
 *
 * Run: node --test scripts/schema/skill-ownership.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyOwnership, isEvolveOwned, readAuthor, readStateBlock, getOwnerId,
  claimState, OWNERSHIP, EVOLVE_MARKER,
} from '../../lib/skill-ownership.js';

const OWNER = 'a'.repeat(32);

/** A well-formed evolve state block. */
const goodState = (extra = {}) => ({
  tag: 'reverse-proxy',
  version: '1.0.0',
  createdAt: '2026-01-01T00:00:00Z',
  baseDescription: 'x',
  sourceIds: ['mem_1'],
  refinements: [],
  ...extra,
});

/** Render a SKILL.md the way skills.js does. */
function skillMd({ author = EVOLVE_MARKER, state = goodState({ ownerId: OWNER }), body = '# demo' } = {}) {
  const head = [
    '---',
    'name: demo',
    'description: "demo skill"',
    'version: 1.0.0',
    ...(author === null ? [] : [`author: ${author}`]),
    'license: MIT',
    '---',
    '',
  ].join('\n');
  const stateLine = state === null ? '' : `<!--dsh-evolve-state:${JSON.stringify(state)}-->\n`;
  return `${head}${body}\n\n${stateLine}`;
}

// ── the hole itself ──────────────────────────────────────────────────────────

test('a hand-written skill that merely MENTIONS the marker is not ours', () => {
  // The exact shape that used to pass: the phrase appears in the prose while the
  // frontmatter author is the human. This is the vulnerability, verbatim.
  const md = skillMd({
    author: 'chenzhe',
    state: null,
    body: '# notes on dsh-evolve\n\nThe crystallizer writes `dsh-evolve (crystallized)` into the author field.',
  });
  assert.ok(md.includes(EVOLVE_MARKER), 'the substring really is present');
  assert.equal(isEvolveOwned(md, OWNER), false,
    'prose mentioning the marker must not grant us permission to overwrite the file');
  assert.equal(classifyOwnership(md, OWNER).status, OWNERSHIP.FOREIGN);
});

test('a genuine evolve skill is ours', () => {
  const md = skillMd();
  assert.equal(isEvolveOwned(md, OWNER), true);
  assert.equal(classifyOwnership(md, OWNER).status, OWNERSHIP.OWNED);
});

test('a corrupted state block means hands off, not "probably fine"', () => {
  const md = skillMd().replace(/<!--dsh-evolve-state:.*?-->/s, '<!--dsh-evolve-state:{not json-->');
  const v = classifyOwnership(md, OWNER);
  assert.equal(v.status, OWNERSHIP.MALFORMED);
  assert.equal(isEvolveOwned(md, OWNER), false,
    'refusing to mutate a file we cannot parse is the conservative direction');
  // Distinguish "unparseable" from "parsed but incomplete": both refuse, but the
  // message is what a human reads when deciding whether the file is salvageable.
  assert.match(v.reason, /missing or unparseable/,
    'an unreadable state block must say so, not report a missing-field problem');
  assert.equal(v.state, null, 'and it must not hand back a half-parsed state');
});

test('a state block missing required fields is malformed', () => {
  for (const drop of ['tag', 'version', 'createdAt', 'sourceIds']) {
    const state = goodState({ ownerId: OWNER });
    delete state[drop];
    const v = classifyOwnership(skillMd({ state }), OWNER);
    assert.equal(v.status, OWNERSHIP.MALFORMED, `missing ${drop} must not count as owned`);
  }
});

test('sourceIds must actually be an array', () => {
  const v = classifyOwnership(skillMd({ state: goodState({ ownerId: OWNER, sourceIds: 'mem_1' }) }), OWNER);
  assert.equal(v.status, OWNERSHIP.MALFORMED);
});

// ── the installation binding ─────────────────────────────────────────────────

test('another installation\'s skill is not ours', () => {
  // The author line and the state block are public text anyone can copy, so the
  // ownerId is what actually binds a skill to this machine.
  const md = skillMd({ state: goodState({ ownerId: 'b'.repeat(32) }) });
  const v = classifyOwnership(md, OWNER);
  assert.equal(v.status, OWNERSHIP.FOREIGN);
  assert.match(v.reason, /different installation/);
  assert.equal(isEvolveOwned(md, OWNER), false);
  assert.equal(isEvolveOwned(md, OWNER, { allowLegacy: true }), false,
    'allowLegacy must not open the door to another machine\'s skills');
});

test('a legacy skill is recognised but NOT adopted automatically', () => {
  const md = skillMd({ state: goodState() });   // no ownerId
  const v = classifyOwnership(md, OWNER);
  assert.equal(v.status, OWNERSHIP.LEGACY_UNCLAIMED);
  assert.match(v.reason, /claiming the user's own work/);

  assert.equal(isEvolveOwned(md, OWNER), false,
    'autonomous paths must leave unclaimed skills alone');
  assert.equal(isEvolveOwned(md, OWNER, { allowLegacy: true }), true,
    'manual tools may still operate on them');
});

test('claiming stamps the owner and is explicit', () => {
  const claimed = claimState(goodState(), OWNER);
  assert.equal(claimed.ownerId, OWNER);
  assert.ok(claimed.claimedAt, 'when it was claimed is auditable');
  assert.throws(() => claimState(goodState(), null), /requires an ownerId/);
});

test('a missing ownerId on this side cannot be bypassed', () => {
  const md = skillMd();     // carries a real ownerId
  assert.equal(isEvolveOwned(md, null), false,
    'with no local ownerId we cannot prove the skill is ours, so we must not touch it');
});

// ── parsing helpers ──────────────────────────────────────────────────────────

test('readAuthor only looks inside frontmatter', () => {
  assert.equal(readAuthor(skillMd()), EVOLVE_MARKER);
  assert.equal(readAuthor(`# no frontmatter\nauthor: ${EVOLVE_MARKER}\n`), null,
    'an author line in the body is not frontmatter');
  assert.equal(readAuthor(skillMd({ author: `"${EVOLVE_MARKER}"` })), EVOLVE_MARKER,
    'YAML quoting must not change the answer');
});

test('readStateBlock rejects non-objects', () => {
  assert.deepEqual(readStateBlock(skillMd()).tag, 'reverse-proxy');
  assert.equal(readStateBlock('<!--dsh-evolve-state:"a string"-->'), null);
  assert.equal(readStateBlock('<!--dsh-evolve-state:[1,2]-->'), null);
  assert.equal(readStateBlock('no state here'), null);
});

test('malformed input never throws', () => {
  for (const md of [null, undefined, '', 12345, {}]) {
    assert.equal(isEvolveOwned(md, OWNER), false);
  }
});

// ── the owner id file ────────────────────────────────────────────────────────

test('the owner id is generated once and reused', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-owner-'));
  try {
    const first = getOwnerId(ws);
    assert.ok(first && first.length >= 32, 'must be long enough to not be guessable');
    assert.equal(getOwnerId(ws), first, 'a second call must not rotate it');
    assert.ok(existsSync(join(ws, '.evolve-owner.json')));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('a damaged owner id file is replaced rather than trusted', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-owner-'));
  try {
    writeFileSync(join(ws, '.evolve-owner.json'), '{ broken');
    const id = getOwnerId(ws);
    assert.ok(id && id.length >= 32, 'a corrupt file must not leave us with no identity');
    assert.equal(getOwnerId(ws), id, 'and the replacement must then be stable');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('a too-short owner id is not accepted', () => {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-owner-'));
  try {
    writeFileSync(join(ws, '.evolve-owner.json'), JSON.stringify({ ownerId: 'abc' }));
    assert.notEqual(getOwnerId(ws), 'abc', 'a trivially guessable id is worse than none');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── wired into skills.js, not just defined ───────────────────────────────────

test('skills.js consults ownership on every mutating path', async () => {
  const src = readFileSync(new URL('../../lib/skills.js', import.meta.url), 'utf8');
  assert.ok(!/includes\(EVOLVE_MARKER\)/.test(src),
    'not one substring check may remain -- that was the hole');
  assert.match(src, /ownershipCheck\(/, 'the structural check must be the one in use');
});

test('the real skills.js refuses to overwrite a foreign skill', async () => {
  const skills = await import('../../lib/skills.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-sk-'));
  try {
    const skillsDir = join(root, 'skills');
    const dir = join(skillsDir, 'demo');
    mkdirSync(dir, { recursive: true });
    // A human's skill that talks about dsh-evolve.
    writeFileSync(join(dir, 'SKILL.md'), skillMd({
      author: 'chenzhe',
      state: null,
      body: '# my notes\n\nSee `dsh-evolve (crystallized)` in the author field.',
    }));

    const res = skills.writeCrystallizedSkill(
      skillsDir, 'demo', 'tag', [{ id: 'm1', kind: 'lesson', content: 'x' }],
      { warn() {} }, undefined, undefined, { ownerId: OWNER },
    );
    assert.equal(res, null, 'our crystallizer must not clobber the user\'s own file');
    assert.match(readFileSync(join(dir, 'SKILL.md'), 'utf8'), /my notes/,
      'and the file must be untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive stays available for a legacy skill (reversible, manual)', async () => {
  // Regression: tightening ownership initially broke archive for every existing
  // skill, because archive passed no ownerId at all and legacy was refused.
  // Archive changes no content and is human-invoked, so it must keep working.
  const skills = await import('../../lib/skills.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-sk-'));
  try {
    const skillsDir = join(root, 'skills');
    const archiveDir = join(root, 'archived');
    const dir = join(skillsDir, 'legacy-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd({ state: goodState() }));  // no ownerId

    const out = skills.archiveSkill(skillsDir, archiveDir, 'legacy-skill', { warn() {} }, { ownerId: OWNER });
    assert.equal(out.archived, true, `legacy skills must remain archivable: ${out.reason ?? ''}`);
    assert.ok(existsSync(join(archiveDir, 'legacy-skill', 'SKILL.md')), 'and preserved, not deleted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive refuses a foreign skill', async () => {
  const skills = await import('../../lib/skills.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-sk-'));
  try {
    const skillsDir = join(root, 'skills');
    const dir = join(skillsDir, 'theirs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd({ author: 'someone-else', state: null }));

    const out = skills.archiveSkill(skillsDir, join(root, 'archived'), 'theirs', { warn() {} }, { ownerId: OWNER });
    assert.equal(out.archived, false);
    assert.match(out.reason, /not evolve-owned/);
    assert.ok(existsSync(join(dir, 'SKILL.md')), 'their skill must stay where it is');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── legacy claiming: explicit, narrow, auditable ─────────────────────────────

test('unclaimed skills are listed but not adopted', async () => {
  const skills = await import('../../lib/skills.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-claim-'));
  try {
    const skillsDir = join(root, 'skills');
    const mk = (name, md) => {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, 'SKILL.md'), md);
    };
    mk('legacy-one', skillMd({ state: goodState() }));                       // ours, unclaimed
    mk('already-ours', skillMd());                                            // ours, claimed
    mk('theirs', skillMd({ author: 'chenzhe', state: null }));                // not ours

    const list = skills.listUnclaimedSkills(skillsDir, OWNER);
    assert.deepEqual(list.map((x) => x.name), ['legacy-one'],
      'only skills that look like ours AND lack the binding need claiming');
    assert.equal(list[0].tag, 'reverse-proxy', 'the list must carry enough context to decide');

    // Nothing was written.
    assert.equal(readStateBlock(readFileSync(join(skillsDir, 'legacy-one', 'SKILL.md'), 'utf8')).ownerId,
      undefined, 'listing must not stamp anything');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claiming stamps the ownerId and then the skill is ours', async () => {
  const skills = await import('../../lib/skills.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-claim-'));
  try {
    const skillsDir = join(root, 'skills');
    mkdirSync(join(skillsDir, 'legacy-one'), { recursive: true });
    const file = join(skillsDir, 'legacy-one', 'SKILL.md');
    writeFileSync(file, skillMd({ state: goodState() }));

    const before = readFileSync(file, 'utf8');
    assert.equal(isEvolveOwned(before, OWNER), false, 'not ours before claiming');

    const r = skills.claimLegacySkill(skillsDir, 'legacy-one', OWNER, { warn() {} });
    assert.equal(r.claimed, true, r.reason ?? '');

    const after = readFileSync(file, 'utf8');
    assert.equal(isEvolveOwned(after, OWNER), true, 'and ours afterwards');
    const st = readStateBlock(after);
    assert.equal(st.ownerId, OWNER);
    assert.ok(st.claimedAt, 'when it was claimed is recorded');
    assert.equal(st.tag, 'reverse-proxy', 'the rest of the state survives untouched');
    assert.match(after, /# demo/, 'and so does the human-written body');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claiming refuses anything that is not an unclaimed skill of ours', async () => {
  const skills = await import('../../lib/skills.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-claim-'));
  try {
    const skillsDir = join(root, 'skills');
    const mk = (name, md) => {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, 'SKILL.md'), md);
    };
    mk('theirs', skillMd({ author: 'chenzhe', state: null }));
    mk('other-machine', skillMd({ state: goodState({ ownerId: 'b'.repeat(32) }) }));
    mk('already-ours', skillMd());

    for (const name of ['theirs', 'other-machine', 'already-ours']) {
      const r = skills.claimLegacySkill(skillsDir, name, OWNER, { warn() {} });
      assert.equal(r.claimed, false, `${name} must not be claimable`);
    }
    // A foreign skill must be byte-identical afterwards.
    assert.equal(readAuthor(readFileSync(join(skillsDir, 'theirs', 'SKILL.md'), 'utf8')), 'chenzhe');
    assert.equal(readStateBlock(readFileSync(join(skillsDir, 'other-machine', 'SKILL.md'), 'utf8')).ownerId,
      'b'.repeat(32), 'another machine\'s binding must not be overwritten');

    assert.equal(skills.claimLegacySkill(skillsDir, 'nope', OWNER, { warn() {} }).claimed, false);
    assert.equal(skills.claimLegacySkill(skillsDir, '../escape', OWNER, { warn() {} }).claimed, false);
    assert.equal(skills.claimLegacySkill(skillsDir, 'legacy', null, { warn() {} }).claimed, false,
      'with no local identity there is nothing to bind to');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
