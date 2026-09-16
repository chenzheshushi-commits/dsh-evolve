"""Verify the rev14 op-manifest contract: metaschema + structure + semantics.

rev13 claimed "18/18 pass" while shipping a schema that failed check_schema().
The verifier never called it. Ordering here is deliberate:

  GATE 0  check_schema()          -- the check whose absence produced a false green
  GATE 1  FormatChecker is live   -- assert it actually rejects a bad date
  GATE 2  13/13 branches covered  -- every branch needs a positive instance
  GATE 3  discrimination          -- each positive matches exactly ONE branch
  GATE 4  structural negatives
  GATE 5  phase-conditional
  GATE 6  cross-field semantics

Exit code is non-zero on any failure so CI cannot ignore it.
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

sys.path.insert(0, str(Path(__file__).resolve().parent))
from semantic_validator import validate_semantics  # noqa: E402

HERE = Path(__file__).resolve().parent
SCHEMA = json.loads((HERE / 'op-manifest.schema.json').read_text(encoding='utf-8'))

results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'   {detail}' if detail and not ok else ''))
    return ok


# ---------------------------------------------------------------- GATE 0
print('=== GATE 0: metaschema (the check rev13 omitted) ===')
try:
    Draft202012Validator.check_schema(SCHEMA)
    check('check_schema(): schema is legal Draft 2020-12', True)
except Exception as e:
    check('check_schema(): schema is legal Draft 2020-12', False, f'{type(e).__name__}: {str(e)[:200]}')
    print('\nABORT: an illegal schema makes every downstream result meaningless.')
    sys.exit(1)

dups = []
for i, b in enumerate(SCHEMA['oneOf']):
    r = b.get('required', [])
    if len(r) != len(set(r)):
        seen, d = set(), set()
        for x in r:
            if x in seen:
                d.add(x)
            seen.add(x)
        dups.append((i, b.get('title'), sorted(d)))
check('no branch has duplicate required entries', not dups, str(dups))

# ---------------------------------------------------------------- GATE 1
print('\n=== GATE 1: FormatChecker actually enforced ===')
FC = Draft202012Validator.FORMAT_CHECKER
probe = Draft202012Validator({'type': 'string', 'format': 'date-time'}, format_checker=FC)
check('date-time format is live (rejects "not-a-date")', not probe.is_valid('not-a-date'),
      'rfc3339-validator missing -> format silently ignored')
check('date-time accepts a valid timestamp', probe.is_valid('2026-09-15T12:00:00Z'))

V = Draft202012Validator(SCHEMA, format_checker=FC)

# ---------------------------------------------------------------- fixtures
NOW, LATER = '2026-09-15T12:00:00Z', '2026-09-15T12:05:00Z'
H = 'a' * 64
H2 = 'b' * 64
OP = 'op-1'
PROP = 'p-1'


def base(kind, phase, **kw):
    d = {'schemaVersion': 1, 'kind': kind, 'opId': OP, 'revision': 3, 'phase': phase,
         'createdAt': NOW, 'updatedAt': LATER, 'eventsPath': f'.ops/{OP}/events.jsonl',
         'result': None, 'error': None, 'conflict': None}
    d.update(kw)
    return d


def cap(state='claimed', purpose='proposal-apply'):
    return {'capId': 'cap-1', 'purpose': purpose, 'digest': H,
            'claimedByOpId': OP, 'state': state}


def receipt(skill, state='claimed', rid='r-1', call=None):
    # callId must be unique per receipt: two skill loads are two distinct calls.
    return {'receiptId': rid, 'skillName': skill,
            'callId': call or f'call-{rid}', 'state': state}


def marker_ac(action='create'):
    return {'opId': OP, 'protocol': 'A' if action != 'rollback' else 'C', 'action': action,
            'expectedAfterContentHash': H, 'expectedAfterStateHash': H}


def marker_b(action='refine'):
    return {'opId': OP, 'protocol': 'B', 'action': action, 'expectedAfterContentHash': H,
            'expectedAfterStateHash': H, 'lastCommittedOpId': OP}


def marker_d(action, logical, aid):
    return {'opId': OP, 'protocol': 'D', 'action': action, 'logicalSkillName': logical, 'archiveId': aid}


OWNER = {'proposalId': PROP, 'opId': OP}
STAMPS = {'done': ['m1'], 'pending': ['m2']}
MEMBER = [{'path': 'SKILL.md', 'type': 'file', 'size': 12, 'mode': 420, 'contentHash': H}]


def resource(role, name, status='staged'):
    return {'role': role, 'name': name, 'beforePath': f'skills/{name}',
            'stagingPath': f'.ops/{OP}/staging/{name}', 'finalPath': f'skills/{name}',
            'archiveId': None, 'beforeContentHash': H, 'beforeStateHash': H,
            'afterContentHash': None, 'afterStateHash': None, 'backupPath': None, 'status': status}


PROPOSAL_TOOL = base('create-proposal', 'RESERVED', source='model-tool', action='refine',
                     targetName='my-skill', proposalId=PROP, proposalHash=H, sourceIds=['m1', 'm2'],
                     reservationKey=H, reservationRevisionBefore=7, reservationRevisionAfter=8,
                     reservationOwner=OWNER)

PROPOSAL_ROLLBACK = base('create-proposal', 'PREPARED', source='web-user', action='rollback',
                         targetName='my-skill', proposalId=PROP, proposalHash=H, artifactId=H,
                         artifactSha256=H, artifactPath=f'.ops/proposals/{PROP}/artifacts/{H}.tgz',
                         memberManifest=MEMBER,
                         capClaim=cap(purpose='rollback-proposal-create'))

# The only way out of CONFLICT/PARTIAL. Carries its own capability and names the
# frozen authorization it frees.
RESOLUTION = base('resolution', 'INTENT', source='web-user', resolvesOpId='op-frozen',
                  resolvedKind='apply', decision='rollback',
                  capClaim=cap(purpose='operation-resolve'),
                  releasedCapId='cap-frozen', releasedReceiptIds=['r-frozen'],
                  observedConflictHash=H, targetName='my-skill')

APPLY_A = base('apply', 'COMMITTED', source='web-proposal', protocol='A', proposalId=PROP,
               targetName='new-skill', capClaim=cap(), receiptClaims=[],
               reservationRevisionBefore=8, reservationRevisionAfter=9, reservationOwner=OWNER,
               stampProgress=STAMPS, stagingPath=f'.ops/{OP}/staging/new-skill',
               finalPath='skills/new-skill', marker=marker_ac('create'),
               expectedAfterContentHash=H, expectedAfterStateHash=H, backupPath=None)

APPLY_B = base('apply', 'COMMITTED', source='web-proposal', protocol='B', proposalId=PROP,
               targetName='my-skill', capClaim=cap(), receiptClaims=[receipt('my-skill')],
               reservationRevisionBefore=8, reservationRevisionAfter=9, reservationOwner=OWNER,
               stampProgress=STAMPS, beforeContentHash=H2, beforeStateHash=H2,
               expectedAfterContentHash=H, expectedAfterStateHash=H,
               tmpPath='skills/my-skill/SKILL.md.tmp', finalPath='skills/my-skill/SKILL.md',
               backupPath=f'.ops/{OP}/backup/my-skill.tar', marker=marker_b('refine'),
               lastCommittedOpId=OP)

APPLY_C = base('apply', 'RETIRED', source='web-proposal', protocol='C', proposalId=PROP,
               targetName='my-skill', capClaim=cap(), receiptClaims=[],
               reservationRevisionBefore=8, reservationRevisionAfter=8, reservationOwner=OWNER,
               stampProgress=STAMPS, artifactId=H, artifactSha256=H,
               artifactPath=f'.ops/proposals/{PROP}/artifacts/{H}.tgz', memberManifest=MEMBER,
               retiredPath=f'.ops/{OP}/retired/my-skill', stagingPath=f'.ops/{OP}/staging/my-skill',
               finalPath='skills/my-skill', marker=marker_ac('rollback'),
               expectedRestoredContentHash=H, expectedRestoredStateHash=H)

AUTO_CREATE = base('direct', 'COMMITTED', source='autonomous-tool', protocol='A', action='create',
                   targetName='new-skill', sourceIds=['m1'], reservationKey=H,
                   reservationRevisionBefore=1, reservationRevisionAfter=2, reservationOwner=OWNER,
                   stagingPath=f'.ops/{OP}/staging/new-skill', finalPath='skills/new-skill',
                   marker=marker_ac('create'), expectedAfterContentHash=H,
                   expectedAfterStateHash=H, stampProgress=STAMPS, configRevision=4)

AUTO_REFINE = base('direct', 'COMMITTED', source='autonomous-tool', protocol='B', action='refine',
                   targetName='my-skill', beforeContentHash=H2, beforeStateHash=H2,
                   expectedAfterContentHash=H, expectedAfterStateHash=H,
                   tmpPath='skills/my-skill/SKILL.md.tmp', finalPath='skills/my-skill/SKILL.md',
                   backupPath=f'.ops/{OP}/backup/my-skill.tar', marker=marker_b('refine'),
                   lastCommittedOpId=OP, receiptClaims=[receipt('my-skill')],
                   stampProgress=STAMPS, configRevision=4)

CONVERGE_WEB = base('converge', 'SOURCES_STAGED', source='web-proposal', proposalId=PROP,
                    targetName='umbrella-x', target=resource('target', 'umbrella-x'),
                    resources=[resource('source', 'source-a'), resource('source', 'source-b')],
                    receiptClaims=[receipt('source-a', rid='r-1'), receipt('source-b', rid='r-2')],
                    configRevision=4, capClaim=cap())

CONVERGE_AUTO = base('converge', 'SOURCES_STAGED', source='autonomous-tool', proposalId=None,
                     targetName='umbrella-x', target=resource('target', 'umbrella-x'),
                     resources=[resource('source', 'source-a'), resource('source', 'source-b')],
                     receiptClaims=[receipt('source-a', rid='r-1'), receipt('source-b', rid='r-2')],
                     configRevision=4)

AID = 'my-skill-20260915120000-abc123'
MOVE_WEB = base('move', 'COMMITTED', source='web-proposal', protocol='D', action='archive',
                sourceKey='skills/my-skill', destKey=f'skills/.archive/{AID}', beforeTreeHash=H,
                committedTreeHash=H, marker=marker_d('archive', 'my-skill', AID),
                logicalSkillName='my-skill', archiveId=AID, configRevision=4, capClaim=cap(purpose='skill-archive'))

MOVE_TOOL = base('move', 'COMMITTED', source='model-tool', protocol='D', action='restore',
                 sourceKey=f'skills/.archive/{AID}', destKey='skills/my-skill', beforeTreeHash=H,
                 committedTreeHash=H, marker=marker_d('restore', 'my-skill', AID),
                 logicalSkillName='my-skill', archiveId=AID, configRevision=4)

SAID = 'stale-skill-20260915120000-def456'
MOVE_AUTO = base('move', 'COMMITTED', source='auto', protocol='D', action='autoArchive',
                 sourceKey='skills/stale-skill', destKey=f'skills/.archive/{SAID}',
                 beforeTreeHash=H, committedTreeHash=H,
                 marker=marker_d('autoArchive', 'stale-skill', SAID),
                 logicalSkillName='stale-skill', archiveId=SAID, configRevision=4)

ROTATION = base('rotation', 'RESIGNING', fromKeyId='k1', toKeyId='k2', ownerRevisionBefore=2,
                ownerRevisionAfter=3, scannedAssets=['a'], verifiedAssets=[],
                namespaceLockOwner={'instanceId': 'i-1', 'opId': OP, 'pid': 4242,
                                    'processStartToken': '99887766', 'bootId': 'boot-uuid',
                                    'acquiredAt': NOW, 'ttlMs': 600000})

GOOD_RESULT = {'outcome': 'ok', 'completedAt': LATER,
               'receipt': {'opId': OP, 'kind': 'apply', 'targetName': 'my-skill',
                           'archiveId': None, 'finalPath': 'skills/my-skill/SKILL.md',
                           'afterContentHash': H}}
GOOD_ERROR = {'code': 'EIO', 'message': 'disk went away', 'at': LATER}
GOOD_CONFLICT = {'code': 'ETHIRDPARTY', 'message': 'sidecar moved', 'resources': ['my-skill'], 'at': LATER}

POSITIVES = [
    ('create-proposal / model-tool', PROPOSAL_TOOL),
    ('create-proposal / web rollback', PROPOSAL_ROLLBACK),
    ('apply A / web', APPLY_A),
    ('apply B / web', APPLY_B),
    ('apply C / web rollback', APPLY_C),
    ('direct A / autonomous create', AUTO_CREATE),
    ('direct B / autonomous refine', AUTO_REFINE),
    ('converge / web', CONVERGE_WEB),
    ('converge / autonomous', CONVERGE_AUTO),
    ('move D / web archive', MOVE_WEB),
    ('move D / tool restore', MOVE_TOOL),
    ('move D / autoArchive', MOVE_AUTO),
    ('rotation', ROTATION),
    ('operator resolution of a frozen op', RESOLUTION),
]

# Extra positives that are NOT branch representatives: they exist to prove a
# specific rule does not over-reject. Kept out of POSITIVES so the
# "one positive per branch" arithmetic stays exact.
SEMANTIC_POSITIVES = [
    # Different UTC offsets that are legal in absolute time must NOT be rejected.
    ('apply A with mixed UTC offsets (legal in absolute time)',
     {**APPLY_A, 'createdAt': '2026-09-15T12:00:00+08:00', 'updatedAt': '2026-09-15T05:00:00Z'}),
    ('FAILED with authorization correctly released',
     {**APPLY_B, 'phase': 'FAILED', 'error': GOOD_ERROR, 'capClaim': cap('available'),
      'receiptClaims': [receipt('my-skill', 'available')]}),
    ('CONFLICT holding authorization for the operator',
     {**APPLY_B, 'phase': 'CONFLICT', 'conflict': GOOD_CONFLICT, 'capClaim': cap('claimed'),
      'receiptClaims': [receipt('my-skill', 'claimed')]}),
]

# ---------------------------------------------------------------- GATE 2
print(f'\n=== GATE 2: branch coverage ({len(SCHEMA["oneOf"])} branches) ===')
check(f'positives cover every branch ({len(POSITIVES)} vs {len(SCHEMA["oneOf"])})',
      len(POSITIVES) == len(SCHEMA['oneOf']),
      f'{len(POSITIVES)} positives for {len(SCHEMA["oneOf"])} branches')
for name, inst in POSITIVES:
    ok = V.is_valid(inst)
    check(f'valid: {name}', ok,
          '; '.join(e.message[:110] for e in list(V.iter_errors(inst))[:2]))

# ---------------------------------------------------------------- GATE 3
print('\n=== GATE 3: oneOf discrimination ===')
DEFS = {'$defs': SCHEMA['$defs']}
matched_titles = set()
for name, inst in POSITIVES:
    hits = [b['title'] for b in SCHEMA['oneOf']
            if Draft202012Validator({**DEFS, **b}, format_checker=FC).is_valid(inst)]
    check(f'exactly one branch: {name}', len(hits) == 1, f'{len(hits)} -> {hits}')
    matched_titles.update(hits)
check('every branch is exercised by some positive',
      len(matched_titles) == len(SCHEMA['oneOf']),
      f'unmatched: {sorted({b["title"] for b in SCHEMA["oneOf"]} - matched_titles)}')

# ---------------------------------------------------------------- GATE 4
print('\n=== GATE 4: structural negatives ===')
NEG = [
    ('autonomous create + capClaim', {**AUTO_CREATE, 'capClaim': cap()}),
    ('autonomous refine + capClaim', {**AUTO_REFINE, 'capClaim': cap()}),
    ('autoArchive + capClaim', {**MOVE_AUTO, 'capClaim': cap()}),
    ('web archive without capClaim', {k: v for k, v in MOVE_WEB.items() if k != 'capClaim'}),
    ('rotation + protocol', {**ROTATION, 'protocol': 'A'}),
    ('apply without protocol', {k: v for k, v in APPLY_B.items() if k != 'protocol'}),
    ('unknown field', {**APPLY_B, 'somethingNew': 1}),
    ('apply B + stagingPath (forbidden)', {**APPLY_B, 'stagingPath': 'x'}),
    ('bad phase', {**APPLY_B, 'phase': 'MADE_UP'}),
    ('missing reservationRevisionAfter', {k: v for k, v in PROPOSAL_TOOL.items() if k != 'reservationRevisionAfter'}),
    ('createdAt not a date', {**APPLY_B, 'createdAt': 'not-a-date'}),
    ('non-sha256 content hash', {**APPLY_B, 'expectedAfterContentHash': 'deadbeef'}),
    ('protocol D marker on protocol A apply', {**APPLY_A, 'marker': marker_d('archive', 'x', 'y')}),
    ('protocol A marker on protocol D move', {**MOVE_WEB, 'marker': marker_ac('create')}),
    ('rollback proposal forced to carry sourceIds', {**PROPOSAL_ROLLBACK, 'sourceIds': ['m1']}),
    ('converge with 1 source', {**CONVERGE_AUTO, 'resources': [resource('source', 'source-a')]}),
    ('receipt with bad state', {**APPLY_B, 'receiptClaims': [{**receipt('my-skill'), 'state': 'weird'}]}),
    ('negative revision', {**APPLY_B, 'revision': -1}),
    # rev17: structural gates for the two P0 fixes
    ('rollback proposal WITHOUT a capability (schema-level)',
     {k: v for k, v in PROPOSAL_ROLLBACK.items() if k != 'capClaim'}),
    ('resolution with an unknown decision (schema-level)',
     {**RESOLUTION, 'decision': 'ignore-it'}),
    ('resolution missing observedConflictHash',
     {k: v for k, v in RESOLUTION.items() if k != 'observedConflictHash'}),
    # rev18: a resolution must never be freezable, or the deadlock returns
    ('resolution entering CONFLICT (would recreate the deadlock)',
     {**RESOLUTION, 'phase': 'CONFLICT', 'conflict': GOOD_CONFLICT}),
    ('resolution entering PARTIAL (would recreate the deadlock)',
     {**RESOLUTION, 'phase': 'PARTIAL', 'conflict': GOOD_CONFLICT}),
    ('resolution carrying non-null conflict at all',
     {**RESOLUTION, 'conflict': GOOD_CONFLICT}),
]
for name, inst in NEG:
    check(f'rejected: {name}', not V.is_valid(inst))

# ---------------------------------------------------------------- GATE 5
print('\n=== GATE 5: phase-conditional (structural) ===')

PHASE_CASES = [
    ('COMPLETE without result', {**APPLY_B, 'phase': 'COMPLETE'}, False),
    ('COMPLETE with result', {**APPLY_B, 'phase': 'COMPLETE', 'result': GOOD_RESULT,
                              'capClaim': cap('consumed'),
                              'receiptClaims': [receipt('my-skill', 'consumed')]}, True),
    ('FAILED without error', {**APPLY_B, 'phase': 'FAILED'}, False),
    ('FAILED with error', {**APPLY_B, 'phase': 'FAILED', 'error': GOOD_ERROR}, True),
    ('CONFLICT without diagnostics', {**APPLY_B, 'phase': 'CONFLICT'}, False),
    ('CONFLICT with diagnostics', {**APPLY_B, 'phase': 'CONFLICT', 'conflict': GOOD_CONFLICT}, True),
    ('PARTIAL without diagnostics', {**CONVERGE_AUTO, 'phase': 'PARTIAL'}, False),
    ('COMMITTED with premature result', {**APPLY_B, 'phase': 'COMMITTED', 'result': GOOD_RESULT}, False),
    ('COMPLETE with both result and error', {**APPLY_B, 'phase': 'COMPLETE',
                                             'result': GOOD_RESULT, 'error': GOOD_ERROR}, False),
    ('ABORTED with result', {**APPLY_B, 'phase': 'ABORTED', 'result': GOOD_RESULT}, False),
]
for name, inst, want in PHASE_CASES:
    check(f'phase: {name} -> {"valid" if want else "rejected"}', V.is_valid(inst) == want)

# ---------------------------------------------------------------- GATE 6
print('\n=== GATE 6: cross-field semantics ===')
for name, inst in POSITIVES + SEMANTIC_POSITIVES:
    errs = validate_semantics(inst)
    check(f'semantics clean: {name}', not errs, '; '.join(errs[:2]))

SEM_NEG = [
    ('foreign marker.opId', {**APPLY_A, 'marker': {**marker_ac('create'), 'opId': 'op-OTHER'}}),
    ('foreign capClaim.claimedByOpId', {**APPLY_A, 'capClaim': {**cap(), 'claimedByOpId': 'op-OTHER'}}),
    ('foreign reservationOwner.opId', {**APPLY_A, 'reservationOwner': {'proposalId': PROP, 'opId': 'op-OTHER'}}),
    ('reservation revision not advancing', {**PROPOSAL_TOOL, 'reservationRevisionAfter': 7}),
    ('reservation revision going backwards', {**APPLY_A, 'reservationRevisionAfter': 7}),
    ('marker.action != manifest.action', {**MOVE_WEB, 'marker': marker_d('restore', 'my-skill', AID)}),
    ('marker archiveId mismatch', {**MOVE_WEB, 'marker': marker_d('archive', 'my-skill', 'other-id')}),
    ('converge missing a receipt', {**CONVERGE_AUTO, 'receiptClaims': [receipt('source-a')]}),
    ('converge target also a source', {**CONVERGE_AUTO,
                                       'target': resource('target', 'source-a'),
                                       'targetName': 'source-a'}),
    ('protocol B receipt names wrong skill', {**APPLY_B, 'receiptClaims': [receipt('other-skill')]}),
    ('protocol B marker lastCommittedOpId mismatch',
     {**APPLY_B, 'marker': {**marker_b('refine'), 'lastCommittedOpId': 'op-OTHER'}}),
    ('COMPLETE with unconsumed capability',
     {**APPLY_B, 'phase': 'COMPLETE', 'result': GOOD_RESULT, 'capClaim': cap('claimed'),
      'receiptClaims': [receipt('my-skill', 'consumed')]}),
    ('receipt.opId mismatch in result',
     {**APPLY_B, 'phase': 'COMPLETE', 'capClaim': cap('consumed'),
      'receiptClaims': [receipt('my-skill', 'consumed')],
      'result': {**GOOD_RESULT, 'receipt': {**GOOD_RESULT['receipt'], 'opId': 'op-OTHER'}}}),
    ('stamp id both done and pending', {**APPLY_A, 'stampProgress': {'done': ['m1'], 'pending': ['m1']}}),
    ('updatedAt before createdAt', {**APPLY_A, 'updatedAt': '2026-09-15T11:00:00Z'}),
    ('move tree hash changed (treeHash excludes marker, so a move must not change it)',
     {**MOVE_WEB, 'committedTreeHash': H2}),
    ('rotation revision not advancing', {**ROTATION, 'ownerRevisionAfter': 2}),
    ('converge duplicate sources', {**CONVERGE_AUTO,
                                    'resources': [resource('source', 'source-a'), resource('source', 'source-a')]}),
    # ---- rev15: negatives for invariants 15-21 (review found these all passed) ----
    ('PARTIAL carrying result+error+conflict',
     {**CONVERGE_AUTO, 'phase': 'PARTIAL', 'conflict': GOOD_CONFLICT,
      'result': GOOD_RESULT, 'error': GOOD_ERROR}),
    ('FAILED carrying both error and conflict',
     {**APPLY_B, 'phase': 'FAILED', 'error': GOOD_ERROR, 'conflict': GOOD_CONFLICT}),
    ('COMPLETE receipt names a different target',
     {**APPLY_B, 'phase': 'COMPLETE', 'capClaim': cap('consumed'),
      'receiptClaims': [receipt('my-skill', 'consumed')],
      'result': {**GOOD_RESULT, 'receipt': {**GOOD_RESULT['receipt'], 'targetName': 'other-skill'}}}),
    ('COMPLETE receipt afterContentHash disagrees',
     {**APPLY_B, 'phase': 'COMPLETE', 'capClaim': cap('consumed'),
      'receiptClaims': [receipt('my-skill', 'consumed')],
      'result': {**GOOD_RESULT, 'receipt': {**GOOD_RESULT['receipt'], 'afterContentHash': H2}}}),
    ('protocol C marker claims action=create',
     {**APPLY_C, 'marker': {**marker_ac('rollback'), 'action': 'create'}}),
    ('archive spending a proposal-apply capability',
     {**MOVE_WEB, 'capClaim': cap(purpose='proposal-apply')}),
    ('restore spending an archive capability',
     {**MOVE_WEB, 'action': 'restore', 'marker': marker_d('restore', 'my-skill', AID),
      'capClaim': cap(purpose='skill-archive')}),
    ('converge resources[] containing a target role',
     {**CONVERGE_AUTO, 'resources': [resource('source', 'source-a'), resource('target', 'source-b')]}),
    ('converge target.role is source',
     {**CONVERGE_AUTO, 'target': {**resource('source', 'umbrella-x')}}),
    ('converge target.name disagrees with targetName',
     {**CONVERGE_AUTO, 'target': resource('target', 'other-umbrella')}),
    ('two receipts sharing one callId',
     {**CONVERGE_AUTO, 'receiptClaims': [receipt('source-a', rid='r-1', call='same'),
                                         receipt('source-b', rid='r-2', call='same')]}),
    ('two receipts sharing one receiptId',
     {**CONVERGE_AUTO, 'receiptClaims': [receipt('source-a', rid='dup'),
                                         receipt('source-b', rid='dup')]}),
    ('rotation verified an asset it never scanned',
     {**ROTATION, 'scannedAssets': ['a'], 'verifiedAssets': ['a', 'ghost']}),
    ('move whose tree content changed',
     {**MOVE_AUTO, 'committedTreeHash': H2}),
    # ---- rev16: terminal authorization matrix (review found all of these passed) ----
    ('FAILED leaving capability consumed',
     {**APPLY_B, 'phase': 'FAILED', 'error': GOOD_ERROR, 'capClaim': cap('consumed'),
      'receiptClaims': [receipt('my-skill', 'available')]}),
    ('FAILED leaving receipt consumed',
     {**APPLY_B, 'phase': 'FAILED', 'error': GOOD_ERROR, 'capClaim': cap('available'),
      'receiptClaims': [receipt('my-skill', 'consumed')]}),
    ('ABORTED leaving receipt claimed',
     {**APPLY_B, 'phase': 'ABORTED', 'capClaim': cap('available'),
      'receiptClaims': [receipt('my-skill', 'claimed')]}),
    ('CONFLICT consuming the capability',
     {**APPLY_B, 'phase': 'CONFLICT', 'conflict': GOOD_CONFLICT, 'capClaim': cap('consumed'),
      'receiptClaims': [receipt('my-skill')]}),
    ('PARTIAL consuming a receipt',
     {**CONVERGE_WEB, 'phase': 'PARTIAL', 'conflict': GOOD_CONFLICT,
      'receiptClaims': [receipt('source-a', 'consumed', rid='r-1'),
                        receipt('source-b', 'claimed', rid='r-2')]}),
    ('COMPLETE leaving capability merely claimed',
     {**APPLY_B, 'phase': 'COMPLETE', 'result': GOOD_RESULT, 'capClaim': cap('claimed'),
      'receiptClaims': [receipt('my-skill', 'consumed')]}),
    # ---- rev16: timestamps compared as absolute time, not as strings ----
    ('updatedAt earlier in absolute time despite sorting later',
     {**APPLY_A, 'createdAt': '2026-09-15T12:00:00+00:00',
      'updatedAt': '2026-09-15T11:00:00+08:00'}),
    ('timestamps without a UTC offset',
     {**APPLY_A, 'createdAt': '2026-09-15T12:00:00', 'updatedAt': '2026-09-15T12:05:00'}),
    # ---- rev17: rollback proposal must be capability-gated (review P0-1) ----
    ('rollback proposal with the wrong purpose',
     {**PROPOSAL_ROLLBACK, 'capClaim': cap(purpose='proposal-apply')}),
    ('evidence proposal must NOT carry a capability',
     {**PROPOSAL_TOOL, 'capClaim': cap(purpose='rollback-proposal-create')}),
    # ---- rev17: resolution invariants (review P0-2) ----
    ('resolution resolving itself',
     {**RESOLUTION, 'resolvesOpId': OP}),
    ('resolution chaining onto another resolution',
     {**RESOLUTION, 'resolvedKind': 'resolution'}),
    ('resolution reusing the frozen capability as its own',
     {**RESOLUTION, 'releasedCapId': 'cap-1'}),
    ('resolution with the wrong capability purpose',
     {**RESOLUTION, 'capClaim': cap(purpose='proposal-apply')}),
    ('non-resolution carrying resolvesOpId',
     {**APPLY_B, 'resolvesOpId': 'op-frozen'}),
    # rev19: releasedCapId may be null (7/14 branches freeze without any
    # capability), but the FIELD must be present so the outcome is auditable.
    ('resolution COMPLETE with releasedCapId absent entirely',
     {k: v for k, v in {**RESOLUTION, 'phase': 'COMPLETE',
                        'capClaim': cap('consumed', 'operation-resolve'),
                        'result': {**GOOD_RESULT,
                                   'receipt': {**GOOD_RESULT['receipt'],
                                               'kind': 'resolution'}}}.items()
      if k != 'releasedCapId'}),
]
# Where the rule carries a stable code, assert THAT code fired -- otherwise a
# sibling rule can cover for a disabled guard and the test still passes.
# Cases whose rule has no code yet fall back to "something fired"; the count is
# asserted below so this fallback cannot silently grow.
SEM_NEG_CODES = {
    'COMPLETE leaving capability merely claimed': 'TERMINAL_AUTHZ_CAP',
}
_uncoded = 0
for name, inst in SEM_NEG:
    errs = validate_semantics(inst)
    want = SEM_NEG_CODES.get(name)
    if want:
        hit = [e for e in errs if e.startswith(f'[{want}]')]
        check(f'semantics reject: {name} [{want}]', bool(hit),
              f'expected [{want}], got: '
              + ('; '.join(e[:80] for e in errs) if errs else 'NO ERRORS AT ALL'))
    else:
        _uncoded += 1
        check(f'semantics reject: {name}', bool(errs))

# Guard the guard: if someone adds a coded rule they must map it here too.
# Ratchet: this number may only go DOWN. Every coded rule removes one case from
# the weak "any error" bucket. It must never grow -- a new uncoded negative is a
# new place where a disabled guard can hide behind a sibling rule.
UNCODED_BUDGET = 47
check(f'uncoded semantic negatives <= {UNCODED_BUDGET} (ratchet: may only decrease)',
      _uncoded <= UNCODED_BUDGET,
      f'{_uncoded} cases match on "any error" -- add a code to the rule and map it '
      'in SEM_NEG_CODES')

# ---------------------------------------------------------------- GATE 7
# Cross-manifest pairing lives in its own file (it needs a frozen manifest AND a
# resolution). Run it here so one command still covers the whole contract.
print('\n=== GATE 7: cross-manifest resolution pairing ===')
import subprocess  # noqa: E402

_r = subprocess.run([sys.executable, str(HERE / 'test_resolution_pairing.py')],
                    capture_output=True, text=True)
_tot = [l for l in _r.stdout.splitlines() if l.startswith('TOTAL:')]
check(f'test_resolution_pairing.py passes ({_tot[0] if _tot else "no TOTAL line"})',
      _r.returncode == 0, _r.stdout[-300:] + _r.stderr[-200:])

# ---------------------------------------------------------------- GATE 8
# The cross-language corpus. A94 promises these contracts run inside the
# operation claim, which is JavaScript -- so there must be a spec both languages
# can execute. Replaying it here keeps the corpus from going stale.
print('\n=== GATE 8: cross-language conformance corpus ===')
_c = subprocess.run([sys.executable, str(HERE / 'test_conformance_corpus.py')],
                    capture_output=True, text=True)
_ctot = [l for l in _c.stdout.splitlines() if l.startswith('TOTAL:')]
check(f'test_conformance_corpus.py passes ({_ctot[0] if _ctot else "no TOTAL line"})',
      _c.returncode == 0, _c.stdout[-300:] + _c.stderr[-200:])

# ---------------------------------------------------------------- GATE 9
# Rule-level mutation coverage. An assertion that merely mentions a rule proves
# nothing; the rule must be un-deletable. This gate disables each coded rule in
# turn and demands the suite go red, with a verified exemption for rules that
# provably never fire alone. It is what caught TERMINAL_AUTHZ_RECEIPT being
# testable-in-name-only for the three RESOLVED_* terminals.
print('\n=== GATE 9: every coded rule is un-deletable ===')
_m = subprocess.run([sys.executable, str(HERE / 'test_rule_mutation_coverage.py')],
                    capture_output=True, text=True)
_msum = [l for l in _m.stdout.splitlines() if l.startswith('killed=')]
check(f'test_rule_mutation_coverage.py passes ({_msum[0] if _msum else "no summary"})',
      _m.returncode == 0, _m.stdout[-400:] + _m.stderr[-200:])

# ---------------------------------------------------------------- summary
passed = sum(1 for _, ok, _ in results if ok)
failed = len(results) - passed
print(f'\n{"=" * 62}\nTOTAL: {passed}/{len(results)} passed, {failed} failed')
if failed:
    print('\nFAILURES:')
    for n, ok, d in results:
        if not ok:
            print(f'  - {n}   {d}')
sys.exit(1 if failed else 0)
