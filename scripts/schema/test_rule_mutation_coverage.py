"""Mutation-test every coded rule: disable it, demand the suite turns red.

This automates what the reviewer did by hand. A coded rule that can be silently
deleted while all chains stay green is untested, no matter how many assertions
mention it. rev21 shipped with TERMINAL_AUTHZ_RECEIPT in exactly that state: the
only assertions varying receipt state lived on the BASE terminals, so for the
three RESOLVED_* terminals the rule was the sole trigger and nothing exercised
it.

Two outcomes are legitimate, and conflating them turns defence-in-depth into a
false alarm:

  KILLED     disabling the rule makes the suite fail -> the rule is tested
  REDUNDANT  the rule never fires alone; a sibling always fires with it, by
             design (two directions of the same predicate). Must be declared
             here with a reason, and the claim is VERIFIED by exhaustive search.

Anything else is a real gap and fails this script.

Run: python3 scripts/schema/test_rule_mutation_coverage.py
"""
import ast
import contextlib
import importlib.util
import io
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
VALIDATOR = HERE / 'semantic_validator.py'

# Chains that must turn red when a tested rule is disabled.
# verify_op_manifest_schema.py is deliberately EXCLUDED: its GATE 9 invokes this
# script, so including it here would recurse (and each mutation would re-run the
# whole suite). The two chains below already exercise every coded rule; verify's
# own semantic negatives are covered by its GATE 6.
CHAINS = ['test_resolution_pairing.py', 'test_conformance_corpus.py']

# Rules that provably never fire alone. Each needs a reason AND a verifier
# below, so the exemption cannot be used to hide an untested rule.
KNOWN_REDUNDANT = {
    'RESOLVED_PHASE_DECISION_MISMATCH':
        'rule 24 checks phase->decision, rule 25 checks decision->phase: two '
        'directions of one predicate, so RESOLVED_DECISION_MISMATCH always '
        'fires with it. Verified by exhaustive 3 phases x 3 decisions below.',
}


# The authoritative list. It is written down here on purpose: deriving it by
# regex from the validator source was actively dangerous -- one interrupted run
# left a mutated name in the file, the next scan treated that name as a NEW rule,
# and the mutations compounded 148 deep into the real source. A test that can
# corrupt the thing it tests is worse than no test.
CODED_RULES = [
    'RESOLVED_WITH_FROZEN_PHASE',
    'RESOLVED_PHASE_DECISION_MISMATCH',
    'RESOLVED_DECISION_MISMATCH',
    'ROLL_FORWARD_MISSING_RECEIPT',
    'TERMINAL_EVIDENCE_EXCLUSIVITY',
    'TERMINAL_AUTHZ_CAP',
    'TERMINAL_AUTHZ_RECEIPT',
]


def emitted_codes(src):
    """Every error code passed to bad(), found by walking the AST.

    A regex cannot do this. The previous line-oriented pattern required the
    comma before the code to sit on the same line as `bad(`; every real rule in
    this validator splits its message across lines and puts the comma on a
    continuation line, so the pattern matched 0 of 7 rules and `emitted` was
    always empty -- making the undeclared-code guard vacuously true. A new rule
    written in the house style passed completely silently.

    The AST does not care about formatting: take the last positional argument of
    any bad(...) call and keep it if it is an UPPER_SNAKE string literal.
    """
    codes = set()
    for node in ast.walk(ast.parse(src)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == 'bad' and node.args):
            continue
        last = node.args[-1]
        if (isinstance(last, ast.Constant) and isinstance(last.value, str)
                and re.fullmatch(r'[A-Z][A-Z_]{4,}', last.value)):
            codes.add(last.value)
    return codes


def coded_rules():
    """Return the declared rules, asserting the validator still emits each one.

    If a code is renamed or dropped, this fails loudly instead of silently
    testing fewer rules than it claims.
    """
    src = VALIDATOR.read_text(encoding='utf-8')
    if '__MUTATED' in src:
        raise SystemExit('semantic_validator.py contains __MUTATED: a previous run was '
                         'interrupted mid-mutation. Restore it before continuing.')
    missing = [c for c in CODED_RULES if f"'{c}'" not in src]
    if missing:
        raise SystemExit(f'declared rules not present in the validator: {missing}')
    emitted = emitted_codes(src)
    undeclared = emitted - set(CODED_RULES)
    if not emitted:
        raise SystemExit('found no error codes at all in the validator -- the extractor '
                         'is broken, not the validator (a silently empty result would '
                         'make this guard vacuously pass)')
    if undeclared:
        raise SystemExit(f'validator emits codes not declared here: {sorted(undeclared)} '
                         '-- add them to CODED_RULES so they get mutation-tested')
    return list(CODED_RULES)


def run_chain(script):
    r = subprocess.run([sys.executable, str(HERE / script)], capture_output=True, text=True)
    return r.returncode


def mutate_and_run(code):
    """Replace the code string so the rule's message no longer carries it.

    This simulates the rule being silently removed from the perspective of every
    assertion that matches on the code, without changing control flow.
    """
    original = VALIDATOR.read_text(encoding='utf-8')
    backup = tempfile.mktemp(suffix='.py')
    shutil.copy(VALIDATOR, backup)
    try:
        # Whole-token replacement so a code that is a prefix of another cannot be
        # hit twice, and so a partially-mutated name can never be re-mutated.
        mutated = re.sub(rf"'{code}'", f"'{code}__MUTATED'", original)
        if mutated == original:
            return None, 'code string not found'
        VALIDATOR.write_text(mutated, encoding='utf-8')
        for cache in HERE.glob('__pycache__'):
            shutil.rmtree(cache, ignore_errors=True)
        results = {c: run_chain(c) for c in CHAINS}
        return results, ''
    finally:
        shutil.copy(backup, VALIDATOR)
        Path(backup).unlink(missing_ok=True)
        for cache in HERE.glob('__pycache__'):
            shutil.rmtree(cache, ignore_errors=True)
        # Never leave the validator mutated, even if the copy above misfires.
        if '__MUTATED' in VALIDATOR.read_text(encoding='utf-8'):
            raise SystemExit(f'FATAL: restore failed after mutating {code}; '
                             'semantic_validator.py still contains __MUTATED')


def verify_redundancy_claim():
    """Prove RESOLVED_PHASE_DECISION_MISMATCH never fires alone.

    An exemption asserted but never checked is just a comment. This walks every
    phase x decision pair and confirms a sibling code is always present.
    """
    sys.path.insert(0, str(HERE))
    for cache in HERE.glob('__pycache__'):
        shutil.rmtree(cache, ignore_errors=True)
    from semantic_validator import validate_semantics

    # Load fixtures via importlib so module-level __file__ exists; swallow the
    # test's own exit and output.
    spec = importlib.util.spec_from_file_location('trp_fx', HERE / 'test_resolution_pairing.py')
    mod = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            spec.loader.exec_module(mod)
        except SystemExit:
            pass
    frozen = mod.FROZEN
    later = mod.LATER

    phases = ['RESOLVED_ROLLED_FORWARD', 'RESOLVED_ROLLED_BACK', 'RESOLVED_ABANDONED']
    decisions = ['roll-forward', 'rollback', 'abandon']
    alone = []
    for ph in phases:
        for dec in decisions:
            m = {**frozen, 'phase': ph, 'conflict': None,
                 'resolution': {'status': 'RESOLVED', 'resolutionOpId': 'op-r',
                                'decision': dec, 'resolvedAt': later}}
            matches = (re.match(r'\[([A-Z_]+)\]', e) for e in validate_semantics(m))
            codes = {mt.group(1) for mt in matches if mt}
            if codes == {'RESOLVED_PHASE_DECISION_MISMATCH'}:
                alone.append((ph, dec))
    return alone


def selftest_signature():
    """bad() must stay positional-only, so code= cannot bypass the extractor.

    The extractor reads the last positional argument. A keyword call fires at
    runtime but is invisible to it. Rather than teach the extractor every call
    style, the signature forbids the style -- but only as long as the `/` is
    still there, so assert it.
    """
    src = VALIDATOR.read_text(encoding='utf-8')
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.FunctionDef) and node.name == 'bad':
            # Assert `code` is IN the positional-only group, not merely that the
            # group is non-empty. `def bad(msg, /, code=None)` has a non-empty
            # posonlyargs and passed the earlier check, yet code= is legal again.
            # The old message even printed "(1 args)" -- the number was right
            # there, but nothing asserted on it.
            posonly = [a.arg for a in node.args.posonlyargs]
            if 'code' not in posonly:
                return (False, f"'code' is not positional-only (posonlyargs={posonly}): "
                               "a call like bad(msg, code='X') is legal again and would "
                               'fire at runtime while staying invisible to this gate')
            return (True, f'code is positional-only (posonlyargs={posonly}), '
                          'so code= is a TypeError')
    return (False, 'no bad() definition found in the validator')


def selftest_extractor():
    """The guard must actually fire when a rule is undeclared.

    Without this, a broken extractor makes the guard vacuously pass and nobody
    notices: that is exactly how the regex version shipped returning 0 of 7.
    Dropping a real rule from CODED_RULES must be detected.
    """
    src = VALIDATOR.read_text(encoding='utf-8')
    emitted = emitted_codes(src)
    if len(emitted) != len(CODED_RULES):
        return (False, f'extractor found {len(emitted)} codes but {len(CODED_RULES)} '
                       f'are declared: {sorted(emitted ^ set(CODED_RULES))}')
    # Simulate forgetting to declare one and confirm it would be reported.
    for dropped in CODED_RULES:
        if not (emitted - (set(CODED_RULES) - {dropped})):
            return (False, f'dropping {dropped} from CODED_RULES would NOT be reported')
    return (True, f'{len(emitted)} codes extracted; dropping any one is detected')


def main():
    print('=== self-test: the undeclared-code guard is not vacuous ===')
    failed = False
    for fn in (selftest_signature, selftest_extractor):
        ok, detail = fn()
        print(f'{"PASS" if ok else "FAIL"}  {detail}')
        failed = failed or not ok
    if failed:
        return 1

    rules = coded_rules()
    print(f'=== mutation-testing {len(rules)} coded rules across {len(CHAINS)} chains ===')
    killed, redundant, gaps = [], [], []

    for code in rules:
        results, err = mutate_and_run(code)
        if results is None:
            gaps.append((code, err))
            print(f'FAIL  {code}: {err}')
            continue
        red = [c for c, rc in results.items() if rc != 0]
        if red:
            killed.append(code)
            print(f'KILLED     {code:34} red in: {", ".join(sorted(red))}')
        elif code in KNOWN_REDUNDANT:
            redundant.append(code)
            print(f'REDUNDANT  {code:34} (declared, verified below)')
        else:
            gaps.append((code, 'no chain turned red -- rule can be deleted silently'))
            print(f'FAIL       {code:34} no chain turned red')

    print('\n=== verifying the redundancy exemption is real ===')
    alone = verify_redundancy_claim()
    if alone:
        print(f'FAIL  RESOLVED_PHASE_DECISION_MISMATCH fires ALONE for {alone} '
              '-> it is not redundant, it is untested')
        gaps.append(('RESOLVED_PHASE_DECISION_MISMATCH', f'fires alone for {alone}'))
    else:
        print('PASS  never fires alone across 3 phases x 3 decisions '
              '(sibling always co-fires) -> exemption is genuine')

    print(f'\n{"=" * 66}')
    print(f'killed={len(killed)}  declared-redundant={len(redundant)}  gaps={len(gaps)}')
    if gaps:
        print('\nGAPS (a rule here can be removed with every test still green):')
        for code, why in gaps:
            print(f'  - {code}: {why}')
        return 1
    print('every coded rule is either killed by the suite or provably redundant')
    return 0


if __name__ == '__main__':
    sys.exit(main())
