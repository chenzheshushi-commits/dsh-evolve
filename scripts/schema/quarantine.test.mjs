import test from'node:test';import assert from'node:assert/strict';import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';import{QuarantineService}from'../../lib/quarantine.js';import{secretIncident}from'../../lib/secret-scan.js';
function env(){const root=mkdtempSync(join(tmpdir(),'q-'));mkdirSync(join(root,'secret-incidents'),{recursive:true});const incident={incidentId:'secret_1',patternName:'github-pat',contentSha256:'a'.repeat(64),maskedSnippet:'prefix ***[REDACTED:github-pat]*** suffix',sourceIds:['m1'],at:new Date().toISOString()};writeFileSync(join(root,'secret-incidents','secret_1.json'),JSON.stringify(incident));const made=[];const q=new QuarantineService({workspaceDir:root,proposalStore:{create:x=>{made.push(x);return{id:'p1'}}}});return{root,q,made,incident}}
test('list and preview never expose raw secret',()=>{const e=env();try{const list=e.q.list();assert.equal(list.length,1);assert.deepEqual(Object.keys(list[0]).sort(),['at','incidentId','incidentRevision','maskedSnippet','normalizationVersion','occurrences','patternName','scannerVersion','sourceIds'].sort());const p=e.q.regenerate('secret_1');assert.equal(p.ok,true);assert.match(p.maskedPreview,/source memories/);assert.equal(JSON.stringify(p).includes('ghp_'),false)}finally{rmSync(e.root,{recursive:true,force:true})}});
test('candidate is short-lived/single-use and creates a NEW proposal',()=>{const e=env();try{const p=e.q.regenerate('secret_1');const a=e.q.apply('secret_1',p.candidateId);assert.equal(a.newProposalId,'p1');assert.equal(e.made[0].meta.regeneratedFromIncident,'secret_1');assert.equal(e.q.apply('secret_1',p.candidateId).status,409)}finally{rmSync(e.root,{recursive:true,force:true})}});

/**
 * The new binding fields must not become a leak channel.
 *
 * canonicalOccurrences carries offsets and a per-match FINGERPRINT so an approval
 * binds to exactly what was reviewed. A fingerprint is a hash; if any of these
 * fields ever carried the match itself, the incident file would become the
 * secret store the whole design avoids.
 */
test('occurrence metadata binds the finding without carrying it', () => {
  const root = mkdtempSync(join(tmpdir(), 'q-occ-'));
  try {
    mkdirSync(join(root, 'secret-incidents'), { recursive: true });
    const secret = `ghp_${'A'.repeat(30)}`;
    // Build the incident through the real scanner rather than by hand, so what is
    // tested is what production writes.
    const incident = secretIncident(`token: ${secret} tail`, { face: 'content', sourceIds: ['m1'] });
    writeFileSync(join(root, 'secret-incidents', `${incident.incidentId}.json`), JSON.stringify(incident));

    const q = new QuarantineService({ workspaceDir: root, proposalStore: { create: () => ({ id: 'p1' }) } });
    const [row] = q.list();
    assert.ok(row.occurrences.length >= 1, 'the finding must be recorded');
    assert.equal(JSON.stringify(row).includes(secret), false, 'list() must not carry the secret');

    const occ = row.occurrences[0];
    assert.equal(occ.rule, 'github-pat', 'the rule names what matched');
    assert.equal(typeof occ.matchFingerprint, 'string');
    assert.equal(occ.matchFingerprint.length, 64, 'a sha256 hex digest, not the match');
    assert.equal(occ.matchFingerprint.includes('ghp_'), false);
    assert.equal(typeof occ.ordinal, 'number', 'ordinal makes the list a multiset');

    const preview = q.regenerate(incident.incidentId);
    assert.equal(preview.ok, true);
    assert.equal(JSON.stringify(preview).includes(secret), false, 'the preview must not carry it either');
    assert.equal(JSON.stringify(preview.canonicalOccurrences).includes(secret), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two identical secrets in one field are two occurrences, not one', () => {
  const secret = `ghp_${'B'.repeat(30)}`;
  const inc = secretIncident(`first ${secret} then again ${secret}`, { face: 'content' });
  assert.equal(inc.occurrences.length, 2,
    'a set would collapse these to one, and approving the "one" false positive '
    + 'would wave through the second copy');
  const [a, b] = inc.occurrences;
  assert.equal(a.matchFingerprint, b.matchFingerprint, 'same bytes, same fingerprint');
  assert.notEqual(a.start, b.start, 'but different positions');
});

test('a scanner change invalidates an outstanding approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'q-ver-'));
  try {
    mkdirSync(join(root, 'secret-incidents'), { recursive: true });
    const inc = secretIncident(`x ghp_${'C'.repeat(30)}`, { face: 'content', sourceIds: ['m1'] });
    writeFileSync(join(root, 'secret-incidents', `${inc.incidentId}.json`), JSON.stringify(inc));

    const q = new QuarantineService({ workspaceDir: root, proposalStore: { create: () => ({ id: 'p1' }) } });
    const preview = q.regenerate(inc.incidentId);
    assert.equal(preview.ok, true);
    // Simulate the scanner being upgraded between review and apply.
    q.candidates.get(preview.candidateId).scannerVersion = 'stale-version';
    const out = q.apply(inc.incidentId, preview.candidateId);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'scanner-version-changed',
      'a decision made under the old scanner must not authorize findings nobody reviewed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a revised incident invalidates an outstanding approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'q-rev-'));
  try {
    mkdirSync(join(root, 'secret-incidents'), { recursive: true });
    const inc = secretIncident(`x ghp_${'D'.repeat(30)}`, { face: 'content', sourceIds: ['m1'] });
    const path = join(root, 'secret-incidents', `${inc.incidentId}.json`);
    writeFileSync(path, JSON.stringify(inc));

    const q = new QuarantineService({ workspaceDir: root, proposalStore: { create: () => ({ id: 'p1' }) } });
    const preview = q.regenerate(inc.incidentId);
    assert.equal(preview.ok, true);
    // The incident is rewritten: another source was found to contain it.
    writeFileSync(path, JSON.stringify({ ...inc, incidentRevision: 2, sourceIds: ['m1', 'm2'] }));
    const out = q.apply(inc.incidentId, preview.candidateId);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'incident-revised');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('regenerate previews are capped per incident', () => {
  const root = mkdtempSync(join(tmpdir(), 'q-cap-'));
  try {
    mkdirSync(join(root, 'secret-incidents'), { recursive: true });
    const incident = {
      incidentId: 'secret_cap', patternName: 'github-pat', contentSha256: 'a'.repeat(64),
      maskedSnippet: '***[REDACTED:github-pat]***', sourceIds: ['m1'],
      at: new Date().toISOString(), occurrences: [], incidentRevision: 1,
    };
    writeFileSync(join(root, 'secret-incidents', 'secret_cap.json'), JSON.stringify(incident));
    const q = new QuarantineService({ workspaceDir: root, proposalStore: { create: () => ({ id: 'p1' }) } });

    let last;
    for (let i = 0; i < 6; i += 1) last = q.regenerate('secret_cap');
    assert.equal(last.ok, false, 'an unbounded preview endpoint grows memory from outside');
    assert.equal(last.error, 'preview-limit-reached');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * The case the occurrence multiset exists for.
 *
 * An operator reviews an incident showing ONE finding and approves it as a false
 * positive. Before the apply lands, the incident is re-scanned and a SECOND copy
 * of the same secret is found -- same bytes, same fingerprint, different offset.
 * The revision and the scanner version are both unchanged, so only the occurrence
 * comparison can catch this. Without it, the approval for one finding silently
 * authorizes a finding nobody looked at.
 */
test('an extra occurrence found after review invalidates the approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'q-extra-'));
  try {
    mkdirSync(join(root, 'secret-incidents'), { recursive: true });
    const secret = `ghp_${'E'.repeat(30)}`;
    const inc = secretIncident(`one ${secret} end`, { face: 'content', sourceIds: ['m1'] });
    const path = join(root, 'secret-incidents', `${inc.incidentId}.json`);
    writeFileSync(path, JSON.stringify(inc));

    const q = new QuarantineService({ workspaceDir: root, proposalStore: { create: () => ({ id: 'p1' }) } });
    const preview = q.regenerate(inc.incidentId);
    assert.equal(preview.ok, true);
    assert.equal(preview.canonicalOccurrences.length, 1, 'reviewed with one finding');

    // Re-scanned: the same secret appears twice now. Revision and scanner version
    // deliberately left untouched, so this can only be caught by comparing the
    // findings themselves.
    const rescanned = secretIncident(`one ${secret} and ${secret} end`, { face: 'content', sourceIds: ['m1'] });
    writeFileSync(path, JSON.stringify({
      ...rescanned,
      incidentId: inc.incidentId,
      incidentRevision: 1,
    }));

    const out = q.apply(inc.incidentId, preview.candidateId);
    assert.equal(out.ok, false,
      'an approval for one finding must not authorize a second one nobody reviewed');
    assert.equal(out.error, 'occurrences-changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
