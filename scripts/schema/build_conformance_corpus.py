"""Emit a language-neutral conformance corpus: the SAME cases must yield the SAME
verdicts in Python and in the JS runtime.

Why this file exists: A94 promises the validators run "inside the operation
claim", but the operation claim is JavaScript and all four contracts are Python.
Without a bridge that promise is empty (the review called this the v0.5.0
"defined but never wired" failure, repeated across languages).

The corpus is the contract between the two implementations. It does not care how
JS validates -- ajv for structure, hand-written JS for pairing/CAS -- only that
every verdict matches.

Output: conformance-corpus.json
    { schemaVersion, generatedFrom, cases: [ {id, layer, input, expect, why} ] }

layer tells the JS side which validator must produce the verdict:
    structure  -> ajv against op-manifest.schema.json
    semantic   -> the JS port of semantic_validator
    pairing    -> the JS port of validate_resolution_against_target
    cas        -> the JS port of check_resolution_cas
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from jsonschema import Draft202012Validator  # noqa: E402

from resolution_validator import (  # noqa: E402
    RESOLVED, RESOLVING, UNRESOLVED, authorization_after_resolution,
    check_resolution_cas, resolved_phase_for, validate_resolution_against_target,
)
from semantic_validator import validate_semantics  # noqa: E402

SCHEMA_PATH = HERE / 'op-manifest.schema.json'
OUT = HERE / 'conformance-corpus.json'
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding='utf-8'))
V = Draft202012Validator(SCHEMA, format_checker=Draft202012Validator.FORMAT_CHECKER)

# Reuse the fixtures that the pairing test already proves are schema-valid, so
# the corpus can never drift from them.
# The pairing test exits at import time. Load it via importlib and absorb both
# the SystemExit and its stdout, so its fixtures can be reused without letting
# the corpus and the tests drift apart.
import contextlib  # noqa: E402
import importlib.util  # noqa: E402
import io  # noqa: E402

_spec = importlib.util.spec_from_file_location('trp', HERE / 'test_resolution_pairing.py')
T = importlib.util.module_from_spec(_spec)
with contextlib.redirect_stdout(io.StringIO()):
    try:
        _spec.loader.exec_module(T)
    except SystemExit:
        pass

cases = []


LEGAL = 'must-be-legal'        # every manifest in this case must pass schema+semantic
INTENTIONALLY_ILLEGAL = 'intentionally-illegal'   # the case exists to prove it is rejected

_gate_failures = []


def _assert_manifests_legal(case_id, payload):
    """Fixtures marked must-be-legal have to survive schema AND semantics.

    A corpus generated from a live implementation records whatever that
    implementation currently does -- so when the implementation has a hole, the
    corpus PROMOTES that hole into a cross-language contract. That is worse than
    a hand-written case, because it looks authoritative. This gate is what stops
    it: rev19 shipped two cas fixtures with phase=CONFLICT + status=RESOLVED,
    a shape that permanently freezes authorization, and the JS port would have
    copied it verbatim.
    """
    for key in ('manifest', 'original', 'resolution'):
        obj = payload.get(key)
        if not isinstance(obj, dict):
            continue
        if not V.is_valid(obj):
            msg = next((e.message for e in V.iter_errors(obj)), '?')
            _gate_failures.append(f'{case_id}: {key} is not schema-valid -> {msg[:120]}')
        errs = validate_semantics(obj)
        if errs:
            _gate_failures.append(f'{case_id}: {key} violates semantics -> {errs[0][:120]}')


def add(case_id, layer, payload, why, legality=LEGAL):
    """Record a case together with the verdict Python actually produces."""
    if legality == LEGAL:
        _assert_manifests_legal(case_id, payload)
    if layer == 'structure':
        expect = {'valid': V.is_valid(payload['manifest'])}
    elif layer == 'semantic':
        errs = validate_semantics(payload['manifest'])
        expect = {'valid': not errs, 'errorCount': len(errs)}
    elif layer == 'pairing':
        errs = validate_resolution_against_target(payload['resolution'], payload['original'])
        expect = {'valid': not errs, 'errorCount': len(errs)}
    elif layer == 'cas':
        ok, code, _ = check_resolution_cas(payload['original'], payload['resolutionOpId'])
        expect = {'ok': ok, 'code': code}
    else:
        raise AssertionError(f'unknown layer {layer}')
    cases.append({'id': case_id, 'layer': layer, 'legality': legality,
                  'input': payload, 'expect': expect, 'why': why})


FROZEN, RESOLUTION = T.FROZEN, T.RESOLUTION
H, H2 = T.H, T.H2
RES_OP = T.RES_OP

# ---- structure -------------------------------------------------------------
add('structure/frozen-valid', 'structure', {'manifest': FROZEN},
    'a frozen protocol-B apply is a legal manifest')
add('structure/resolution-valid', 'structure', {'manifest': RESOLUTION},
    'a resolution is a legal manifest')
add('structure/frozen-carries-cas', 'structure',
    {'manifest': {**FROZEN, 'resolution': {'status': RESOLVING, 'resolutionOpId': RES_OP}}},
    'CAS ownership must be storable -- rev18 could not store it, so CAS was a no-op')
add('structure/unknown-cas-status', 'structure',
    {'manifest': {**FROZEN, 'resolution': {'status': 'WAT'}}},
    'an unknown CAS status must be rejected, not treated as UNRESOLVED', INTENTIONALLY_ILLEGAL)
add('structure/resolution-cannot-freeze', 'structure',
    {'manifest': {**RESOLUTION, 'phase': 'CONFLICT', 'conflict': T.CONFLICT_DIAG}},
    'a frozen resolution would recreate the deadlock it exists to break', INTENTIONALLY_ILLEGAL)
add('structure/unknown-field', 'structure',
    {'manifest': {**FROZEN, 'somethingNew': 1}},
    'every branch is closed (additionalProperties:false)', INTENTIONALLY_ILLEGAL)
add('structure/autonomous-with-capability', 'structure',
    {'manifest': {**FROZEN, 'source': 'autonomous-tool'}},
    'the autonomous path has no Web capability, so this shape must not validate', INTENTIONALLY_ILLEGAL)

# ---- semantic --------------------------------------------------------------
add('semantic/frozen-clean', 'semantic', {'manifest': FROZEN},
    'the frozen fixture must satisfy single-manifest invariants')
add('semantic/foreign-marker-opid', 'semantic',
    {'manifest': {**FROZEN, 'marker': {**FROZEN['marker'], 'opId': 'op-someone-else'}}},
    "a foreign marker would let recovery adopt another operation's commit", INTENTIONALLY_ILLEGAL)
add('semantic/conflict-consuming-capability', 'semantic',
    {'manifest': {**FROZEN, 'capClaim': {**FROZEN['capClaim'], 'state': 'consumed'}}},
    'CONFLICT must hold authorization for the operator, never spend it', INTENTIONALLY_ILLEGAL)

for decision in ('roll-forward', 'rollback', 'abandon'):
    ph = resolved_phase_for(decision)
    authz = authorization_after_resolution(decision)
    resolved = {**FROZEN, 'phase': ph, 'conflict': None,
                'capClaim': {**FROZEN['capClaim'], 'state': authz},
                'receiptClaims': [{**FROZEN['receiptClaims'][0], 'state': authz}],
                'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                               'decision': decision, 'resolvedAt': T.LATER}}
    if decision == 'roll-forward':
        # The mutation landed, so the durable receipt must be there for replay.
        resolved['result'] = {'outcome': 'ok', 'completedAt': T.LATER,
                              'receipt': {'opId': FROZEN['opId'], 'kind': FROZEN['kind'],
                                          'targetName': FROZEN['targetName'],
                                          'archiveId': None,
                                          'finalPath': FROZEN['finalPath'],
                                          'afterContentHash': FROZEN['expectedAfterContentHash']}}
    add(f'structure/resolved-{decision}', 'structure', {'manifest': resolved},
        f'{ph} must be a reachable phase')
    add(f'semantic/resolved-{decision}', 'semantic', {'manifest': resolved},
        f'{decision} must leave authorization {authz}')
    wrong = 'claimed'
    # Both authorization sides need their own case. rev21 only varied capClaim,
    # so TERMINAL_AUTHZ_RECEIPT could be deleted while every chain stayed green
    # (the base terminals' receipt cases live in verify and never touch the
    # RESOLVED_* terminals, where this code is the sole trigger).
    add(f'semantic/resolved-{decision}-wrong-cap', 'semantic',
        {'manifest': {**resolved, 'capClaim': {**FROZEN['capClaim'], 'state': wrong}}},
        f'{ph} with capability={wrong} must be rejected', INTENTIONALLY_ILLEGAL)
    add(f'semantic/resolved-{decision}-wrong-receipt', 'semantic',
        {'manifest': {**resolved,
                      'receiptClaims': [{**FROZEN['receiptClaims'][0], 'state': wrong}]}},
        f'{ph} with receipt={wrong} must be rejected -- receipt left claimed is a leak',
        INTENTIONALLY_ILLEGAL)
    other = 'abandon' if decision != 'abandon' else 'rollback'
    add(f'semantic/resolved-{decision}-decision-mismatch', 'semantic',
        {'manifest': {**resolved,
                      'resolution': {**resolved['resolution'], 'decision': other}}},
        'phase and recorded decision must agree', INTENTIONALLY_ILLEGAL)

# ---- pairing ---------------------------------------------------------------
add('pairing/correct', 'pairing', {'resolution': RESOLUTION, 'original': FROZEN},
    'a correct pair must be accepted')
for cid, mutate, why in [
    ('released-cap-invented', {'releasedCapId': 'cap-invented'},
     'the released capability must be the one the original actually holds'),
    ('released-receipts-empty', {'releasedReceiptIds': []},
     'releasing nothing leaks every frozen receipt'),
    ('released-receipts-subset', {'releasedReceiptIds': ['rc-1']},
     'releasing a subset leaks the rest forever'),
    ('released-receipts-ghost', {'releasedReceiptIds': ['rc-1', 'rc-2', 'rc-ghost']},
     'naming a receipt the original never held is fabrication'),
    ('kind-mismatch', {'resolvedKind': 'move'},
     'resolvedKind must match the frozen operation'),
    ('kind-unknown', {'resolvedKind': 'nonexistent-kind'},
     'resolvedKind must be a real kind'),
    ('target-mismatch', {'targetName': 'some-other-skill'},
     'resolving op A while reporting work on skill B must be impossible'),
    ('observed-hash-invented', {'observedConflictHash': 'f' * 64},
     'the operator must have seen the current diagnostics'),
    ('self-resolving', {'resolvesOpId': RESOLUTION['opId']},
     'a resolution may not resolve itself'),
]:
    add(f'pairing/{cid}', 'pairing',
        {'resolution': {**RESOLUTION, **mutate}, 'original': FROZEN}, why,
        INTENTIONALLY_ILLEGAL)

add('pairing/target-not-frozen', 'pairing',
    {'resolution': RESOLUTION,
     'original': {**FROZEN, 'phase': 'COMMITTED', 'conflict': None}},
    'only CONFLICT/PARTIAL hold frozen authorization', INTENTIONALLY_ILLEGAL)
add('pairing/diagnostics-changed', 'pairing',
    {'resolution': RESOLUTION,
     'original': {**FROZEN,
                  'conflict': {**T.CONFLICT_DIAG, 'message': 'something else entirely'}}},
    'the situation must not have moved since review', INTENTIONALLY_ILLEGAL)
add('pairing/nocap-null-released', 'pairing',
    {'resolution': T.NOCAP_RES, 'original': T.NOCAP_FROZEN},
    'a capability-less frozen op is resolved with releasedCapId=null')
add('pairing/nocap-invented-released', 'pairing',
    {'resolution': {**T.NOCAP_RES, 'releasedCapId': 'cap-invented'},
     'original': T.NOCAP_FROZEN},
    'but it may not name a capability that never existed', INTENTIONALLY_ILLEGAL)

# ---- cas -------------------------------------------------------------------
# rev21: the shape guarded ONLY by the RESOLVED-with-frozen-phase branch. With
# no decision, want_phase is None so the sibling elif never fires -- disabling
# that one branch made this shape silently accepted while every test stayed
# green. Pinning it here keeps the JS port honest too.
add('semantic/resolved-no-decision-still-frozen', 'semantic',
    {'manifest': {**FROZEN, 'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                                           'resolvedAt': T.LATER}}},
    'status=RESOLVED with no decision and phase=CONFLICT permanently freezes the operation: '
    'the CAS refuses every new resolution while authorization stays claimed',
    INTENTIONALLY_ILLEGAL)
add('semantic/resolved-no-decision-partial', 'semantic',
    {'manifest': {**FROZEN, 'phase': 'PARTIAL',
                  'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                                 'resolvedAt': T.LATER}}},
    'same permanent freeze via PARTIAL',
    INTENTIONALLY_ILLEGAL)

add('cas/unresolved-claim', 'cas', {'original': FROZEN, 'resolutionOpId': RES_OP},
    'UNRESOLVED lets a resolution claim it')
resolving = {**FROZEN, 'resolution': {'status': RESOLVING, 'resolutionOpId': RES_OP}}
add('cas/resolving-same-owner', 'cas', {'original': resolving, 'resolutionOpId': RES_OP},
    'the same resolution replaying gets its receipt back')
add('cas/resolving-other-owner', 'cas', {'original': resolving, 'resolutionOpId': 'op-other'},
    'a second resolution must be refused (409) -- this is the double-unfreeze guard')
# rev20: a RESOLVED operation must ALSO have moved to the matching phase and
# released its authorization. rev19 left these two fixtures at phase=CONFLICT
# with cap still 'claimed' -- a shape where the CAS refuses every new resolution
# while authorization stays frozen, i.e. rev17's leak resurrected, and the corpus
# was about to hand that shape to the JS port as a contract.
done = {**FROZEN, 'phase': 'RESOLVED_ROLLED_BACK', 'conflict': None,
        'capClaim': {**FROZEN['capClaim'], 'state': 'available'},
        'receiptClaims': [{**FROZEN['receiptClaims'][0], 'state': 'available'}],
        'resolution': {'status': RESOLVED, 'resolutionOpId': RES_OP,
                       'decision': 'rollback', 'resolvedAt': T.LATER}}
add('cas/resolved-other-owner', 'cas', {'original': done, 'resolutionOpId': 'op-other'},
    'already resolved by someone else -> 409')
add('cas/resolved-same-owner', 'cas', {'original': done, 'resolutionOpId': RES_OP},
    'the owner replaying after RESOLVED gets its receipt')
add('cas/unknown-status', 'cas',
    {'original': {**FROZEN, 'resolution': {'status': 'WAT'}}, 'resolutionOpId': RES_OP},
    'an unknown status must fail closed, not default to UNRESOLVED',
    INTENTIONALLY_ILLEGAL)

corpus = {
    'schemaVersion': 1,
    'generatedFrom': 'scripts/schema/build_conformance_corpus.py',
    'contract': ('Every case must produce an identical verdict in the Python contracts and in '
                 'the JS runtime port. A mismatch means the two implementations have drifted '
                 'and the JS side is NOT enforcing the plan.'),
    'layers': {
        'structure': 'ajv against op-manifest.schema.json',
        'semantic': 'JS port of semantic_validator',
        'pairing': 'JS port of validate_resolution_against_target',
        'cas': 'JS port of check_resolution_cas',
    },
    'caseCount': len(cases),
    'cases': cases,
}

if __name__ == '__main__':
    if _gate_failures:
        print('CORPUS GATE FAILED -- refusing to write a corpus that encodes illegal shapes:')
        for f in _gate_failures:
            print(f'  - {f}')
        sys.exit(1)
    OUT.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    by_layer = {}
    for c in cases:
        by_layer[c['layer']] = by_layer.get(c['layer'], 0) + 1
    print(f'wrote {OUT}')
    print(f'cases: {len(cases)}  ' + '  '.join(f'{k}={v}' for k, v in sorted(by_layer.items())))
    neg = sum(1 for c in cases if not c['expect'].get('valid', c['expect'].get('ok')))
    print(f'positive={len(cases) - neg}  negative={neg}')
    legal = sum(1 for c in cases if c['legality'] == LEGAL)
    print(f'must-be-legal={legal} (all passed schema+semantic)  '
          f'intentionally-illegal={len(cases) - legal}')
