"""Replay the conformance corpus against the Python contracts.

Two jobs:
  1. prove the corpus is not stale -- every recorded verdict must still match
     what the Python implementation produces today;
  2. give the JS port a spec it can run: same file, same expectations. When the
     JS runner passes this corpus, the two languages provably agree.

A corpus that is generated and never replayed is just a snapshot of a bug.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from jsonschema import Draft202012Validator  # noqa: E402

from resolution_validator import check_resolution_cas, validate_resolution_against_target  # noqa: E402
from semantic_validator import validate_semantics  # noqa: E402

SCHEMA = json.loads((HERE / 'op-manifest.schema.json').read_text(encoding='utf-8'))
V = Draft202012Validator(SCHEMA, format_checker=Draft202012Validator.FORMAT_CHECKER)
CORPUS = json.loads((HERE / 'conformance-corpus.json').read_text(encoding='utf-8'))

failures = []


def actual(case):
    layer, payload = case['layer'], case['input']
    if layer == 'structure':
        return {'valid': V.is_valid(payload['manifest'])}
    if layer == 'semantic':
        errs = validate_semantics(payload['manifest'])
        return {'valid': not errs, 'errorCount': len(errs)}
    if layer == 'pairing':
        errs = validate_resolution_against_target(payload['resolution'], payload['original'])
        return {'valid': not errs, 'errorCount': len(errs)}
    if layer == 'cas':
        ok, code, _ = check_resolution_cas(payload['original'], payload['resolutionOpId'])
        return {'ok': ok, 'code': code}
    raise AssertionError(f'unknown layer {layer}')


# ---- GATE 0: fixtures marked must-be-legal have to still BE legal ----------
# Generation-time gating is not enough: the corpus is a checked-in file, and the
# implementation keeps moving. If a rule tightens later, a fixture that was legal
# when generated can silently become an illegal shape that the JS port copies.
print('=== GATE 0: must-be-legal fixtures are still schema+semantic clean ===')
_g = 0
for case in CORPUS['cases']:
    if case.get('legality') != 'must-be-legal':
        continue
    for key in ('manifest', 'original', 'resolution'):
        obj = case['input'].get(key)
        if not isinstance(obj, dict):
            continue
        if not V.is_valid(obj):
            failures.append((case['id'], 'schema-valid', 'invalid',
                             f'{key} is not schema-valid'))
            _g += 1
        errs = validate_semantics(obj)
        if errs:
            failures.append((case['id'], 'semantics clean', errs[0][:90],
                             f'{key} violates semantics'))
            _g += 1
print(f"{'PASS' if not _g else 'FAIL'}  "
      f"{sum(1 for c in CORPUS['cases'] if c.get('legality') == 'must-be-legal')} "
      f'must-be-legal fixtures checked, {_g} problems')

# Every case must declare its legality, or this gate can be bypassed by omission.
_undeclared = [c['id'] for c in CORPUS['cases'] if 'legality' not in c]
if _undeclared:
    failures.append(('corpus/undeclared-legality', 'every case declares legality',
                     str(_undeclared[:3]),
                     'an undeclared case skips GATE 0 silently'))

print(f"\n=== replaying {CORPUS['caseCount']} corpus cases against the Python contracts ===")
by_layer = {}
for case in CORPUS['cases']:
    got, want = actual(case), case['expect']
    ok = got == want
    by_layer.setdefault(case['layer'], [0, 0])
    by_layer[case['layer']][0 if ok else 1] += 1
    if not ok:
        failures.append((case['id'], want, got, case['why']))

for layer, (passed, failed) in sorted(by_layer.items()):
    status = 'PASS' if not failed else 'FAIL'
    print(f'{status}  {layer:10} {passed} matched, {failed} mismatched')

# The corpus must actually discriminate: an all-positive corpus proves nothing.
negatives = [c for c in CORPUS['cases']
             if not c['expect'].get('valid', c['expect'].get('ok'))]
print(f"\nnegative cases: {len(negatives)}/{CORPUS['caseCount']}")
if len(negatives) < len(CORPUS['cases']) // 3:
    failures.append(('corpus/too-few-negatives', '>=1/3 negative',
                     f'{len(negatives)}', 'a corpus without negatives cannot catch drift'))

# Every layer must be represented, or the JS port could skip one silently.
missing = set(CORPUS['layers']) - set(by_layer)
if missing:
    failures.append(('corpus/missing-layers', 'all four layers', str(sorted(missing)),
                     'an unexercised layer is an unenforced contract'))

print(f'\n{"=" * 62}')
if failures:
    print(f'TOTAL: {len(CORPUS["cases"]) - len(failures)}/{CORPUS["caseCount"]} matched, '
          f'{len(failures)} MISMATCHED')
    for cid, want, got, why in failures:
        print(f'  - {cid}\n      want={want} got={got}\n      why: {why}')
    sys.exit(1)
print(f'TOTAL: {CORPUS["caseCount"]}/{CORPUS["caseCount"]} matched, 0 mismatched')
