"""Cross-manifest invariants: a resolution must be bound to the operation it claims to resolve.

semantic_validator.py sees ONE manifest at a time, so it can only check that a
resolution is internally coherent. That is not enough: rev17 accepted a
resolution whose releasedCapId, releasedReceiptIds, targetName and
observedConflictHash were all pure fiction, because nothing compared them
against the frozen operation.

This module is the THIRD co-equal construction contract, alongside
op-manifest.schema.json (structure) and semantic_validator.py (single-manifest
cross-field). It must be called INSIDE the operation claim, not only in offline
tests -- an offline-only check protects nobody at runtime.

Two jobs:
  validate_resolution_against_target(resolution, original)
      the resolution truly describes that frozen operation
  check_resolution_cas(original, resolution_op_id)
      only ONE resolution may ever own a given frozen operation
"""

import hashlib
import json

RESOLVABLE_PHASES = {'CONFLICT', 'PARTIAL'}

# Every kind the schema knows about. A resolution claiming some other kind is
# either a typo or an attempt to resolve something that does not exist.
KNOWN_KINDS = {
    'create-proposal', 'apply', 'direct', 'converge', 'move', 'rotation', 'resolution',
}

# Resolution lifecycle on the FROZEN manifest (not on the resolution itself).
UNRESOLVED = 'UNRESOLVED'
RESOLVING = 'RESOLVING'
RESOLVED = 'RESOLVED'


def canonical_conflict_hash(conflict):
    """Hash the diagnostics exactly as the resolution must have observed them.

    Canonical JSON (sorted keys, no incidental whitespace) so the same
    diagnostics always produce the same hash on any machine.
    """
    if conflict is None:
        return None
    payload = json.dumps(conflict, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _claimed_receipt_ids(manifest):
    return {r.get('receiptId') for r in (manifest.get('receiptClaims') or [])
            if r.get('state') == 'claimed'}


def validate_resolution_against_target(resolution, original):
    """Return a list of violations (empty == the pair is consistent)."""
    errs = []

    def bad(msg):
        errs.append(msg)

    if not isinstance(resolution, dict) or resolution.get('kind') != 'resolution':
        bad('validate_resolution_against_target expects a resolution manifest')
        return errs

    if original is None:
        bad(f"resolvesOpId={resolution.get('resolvesOpId')!r} names an operation that does not "
            'exist (a resolution may not invent its target)')
        return errs

    # 1. it must point at the operation we were handed
    if resolution.get('resolvesOpId') != original.get('opId'):
        bad(f"resolution.resolvesOpId={resolution.get('resolvesOpId')!r} != "
            f"original.opId={original.get('opId')!r}")

    # 2. only genuinely frozen operations may be resolved
    if original.get('phase') not in RESOLVABLE_PHASES:
        bad(f"original.phase={original.get('phase')!r} is not resolvable; only "
            f'{sorted(RESOLVABLE_PHASES)} hold frozen authorization')

    # 3. a resolution may not resolve another resolution (no chains, and the
    #    schema forbids a resolution ever being frozen anyway)
    if original.get('kind') == 'resolution':
        bad('cannot resolve a resolution (resolutions have no CONFLICT/PARTIAL terminal)')

    # 4. resolvedKind must be real AND match
    if resolution.get('resolvedKind') not in KNOWN_KINDS:
        bad(f"resolution.resolvedKind={resolution.get('resolvedKind')!r} is not a known kind "
            f'{sorted(KNOWN_KINDS)}')
    elif resolution.get('resolvedKind') != original.get('kind'):
        bad(f"resolution.resolvedKind={resolution.get('resolvedKind')!r} != "
            f"original.kind={original.get('kind')!r}")

    # 5. same target -- otherwise a resolution could unfreeze op A while
    #    reporting work on skill B.
    # rev18 short-circuited on `original.targetName is not None`, so resolving a
    # rotation (whose schema branch has NO targetName at all) accepted any skill
    # name and produced a misattributed audit trail.
    orig_target = original.get('targetName')
    res_target = resolution.get('targetName')
    if orig_target is None:
        # The frozen kind has no target of its own: the resolution must say so
        # too, using the kind name as an explicit, non-forgeable marker.
        expected = f'<no-target:{original.get("kind")}>'
        if res_target != expected:
            bad(f'original kind={original.get("kind")!r} has no targetName, so '
                f'resolution.targetName must be exactly {expected!r}, got {res_target!r} '
                '(otherwise any skill name would be accepted)')
    elif res_target != orig_target:
        bad(f'resolution.targetName={res_target!r} != original.targetName={orig_target!r}')

    # 6. the scene must not have moved since the operator looked at it
    expected_hash = canonical_conflict_hash(original.get('conflict'))
    if expected_hash is None:
        bad('original manifest is frozen but carries no conflict diagnostics to observe')
    elif resolution.get('observedConflictHash') != expected_hash:
        bad(f"observedConflictHash={str(resolution.get('observedConflictHash'))[:12]}... does not "
            f'match the current diagnostics ({expected_hash[:12]}...); the situation changed '
            'since the operator reviewed it, so the decision may no longer apply')

    # 7. it must release exactly the authorization the original is holding
    # 7a. releasedCapId must mirror the original EXACTLY, including the null case.
    # 7/14 schema branches can freeze without any capClaim (model-tool proposals,
    # autonomous direct, autonomous converge, tool/auto moves, rotation). rev18
    # required a non-null releasedCapId at COMPLETE while rule 7 required it to
    # equal the original's (absent) cap -> both directions rejected, so those
    # operations could never be unfrozen at all.
    orig_cap = original.get('capClaim')
    orig_cap_id = orig_cap.get('capId') if isinstance(orig_cap, dict) else None
    released_cap = resolution.get('releasedCapId')
    if orig_cap_id is None:
        if released_cap is not None:
            bad(f'original operation holds no capability, so releasedCapId must be null, '
                f'got {released_cap!r}')
    elif released_cap != orig_cap_id:
        bad(f'releasedCapId={released_cap!r} != the capability frozen on the '
            f'original operation ({orig_cap_id!r})')

    orig_receipts = _claimed_receipt_ids(original)
    released = set(resolution.get('releasedReceiptIds') or [])
    if released != orig_receipts:
        missing = sorted(orig_receipts - released)
        extra = sorted(released - orig_receipts)
        detail = []
        if missing:
            detail.append(f'still frozen: {missing}')
        if extra:
            detail.append(f'not held by the original: {extra}')
        bad('releasedReceiptIds must equal the original\'s claimed receipts exactly '
            f'({"; ".join(detail)}) -- releasing a subset leaks the rest forever')

    # 8. the resolution must not spend the very capability it is freeing
    res_cap = resolution.get('capClaim')
    if isinstance(res_cap, dict) and res_cap.get('capId') == resolution.get('releasedCapId'):
        bad('resolution must carry its own capability, not the frozen one it releases')

    return errs


def check_resolution_cas(original, resolution_op_id):
    """Guard against two resolutions owning the same frozen operation.

    Returns (ok, code, detail). Callers must treat ok=False as fatal for this
    attempt; 'retry' means the same resolution is replaying and should get the
    original receipt back.
    """
    state = (original.get('resolution') or {}) if isinstance(original, dict) else {}
    status = state.get('status', UNRESOLVED)
    owner = state.get('resolutionOpId')

    if status == UNRESOLVED:
        return True, 'claim', f'{resolution_op_id} may claim this operation'
    if status == RESOLVING:
        if owner == resolution_op_id:
            return True, 'retry', 'same resolution replaying; return the original receipt'
        return False, 'conflict', (f'operation is already being resolved by {owner!r}; '
                                   f'{resolution_op_id!r} must not proceed (409)')
    if status == RESOLVED:
        if owner == resolution_op_id:
            return True, 'retry', 'already resolved by this op; return the original receipt'
        return False, 'conflict', (f'operation was already resolved by {owner!r} with decision '
                                   f'{state.get("decision")!r} (409)')
    return False, 'invalid', f'unknown resolution status {status!r} (fail closed)'


RESOLVED_PHASE_BY_DECISION = {
    'roll-forward': 'RESOLVED_ROLLED_FORWARD',
    'rollback': 'RESOLVED_ROLLED_BACK',
    'abandon': 'RESOLVED_ABANDONED',
}


def resolved_phase_for(decision):
    """Which terminal the FROZEN operation must move to, per decision.

    rev18 had no such phase at all, so "the original enters a resolved terminal"
    was unimplementable.
    """
    return RESOLVED_PHASE_BY_DECISION.get(decision)


def authorization_after_resolution(decision):
    """Where the frozen authorization must end up, per decision.

    roll-forward means the mutation did land, so the authorization was genuinely
    spent. rollback/abandon mean it never landed, so it must go back to the pool.
    """
    return {
        'roll-forward': 'consumed',
        'rollback': 'available',
        'abandon': 'available',
    }.get(decision)
