/**
 * Retrieval precision, on a corpus that ships with the repository (issue #2).
 *
 * The fix was measured against the maintainer's own 60-record memory store, which
 * cannot be published -- a memory store is personal content, and anonymising it does
 * not change that. Without a corpus in the repo, the evidence for this fix lived on one
 * laptop: CI could not check it, and the next person to touch scoring would have to
 * re-derive the numbers from nothing.
 *
 * test-fixtures/retrieval-corpus.json is synthetic, and that makes it better evidence
 * rather than a fallback. The adversarial pairs are CONSTRUCTED to share exactly one
 * word with a record they must not recall; in a real store such pairs exist only by
 * accident, which is precisely why the plan flagged that the original fix might be
 * overfitted to one store's vocabulary.
 *
 * What is pinned here:
 *   - the false positives issue #2 was filed for return NOTHING
 *   - the genuine paraphrase hits still come back
 *   - the unrelated record that used to OUTSCORE a real hit now ranks below it
 * Scores are `base`: importance 1, accessCount 0, now == updatedAt, so all three
 * multipliers are 1 and the numbers compare against the floor the code actually uses.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { rankRecords, scoreRecord, matchBaseMin } from '../../lib/search.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const corpus = JSON.parse(
  readFileSync(join(repoRoot, 'test-fixtures', 'retrieval-corpus.json'), 'utf8'),
);
const NOW = Date.parse(corpus.baseTime);

/** Corpus records as store rows, with every score multiplier neutralised. */
const records = corpus.records.map((r) => ({
  id: r.id,
  content: r.content,
  kind: r.kind,
  tags: r.tags,
  scope: r.scope,
  importance: r.importance,
  createdAt: corpus.baseTime,
  updatedAt: corpus.baseTime,
  accessCount: 0,
  observationCount: 1,
}));

const byId = new Map(records.map((r) => [r.id, r]));
const recall = (q, limit = 5) => rankRecords(records, q, limit, { now: NOW });
const base = (id, q) => scoreRecord(byId.get(id), q, { now: NOW });

test('the corpus is synthetic and self-describing', () => {
  // A guard on the fixture itself: if someone replaces it with real data, the reasons
  // recorded per record are the first thing that would be dropped.
  assert.ok(records.length >= 8, 'the corpus should keep enough filler to be meaningful');
  for (const r of corpus.records) {
    assert.ok(typeof r._why === 'string' && r._why.length > 20,
      `${r.id} must say why it is in the corpus, or nobody can tell what breaking it means`);
  }
  for (const q of corpus.queries) {
    assert.ok(typeof q._why === 'string' && q._why.length > 20,
      `query ${q.q} must say what it is testing`);
  }
});

test('every query in the corpus behaves as recorded', () => {
  for (const { q, expect: expected } of corpus.queries) {
    const hits = recall(q);
    if (expected === null) {
      assert.deepEqual(hits.map((h) => h.record.id), [],
        `"${q}" must recall nothing; it shares only a coincidental word. Got: `
        + hits.map((h) => `${h.record.id}(${h.score.toFixed(3)})`).join(', '));
    } else {
      assert.ok(hits.length > 0, `"${q}" recalled nothing, but ${expected} should match`);
      assert.equal(hits[0].record.id, expected,
        `"${q}" should rank ${expected} first, got `
        + hits.map((h) => `${h.record.id}(${h.score.toFixed(3)})`).join(', '));
    }
  }
});

test('a lone shared 2-gram is not enough to reach the floor', () => {
  // The mechanism, stated directly. FRAGMENT was 0.6 against a floor whose lower bound
  // is also 0.6, so one coincidence cleared it. 编程语言 shares 语言 with the
  // preference record's tag and nothing else.
  const q = '编程语言';
  assert.equal(base('syn_lang_pref', q), 0,
    'the preference record must score 0 for a query that only shares its tag word');
  assert.ok(matchBaseMin(q) > 0, 'the floor must still be a positive number');
});

test('fragment credit stays below the floor on its own', () => {
  // Pins the FRAGMENT half of the fix directly. Reverting it from 0.3 to 0.6 does not
  // break the other assertions -- per-word tag matching plus corroboration already
  // rejects the adversarial queries -- so without this the three changes could be
  // eroded one at a time while the suite stayed green. The mechanism: FRAGMENT was
  // exactly the floor's lower bound (0.6), so one coincidental 2-gram cleared it.
  const q = '这个技能的处理流程是怎样的';
  const floor = matchBaseMin(q);
  // The lamp report earns fragment credit only: 处理 / 理流 / 流程 and no whole word.
  const fragmentsOnly = base('syn_lamp_report', q);
  assert.ok(fragmentsOnly > 0, 'fragments must still contribute something, or paraphrase recall dies');
  // Three fragments at 0.3 sit well under three at 0.6; the ceiling proves the weight
  // was actually halved rather than the record merely failing for another reason.
  assert.ok(fragmentsOnly < floor * 2.5,
    `fragment credit looks un-halved (base=${fragmentsOnly.toFixed(4)} floor=${floor.toFixed(2)}). `
    + 'FRAGMENT must stay below matchBaseMin\'s lower bound so one shared 2-gram cannot '
    + 'reach the floor unaided.');
});

test('the unrelated record no longer outscores a genuine hit', () => {
  // This is the fact that made a floor useless: the lamp report scored 1.7541 against a
  // real hit's 0.8393. It is still recalled for its query -- it shares three fragments
  // -- but it must now rank below the record that genuinely answers it.
  const q = '这个技能的处理流程是怎样的';
  const genuine = base('syn_skill_flow', q);
  const unrelated = base('syn_lamp_report', q);
  assert.ok(genuine > 0, 'the record that answers the query must still be recalled');
  assert.ok(unrelated < genuine,
    `the lamp report outscores the real answer again (unrelated=${unrelated.toFixed(4)} `
    + `genuine=${genuine.toFixed(4)}); while that holds, no floor can separate them`);
  const ranked = recall(q).map((h) => h.record.id);
  assert.equal(ranked[0], 'syn_skill_flow', `ranking put ${ranked[0]} first`);
});

test('a tag is searchable by its own name', () => {
  // The corroboration rule must not make a bare tag query unsatisfiable: 语言 matches
  // the tag and has nothing else to corroborate with.
  assert.ok(base('syn_lang_pref', '语言') > 0,
    'a query that is exactly a tag must still recall the record');
});

test('paraphrases are recalled through fragments', () => {
  // The other half of the trade. Fragment credit was halved, which is only affordable
  // because per-word tag matching restored the recall fragments used to carry; a
  // paraphrase sharing no whole word still has to work.
  const hits = recall('反向代理超时');
  assert.ok(hits.length > 0, 'the paraphrase must recall something');
  assert.ok(['syn_timeout_cause', 'syn_timeout_fix'].includes(hits[0].record.id),
    `expected a timeout record first, got ${hits[0].record.id}`);
});

test('English records still match ASCII queries', () => {
  const hits = recall('staging certificate');
  assert.ok(hits.some((h) => h.record.id === 'syn_english_note'),
    'ASCII word matching regressed: the English record was not recalled');
  // And it must not answer an unrelated Chinese query.
  assert.ok(!recall('反向代理超时').some((h) => h.record.id === 'syn_english_note'),
    'the English record surfaced for a Chinese query about timeouts');
});

test('filler records stay out of every result', () => {
  const filler = ['syn_backup_cron', 'syn_deploy_order'];
  for (const { q } of corpus.queries) {
    const ids = recall(q).map((h) => h.record.id);
    for (const f of filler) {
      assert.ok(!ids.includes(f),
        `"${q}" recalled filler record ${f}; it shares no real signal with the query`);
    }
  }
});
