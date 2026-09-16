"""Prove the cross-manifest resolution contract actually blocks rev17's holes.

rev17 accepted a resolution whose releasedCapId / releasedReceiptIds /
targetName / observedConflictHash were all invented, because nothing compared
them against the frozen operation. It also let a resolution enter CONFLICT,
recreating the very deadlock the resolution branch exists to break.

GATE A  pairing invariants (the 5 fictions rev17 accepted must all be rejected)
GATE B  resolution CAS (two resolutions must not own one frozen operation)
GATE C  resolution may never itself be frozen (schema-level)
GATE D  authorization destination per decision
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from resolution_validator import (  # noqa: E402
    RESOLVED, RESOLVING, UNRESOLVED, authorization_after_resolution,
    canonical_conflict_hash, check_resolution_cas, resolved_phase_for,
    validate_resolution_against_target,
)
from semantic_validator import validate_semantics  # noqa: E402

SCHEMA = json.loads((HERE / 'op-manifest.schema.json').read_text(encoding='utf-8'))
V = Draft202012Validator(SCHEMA, format_checker=Draft202012Validator.FORMAT_CHECKER)

NOW, LATER = '2026-09-15T12:00:00Z', '2026-09-15T12:05:00Z'
H, H2 = 'a' * 64, 'b' * 64
FROZEN_OP, RES_OP = 'op-frozen', 'op-res'

CONFLICT_DIAG = {'code': 'ETHIRDPARTY', 'message': 'sidecar moved',
                 'resources': ['my-skill'], 'at': LATER}
DIAG_HASH = canonical_conflict_hash(CONFLICT_DIAG)

# The frozen operation: authorization held at 'claimed' per the terminal matrix.
FROZEN = {
    'schemaVersion': 1, 'kind': 'apply', 'opId': FROZEN_OP, 'revision': 5,
    'phase': 'CONFLICT', 'createdAt': NOW, 'updatedAt': LATER,
    'eventsPath': f'.ops/{FROZEN_OP}/events.jsonl',
    'result': None, 'error': None, 'conflict': CONFLICT_DIAG,
    'source': 'web-proposal', 'protocol': 'B', 'proposalId': 'p-1', 'targetName': 'my-skill',
    'capClaim': {'capId': 'cap-frozen', 'purpose': 'proposal-apply', 'digest': H,
                 'claimedByOpId': FROZEN_OP, 'state': 'claimed'},
    'receiptClaims': [
        {'receiptId': 'rc-1', 'skillName': 'my-skill', 'callId': 'call-1', 'state': 'claimed'},
        {'receiptId': 'rc-2', 'skillName': 'my-skill', 'callId': 'call-2', 'state': 'claimed'},
    ],
    'resolution': {'status': UNRESOLVED},
    # rev19: the rest of the protocol-B required set. rev18's fixture omitted
    # these and was NEVER sent through the schema, so 32/32 was green while the
    # background object was a shape the schema can never produce.
    'reservationRevisionBefore': 8, 'reservationRevisionAfter': 9,
    'reservationOwner': {'proposalId': 'p-1', 'opId': FROZEN_OP},
    'stampProgress': {'done': [], 'pending': []},
    'beforeContentHash': H2, 'beforeStateHash': H2,
    'expectedAfterContentHash': H, 'expectedAfterStateHash': H,
    'tmpPath': 'skills/my-skill/SKILL.md.tmp', 'finalPath': 'skills/my-skill/SKILL.md',
    'backupPath': f'.ops/{FROZEN_OP}/backup/my-skill.tar', 'lastCommittedOpId': FROZEN_OP,
    'marker': {'opId': FROZEN_OP, 'protocol': 'B', 'action': 'refine',
               'expectedAfterContentHash': H, 'expectedAfterStateHash': H,
               'lastCommittedOpId': FROZEN_OP},
}

RESOLUTION = {
    'schemaVersion': 1, 'kind': 'resolution', 'opId': RES_OP, 'revision': 1,
    'phase': 'INTENT', 'createdAt': NOW, 'updatedAt': LATER,
    'eventsPath': f'.ops/{RES_OP}/events.jsonl',
    'result': None, 'error': None, 'conflict': None,
    'source': 'web-user', 'resolvesOpId': FROZEN_OP, 'resolvedKind': 'apply',
    'decision': 'rollback',
    'capClaim': {'capId': 'cap-res', 'purpose': 'operation-resolve', 'digest': H,
                 'claimedByOpId': RES_OP, 'state': 'claimed'},
    'releasedCapId': 'cap-frozen',
    'releasedReceiptIds': ['rc-1', 'rc-2'],
    'observedConflictHash': DIAG_HASH,
    'targetName': 'my-skill',
}

results = []


def rejects_with(manifest, code):
    """Assert the SPECIFIC rule fired, not merely that something did.

    bool(validate_semantics(...)) is not enough: sibling rules cover for each
    other. Disabling the RESOLVED-with-frozen-phase guard still left every test
    green, because an adjacent elif returned a different error for the same
    shape -- while the shape it uniquely guards (RESOLVED + no decision +
    CONFLICT) silently became accepted.
    """
    errs = validate_semantics(manifest)
    hit = [e for e in errs if e.startswith(f'[{code}]')]
    return bool(hit), (f'expected [{code}], got: '
                       + ('; '.join(e[:90] for e in errs) if errs else 'NO ERRORS AT ALL'))


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'   {detail}' if detail and not ok else ''))


print('=== GATE 0: BOTH fixtures must satisfy the schema ===')
# This gate is the whole lesson of rev18: GATE 2/3 in the main verifier only
# proved that POSITIVE resolution instances hit exactly one branch. Nothing ever
# sent the FROZEN background object through the schema, so a fixture the schema
# can never produce still yielded 32/32. A cross-object validator tested against
# an illegal background object tests nothing.
check('FROZEN fixture is schema-valid', V.is_valid(FROZEN),
      '; '.join(e.message[:120] for e in list(V.iter_errors(FROZEN))[:2]))
check('RESOLUTION fixture is schema-valid', V.is_valid(RESOLUTION),
      '; '.join(e.message[:120] for e in list(V.iter_errors(RESOLUTION))[:2]))
check('FROZEN really is in a freezable phase', FROZEN['phase'] in ('CONFLICT', 'PARTIAL'))
check('FROZEN can carry CAS state (schema declares it)',
      V.is_valid({**FROZEN, 'resolution': {'status': RESOLVING, 'resolutionOpId': RES_OP}}),
      'schema rejects the CAS object -> status is always absent -> CAS is a no-op')

print('\n=== GATE A: pairing invariants (rev17 accepted every one of these) ===')
errs = validate_resolution_against_target(RESOLUTION, FROZEN)
check('a correct resolution/target pair is accepted', not errs, '; '.join(errs[:2]))

PAIR_NEG = [
    ('releasedCapId invented', {**RESOLUTION, 'releasedCapId': 'cap-TOTALLY-UNRELATED'}, None),
    ('releasedReceiptIds empty (leaks both receipts)',
     {**RESOLUTION, 'releasedReceiptIds': []}, None),
    ('releasedReceiptIds only a subset (leaks rc-2)',
     {**RESOLUTION, 'releasedReceiptIds': ['rc-1']}, None),
    ('releasedReceiptIds naming a receipt the original never held',
     {**RESOLUTION, 'releasedReceiptIds': ['rc-1', 'rc-2', 'rc-ghost']}, None),
    ('resolvedKind is not a real kind', {**RESOLUTION, 'resolvedKind': 'nonexistent-kind'}, None),
    ('resolvedKind disagrees with the original', {**RESOLUTION, 'resolvedKind': 'move'}, None),
    ('targetName disagrees with the original',
     {**RESOLUTION, 'targetName': 'some-other-skill'}, None),
    ('observedConflictHash invented', {**RESOLUTION, 'observedConflictHash': 'f' * 64}, None),
    ('resolution spends the capability it is meant to free',
     {**RESOLUTION, 'capClaim': {**RESOLUTION['capClaim'], 'capId': 'cap-frozen'}}, None),
    ('target does not exist at all', RESOLUTION, 'MISSING'),
    ('target is not frozen (phase=COMMITTED)', RESOLUTION,
     {**FROZEN, 'phase': 'COMMITTED', 'conflict': None}),
    ('target is itself a resolution', RESOLUTION,
     {**FROZEN, 'kind': 'resolution', 'targetName': 'my-skill'}),
    ('frozen op carries no diagnostics to observe', RESOLUTION, {**FROZEN, 'conflict': None}),
    ('diagnostics changed since review', RESOLUTION,
     {**FROZEN, 'conflict': {**CONFLICT_DIAG, 'message': 'something else entirely'}}),
]
for name, res, orig in PAIR_NEG:
    target = FROZEN if orig is None else (None if orig == 'MISSING' else orig)
    check(f'rejected: {name}', bool(validate_resolution_against_target(res, target)))

print('\n=== GATE B: resolution CAS (only one owner) ===')
ok, code, _ = check_resolution_cas(FROZEN, RES_OP)
check('UNRESOLVED lets a resolution claim it', ok and code == 'claim', code)

resolving_mine = {**FROZEN, 'resolution': {'status': RESOLVING, 'resolutionOpId': RES_OP}}
ok, code, _ = check_resolution_cas(resolving_mine, RES_OP)
check('same resolution replaying gets its receipt back', ok and code == 'retry', code)

ok, code, _ = check_resolution_cas(resolving_mine, 'op-other')
check('a SECOND resolution is refused while one is in flight (409)',
      (not ok) and code == 'conflict', code)

resolved = {**FROZEN, 'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                                     'decision': 'rollback', 'resolvedAt': LATER}}
ok, code, _ = check_resolution_cas(resolved, 'op-other')
check('a second resolution is refused after RESOLVED (409)',
      (not ok) and code == 'conflict', code)
ok, code, _ = check_resolution_cas(resolved, RES_OP)
check('the owning resolution replaying after RESOLVED gets its receipt',
      ok and code == 'retry', code)
ok, code, _ = check_resolution_cas({**FROZEN, 'resolution': {'status': 'WAT'}}, RES_OP)
check('unknown resolution status fails closed', (not ok) and code == 'invalid', code)

print('\n=== GATE B2: CAS state is actually persistable (rev18 could not store it) ===')
for st in (UNRESOLVED, RESOLVING, RESOLVED):
    obj = {'status': st}
    if st != UNRESOLVED:
        obj['resolutionOpId'] = RES_OP
    if st == RESOLVED:
        obj.update({'decision': 'rollback', 'resolvedAt': LATER})
    check(f'frozen manifest can carry resolution.status={st}',
          V.is_valid({**FROZEN, 'resolution': obj}))
check('an unknown CAS status is rejected by the schema',
      not V.is_valid({**FROZEN, 'resolution': {'status': 'WAT'}}))
# The CAS check must see a real RESOLVING state and refuse a second owner.
resolving = {**FROZEN, 'resolution': {'status': RESOLVING, 'resolutionOpId': RES_OP}}
check('a schema-valid RESOLVING manifest refuses a second resolution',
      check_resolution_cas(resolving, 'op-other')[1] == 'conflict')

print('\n=== GATE B3: operations WITHOUT any capability can still be unfrozen ===')
# 7 of 14 branches can freeze with no capClaim at all. rev18 rejected both
# releasedCapId=null (semantic) and any value (pairing), so they were unfixable.
NOCAP_FROZEN = {
    'schemaVersion': 1, 'kind': 'direct', 'opId': 'op-nocap', 'revision': 2,
    'phase': 'PARTIAL', 'createdAt': NOW, 'updatedAt': LATER,
    'eventsPath': '.ops/op-nocap/events.jsonl',
    'result': None, 'error': None, 'conflict': CONFLICT_DIAG,
    'source': 'autonomous-tool', 'protocol': 'B', 'action': 'refine',
    'targetName': 'my-skill', 'beforeContentHash': H2, 'beforeStateHash': H2,
    'expectedAfterContentHash': H, 'expectedAfterStateHash': H,
    'tmpPath': 'skills/my-skill/SKILL.md.tmp', 'finalPath': 'skills/my-skill/SKILL.md',
    'backupPath': '.ops/op-nocap/backup/my-skill.tar', 'lastCommittedOpId': 'op-nocap',
    'marker': {'opId': 'op-nocap', 'protocol': 'B', 'action': 'refine',
               'expectedAfterContentHash': H, 'expectedAfterStateHash': H,
               'lastCommittedOpId': 'op-nocap'},
    'receiptClaims': [{'receiptId': 'rc-n', 'skillName': 'my-skill', 'callId': 'call-n',
                       'state': 'claimed'}],
    'stampProgress': {'done': [], 'pending': []}, 'configRevision': 4,
    'resolution': {'status': UNRESOLVED},
}
check('a capability-less frozen op is schema-valid', V.is_valid(NOCAP_FROZEN),
      '; '.join(e.message[:120] for e in list(V.iter_errors(NOCAP_FROZEN))[:1]))
NOCAP_RES = {**RESOLUTION, 'opId': 'op-res2', 'resolvesOpId': 'op-nocap',
             'resolvedKind': 'direct', 'releasedCapId': None,
             'releasedReceiptIds': ['rc-n'],
             'capClaim': {**RESOLUTION['capClaim'], 'claimedByOpId': 'op-res2'}}
errs = validate_resolution_against_target(NOCAP_RES, NOCAP_FROZEN)
check('resolving a capability-less op with releasedCapId=null is accepted',
      not errs, '; '.join(errs[:2]))
check('but naming a capability it never held is rejected',
      bool(validate_resolution_against_target(
          {**NOCAP_RES, 'releasedCapId': 'cap-invented'}, NOCAP_FROZEN)))

print('\n=== GATE B4: resolved terminals exist and match the decision ===')
for decision, want_phase in [('roll-forward', 'RESOLVED_ROLLED_FORWARD'),
                             ('rollback', 'RESOLVED_ROLLED_BACK'),
                             ('abandon', 'RESOLVED_ABANDONED')]:
    check(f'decision={decision} maps to {want_phase}', resolved_phase_for(decision) == want_phase)
    authz = authorization_after_resolution(decision)
    resolved = {**FROZEN, 'phase': want_phase,
                'capClaim': {**FROZEN['capClaim'], 'state': authz},
                'receiptClaims': [{**FROZEN['receiptClaims'][0], 'state': authz}],
                'conflict': None,
                'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                               'decision': decision, 'resolvedAt': LATER}}
    if decision == 'roll-forward':
        # roll-forward means the mutation DID land, so the durable receipt must
        # be present for idempotent replay (semantic rule 24).
        resolved['result'] = {'outcome': 'ok', 'completedAt': LATER,
                              'receipt': {'opId': FROZEN_OP, 'kind': 'apply',
                                          'targetName': 'my-skill', 'archiveId': None,
                                          'finalPath': FROZEN['finalPath'],
                                          'afterContentHash': H}}
    check(f'{want_phase} with authorization={authz} is schema-valid', V.is_valid(resolved),
          '; '.join(e.message[:110] for e in list(V.iter_errors(resolved))[:1]))
    check(f'{want_phase} passes single-manifest semantics', not validate_semantics(resolved),
          '; '.join(validate_semantics(resolved)[:2]))
    # Wrong authorization must be caught on BOTH sides independently.
    # Testing only capClaim let TERMINAL_AUTHZ_RECEIPT be deleted silently: for
    # the three RESOLVED_* terminals it is the sole trigger, and the base
    # terminals' receipt cases (covered in verify) never exercise them.
    wrong = 'claimed' if authz != 'claimed' else 'consumed'
    check(f'{want_phase} with capability={wrong} is rejected (cap-only)',
          *rejects_with({**resolved, 'capClaim': {**FROZEN['capClaim'], 'state': wrong}},
                        'TERMINAL_AUTHZ_CAP'))
    check(f'{want_phase} with receipt={wrong} is rejected (receipt-only)',
          *rejects_with({**resolved,
                         'receiptClaims': [{**FROZEN['receiptClaims'][0], 'state': wrong}]},
                        'TERMINAL_AUTHZ_RECEIPT'))
    # decision/phase mismatch must be caught
    other = 'abandon' if decision != 'abandon' else 'rollback'
    check(f'{want_phase} with resolution.decision={other} is rejected',
          *rejects_with({**resolved,
                         'resolution': {**resolved['resolution'], 'decision': other}},
                        'RESOLVED_DECISION_MISMATCH'))

print('\n=== GATE B5: rev20 -- new terminals must be in EVERY consuming set ===')
# rev19 added RESOLVED_* to TERMINAL_AUTHZ only, forgetting TERMINALS itself and
# rule 15's exclusivity table. Consequence was two-way: roll-forward's required
# receipt got rejected, and the resolved terminals skipped exclusivity entirely.
_rf = {**FROZEN, 'phase': 'RESOLVED_ROLLED_FORWARD', 'conflict': None,
       'capClaim': {**FROZEN['capClaim'], 'state': 'consumed'},
       'receiptClaims': [{**FROZEN['receiptClaims'][0], 'state': 'consumed'}],
       'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                      'decision': 'roll-forward', 'resolvedAt': LATER},
       'result': {'outcome': 'ok', 'completedAt': LATER,
                  'receipt': {'opId': FROZEN_OP, 'kind': 'apply', 'targetName': 'my-skill',
                              'archiveId': None, 'finalPath': FROZEN['finalPath'],
                              'afterContentHash': H}}}
check('roll-forward WITH a durable receipt is accepted', not validate_semantics(_rf),
      '; '.join(validate_semantics(_rf)[:1]))
check('roll-forward WITHOUT a durable receipt is rejected',
      *rejects_with({**_rf, 'result': None}, 'ROLL_FORWARD_MISSING_RECEIPT'))
_rb = {**FROZEN, 'phase': 'RESOLVED_ROLLED_BACK', 'conflict': None,
       'capClaim': {**FROZEN['capClaim'], 'state': 'available'},
       'receiptClaims': [{**FROZEN['receiptClaims'][0], 'state': 'available'}],
       'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                      'decision': 'rollback', 'resolvedAt': LATER}}
check('rolled-back carrying conflict AND error is rejected (exclusivity applies)',
      *rejects_with({**_rb, 'conflict': CONFLICT_DIAG,
                     'error': {'code': 'EIO', 'message': 'x', 'at': LATER}},
                    'TERMINAL_EVIDENCE_EXCLUSIVITY'))
check('rolled-back carrying a durable result is rejected (it never landed)',
      *rejects_with({**_rb, 'result': _rf['result']}, 'TERMINAL_EVIDENCE_EXCLUSIVITY'))

print('\n=== GATE B6: rev20 -- RESOLVED status must match the phase ===')
# The hole that resurrected rev17's leak: status=RESOLVED while still CONFLICT.
check('status=RESOLVED with phase=CONFLICT is rejected (permanent freeze)',
      *rejects_with({**FROZEN,
                     'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                                    'decision': 'rollback', 'resolvedAt': LATER}},
                    'RESOLVED_WITH_FROZEN_PHASE'))
check('status=RESOLVED with phase=PARTIAL is rejected',
      *rejects_with({**FROZEN, 'phase': 'PARTIAL',
                     'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                                    'decision': 'abandon', 'resolvedAt': LATER}},
                    'RESOLVED_WITH_FROZEN_PHASE'))
check('decision=abandon with phase=RESOLVED_ROLLED_BACK is rejected',
      *rejects_with({**_rb, 'resolution': {**_rb['resolution'], 'decision': 'abandon'}},
                    'RESOLVED_DECISION_MISMATCH'))
# The shape ONLY this guard protects: no decision means want_phase is None, so
# the sibling elif never fires. rev20 had no test for it, which is why disabling
# the guard left every test green.
check('status=RESOLVED with NO decision + phase=CONFLICT is rejected',
      *rejects_with({**FROZEN,
                     'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                                    'resolvedAt': LATER}},
                    'RESOLVED_WITH_FROZEN_PHASE'))
check('status=RESOLVED with NO decision + phase=PARTIAL is rejected',
      *rejects_with({**FROZEN, 'phase': 'PARTIAL',
                     'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                                    'resolvedAt': LATER}},
                    'RESOLVED_WITH_FROZEN_PHASE'))

check('a correctly paired RESOLVED_ABANDONED is accepted',
      not validate_semantics({**_rb, 'phase': 'RESOLVED_ABANDONED',
                              'resolution': {**_rb['resolution'], 'decision': 'abandon'}}))

print('\n=== GATE C: a resolution may never itself be frozen (schema) ===')
for ph in ('CONFLICT', 'PARTIAL'):
    inst = {**RESOLUTION, 'phase': ph, 'conflict': CONFLICT_DIAG}
    check(f'resolution with phase={ph} is rejected by the schema', not V.is_valid(inst))
for ph in ('COMPLETE', 'FAILED', 'ABORTED'):
    inst = {**RESOLUTION, 'phase': ph}
    if ph == 'COMPLETE':
        inst['result'] = {'outcome': 'ok', 'completedAt': LATER,
                          'receipt': {'opId': RES_OP, 'kind': 'resolution',
                                      'targetName': 'my-skill', 'archiveId': None,
                                      'finalPath': None, 'afterContentHash': None}}
        inst['capClaim'] = {**RESOLUTION['capClaim'], 'state': 'consumed'}
    elif ph == 'FAILED':
        inst['error'] = {'code': 'EIO', 'message': 'gone', 'at': LATER}
        inst['capClaim'] = {**RESOLUTION['capClaim'], 'state': 'available'}
    else:
        inst['capClaim'] = {**RESOLUTION['capClaim'], 'state': 'available'}
    check(f'resolution with phase={ph} is accepted', V.is_valid(inst),
          '; '.join(e.message[:90] for e in list(V.iter_errors(inst))[:1]))

print('\n=== GATE D: authorization destination per decision ===')
for decision, want in [('roll-forward', 'consumed'), ('rollback', 'available'),
                       ('abandon', 'available')]:
    got = authorization_after_resolution(decision)
    check(f'decision={decision} -> frozen authorization becomes {want}', got == want, str(got))
check('an unknown decision has no destination (fail closed)',
      authorization_after_resolution('whatever') is None)

print('\n=== GATE E: canonical diagnostics hash is stable ===')
reordered = {'at': CONFLICT_DIAG['at'], 'resources': CONFLICT_DIAG['resources'],
             'message': CONFLICT_DIAG['message'], 'code': CONFLICT_DIAG['code']}
check('key order does not change the hash', canonical_conflict_hash(reordered) == DIAG_HASH)
check('a content change does change the hash',
      canonical_conflict_hash({**CONFLICT_DIAG, 'code': 'EOTHER'}) != DIAG_HASH)

failed = [r for r in results if not r[1]]
print(f'\n{"=" * 62}\nTOTAL: {len(results) - len(failed)}/{len(results)} passed, {len(failed)} failed')
if failed:
    print('\nFAILURES:')
    for n, _, d in failed:
        print(f'  - {n}   {d}')
sys.exit(1 if failed else 0)
