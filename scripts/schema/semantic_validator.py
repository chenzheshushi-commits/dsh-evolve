"""Cross-field invariants for dsh-evolve op manifests (rev14).

JSON Schema cannot express "this nested opId must equal the outer opId" or
"reservationRevisionAfter must exceed Before". Those invariants are NOT optional
polish: a marker whose opId belongs to a different op would let recovery adopt
another operation's commit as its own. This module is therefore a CO-EQUAL
construction contract with op-manifest.schema.json, and callers must run both.

Usage:
    errs = validate_semantics(manifest)   # [] means clean
"""

from datetime import datetime

# Terminals that end an operation outright.
BASE_TERMINALS = {'COMPLETE', 'ABORTED', 'FAILED', 'CONFLICT', 'PARTIAL'}

# Terminals reached by an operator resolution. These ARE terminal: forgetting
# them here made rule 13 reject roll-forward's durable receipt (whose whole
# purpose is idempotent replay) and made rule 15's exclusivity check skip them
# entirely. A new enum value must be added to EVERY set that consumes it.
RESOLVED_TERMINALS = {'RESOLVED_ROLLED_FORWARD', 'RESOLVED_ROLLED_BACK', 'RESOLVED_ABANDONED'}

TERMINALS = BASE_TERMINALS | RESOLVED_TERMINALS


def validate_semantics(m):
    """Return a list of human-readable invariant violations (empty == valid)."""
    errs = []
    op_id = m.get('opId')
    kind = m.get('kind')
    phase = m.get('phase')
    source = m.get('source')

    def bad(msg, code=None, /):
        """Record a violation, optionally with a stable code.

        Positional-only on purpose. The AST extractor in
        test_rule_mutation_coverage.py reads the last POSITIONAL argument; a
        keyword call like bad(msg, code='X') would fire at runtime yet stay
        invisible to the mutation gate. Making the signature positional-only
        deletes that path at the language level -- code= is now a TypeError --
        instead of asking the extractor to chase every future call style.

        Tests must be able to assert WHICH rule fired, not merely that something
        fired. Matching on prose is brittle; matching on a code is not. Without
        this, sibling rules cover for each other: disabling one guard still left
        every test green because an adjacent elif returned a different error.
        """
        errs.append(f'[{code}] {msg}' if code else msg)

    # --- 1. every nested opId must belong to THIS op ---
    marker = m.get('marker')
    if isinstance(marker, dict) and marker.get('opId') != op_id:
        bad(f"marker.opId={marker.get('opId')!r} != manifest.opId={op_id!r} "
            "(a foreign marker would let recovery adopt another op's commit)")

    cap = m.get('capClaim')
    if isinstance(cap, dict) and cap.get('claimedByOpId') != op_id:
        bad(f"capClaim.claimedByOpId={cap.get('claimedByOpId')!r} != manifest.opId={op_id!r}")

    owner = m.get('reservationOwner')
    if isinstance(owner, dict):
        if owner.get('opId') != op_id:
            bad(f"reservationOwner.opId={owner.get('opId')!r} != manifest.opId={op_id!r}")
        if m.get('proposalId') and owner.get('proposalId') != m['proposalId']:
            bad(f"reservationOwner.proposalId={owner.get('proposalId')!r} != manifest.proposalId={m['proposalId']!r}")

    lock = m.get('namespaceLockOwner')
    if isinstance(lock, dict) and lock.get('opId') != op_id:
        bad(f"namespaceLockOwner.opId={lock.get('opId')!r} != manifest.opId={op_id!r}")

    res = m.get('result')
    if isinstance(res, dict):
        rc = res.get('receipt')
        if isinstance(rc, dict):
            if rc.get('opId') != op_id:
                bad(f"result.receipt.opId={rc.get('opId')!r} != manifest.opId={op_id!r}")
            if rc.get('kind') != kind:
                bad(f"result.receipt.kind={rc.get('kind')!r} != manifest.kind={kind!r}")

    # --- 2. marker protocol must match the manifest protocol ---
    if isinstance(marker, dict) and m.get('protocol') and marker.get('protocol') != m['protocol']:
        bad(f"marker.protocol={marker.get('protocol')!r} != manifest.protocol={m['protocol']!r}")

    # --- 3. marker action must match the manifest action ---
    if isinstance(marker, dict) and m.get('action') and marker.get('action') != m['action']:
        bad(f"marker.action={marker.get('action')!r} != manifest.action={m['action']!r}")

    # --- 4. protocol D marker identity must match the move it commits ---
    if kind == 'move' and isinstance(marker, dict):
        for f in ('logicalSkillName', 'archiveId'):
            if f in m and marker.get(f) != m[f]:
                bad(f"marker.{f}={marker.get(f)!r} != manifest.{f}={m[f]!r}")

    # --- 5. reservation revision must advance strictly when this op wrote it ---
    b, a = m.get('reservationRevisionBefore'), m.get('reservationRevisionAfter')
    if isinstance(b, int) and isinstance(a, int):
        wrote = kind == 'create-proposal' or (kind == 'direct' and m.get('action') == 'create')
        if wrote and a <= b:
            bad(f"reservationRevisionAfter={a} must be > Before={b} when this op writes the sidecar")
        elif a < b:
            bad(f"reservationRevisionAfter={a} must never be < Before={b}")

    if kind == 'rotation':
        rb, ra = m.get('ownerRevisionBefore'), m.get('ownerRevisionAfter')
        if isinstance(rb, int) and isinstance(ra, int) and ra <= rb:
            bad(f"ownerRevisionAfter={ra} must be > Before={rb}")

    # --- 6. protocol B must publish the marker it claims to publish ---
    if m.get('protocol') == 'B' and isinstance(marker, dict):
        if marker.get('lastCommittedOpId') != m.get('lastCommittedOpId'):
            bad("marker.lastCommittedOpId != manifest.lastCommittedOpId "
                "(protocol B publishes both in one rename; they cannot disagree)")
        if marker.get('lastCommittedOpId') != op_id:
            bad(f"protocol B marker.lastCommittedOpId must equal this opId {op_id!r}")
        for f in ('expectedAfterContentHash', 'expectedAfterStateHash'):
            if marker.get(f) != m.get(f):
                bad(f"marker.{f} != manifest.{f}")

    # --- 7. converge: one usage receipt per source, and target must not be a source ---
    if kind == 'converge':
        sources = [r for r in (m.get('resources') or []) if r.get('role') == 'source']
        receipts = m.get('receiptClaims') or []
        if len(receipts) < len(sources):
            bad(f"converge needs >= 1 usage receipt per source: {len(sources)} sources "
                f"but only {len(receipts)} receipt(s)")
        names = [r.get('name') for r in sources]
        if len(set(names)) != len(names):
            bad(f"converge sources contain duplicates: {names}")
        tgt = (m.get('target') or {}).get('name')
        if tgt in names:
            bad(f"converge target {tgt!r} also appears as a source")
        skills = {r.get('skillName') for r in receipts}
        missing = [n for n in names if n not in skills]
        if missing:
            bad(f"converge sources without a matching usage receipt: {missing}")

    # --- 8. autonomous / auto paths must never carry a Web capability ---
    if source in ('autonomous-tool', 'auto', 'model-tool') and m.get('capClaim') is not None:
        bad(f"source={source!r} must not carry capClaim (no Web capability exists on this path)")

    # --- 9. protocol B refine/fold requires a usage receipt naming the target ---
    if m.get('protocol') == 'B':
        names = {r.get('skillName') for r in (m.get('receiptClaims') or [])}
        if m.get('targetName') and m['targetName'] not in names:
            bad(f"protocol B needs a usage receipt for {m['targetName']!r}; got {sorted(names)}")

    # --- 10. terminal-phase authorization matrix.
    # A capability or receipt left in the wrong state after a terminal phase is a
    # real security hole: 'consumed' on a failed op means the authorization was
    # spent without the mutation landing, and it can never be reused or audited.
    # rev15 only constrained COMPLETE plus one ABORTED case; the rest passed.
    TERMINAL_AUTHZ = {
        # phase:      (allowed cap states,        allowed receipt states)
        'COMPLETE': ({'consumed'}, {'consumed'}),
        'ABORTED': ({'available'}, {'available'}),
        'FAILED': ({'available'}, {'available'}),
        # CONFLICT/PARTIAL need a human: authorization stays claimed so the
        # operator can resume, but must never be silently consumed.
        'CONFLICT': ({'claimed'}, {'claimed'}),
        'PARTIAL': ({'claimed'}, {'claimed'}),
        # After a resolution unfreezes the operation the authorization must have
        # MOVED. roll-forward means the mutation landed, so it was genuinely
        # spent; rollback/abandon mean it never landed, so it returns to the pool.
        # rev18 pinned CONFLICT/PARTIAL to 'claimed' with no further phase, so
        # these destinations were unreachable.
        'RESOLVED_ROLLED_FORWARD': ({'consumed'}, {'consumed'}),
        'RESOLVED_ROLLED_BACK': ({'available'}, {'available'}),
        'RESOLVED_ABANDONED': ({'available'}, {'available'}),
    }
    if phase in TERMINAL_AUTHZ:
        cap_ok, rec_ok = TERMINAL_AUTHZ[phase]
        if isinstance(cap, dict) and cap.get('state') not in cap_ok:
            bad(f"phase={phase} requires capClaim.state in {sorted(cap_ok)}, "
                f"got {cap.get('state')!r}", 'TERMINAL_AUTHZ_CAP')
        for r in (m.get('receiptClaims') or []):
            if r.get('state') not in rec_ok:
                bad(f"phase={phase} requires receipt {r.get('receiptId')!r} state in "
                    f"{sorted(rec_ok)}, got {r.get('state')!r}", 'TERMINAL_AUTHZ_RECEIPT')

    # --- 11. stamp progress must not overlap ---
    sp = m.get('stampProgress')
    if isinstance(sp, dict):
        both = set(sp.get('done') or []) & set(sp.get('pending') or [])
        if both:
            bad(f"stampProgress lists the same id as done and pending: {sorted(both)}")

    # --- 12. timestamps must not go backwards.
    # RFC3339 permits different UTC offsets, so string ordering is NOT time
    # ordering: '2026-09-15T11:00:00+08:00' sorts after '2026-09-15T12:00:00Z'
    # while actually being 9 hours earlier. Parse before comparing.
    ca, ua = m.get('createdAt'), m.get('updatedAt')
    if isinstance(ca, str) and isinstance(ua, str):
        try:
            ca_dt = datetime.fromisoformat(ca.replace('Z', '+00:00'))
            ua_dt = datetime.fromisoformat(ua.replace('Z', '+00:00'))
            if ca_dt.tzinfo is None or ua_dt.tzinfo is None:
                bad('createdAt/updatedAt must carry a UTC offset (RFC3339)')
            elif ua_dt < ca_dt:
                bad(f"updatedAt={ua} precedes createdAt={ca} (compared as absolute time)")
        except ValueError:
            bad(f'createdAt/updatedAt must be RFC3339: got {ca!r} / {ua!r}')

    # --- 13. non-terminal phases must not carry terminal evidence ---
    if phase not in TERMINALS:
        if m.get('result') is not None:
            bad(f"phase={phase!r} is not terminal but a durable result is present")
        if m.get('error') is not None:
            bad(f"phase={phase!r} is not terminal but a durable error is present")

    # --- 14. tree hashes must MATCH: treeHash permanently excludes the commit
    # marker (plan section 0L.2), so a pure move cannot change the tree hash.
    # rev14 had this inverted and would have rejected every legal archive,
    # restore and autoArchive manifest the plan produces.
    if kind == 'move' and m.get('beforeTreeHash') and m.get('committedTreeHash'):
        if m['beforeTreeHash'] != m['committedTreeHash']:
            bad(f"beforeTreeHash={m['beforeTreeHash'][:8]}... != "
                f"committedTreeHash={m['committedTreeHash'][:8]}...; treeHash excludes "
                ".evolve-op-commit.json, so a move must not change it (plan 0L.2). "
                "A mismatch means the tree content itself changed during the move")


    # --- 15. terminal phases are mutually exclusive in their evidence.
    # rev14 only checked presence, so PARTIAL could carry result+error+conflict
    # at once and FAILED could carry both error and conflict.
    present = {k for k in ('result', 'error', 'conflict') if m.get(k) is not None}
    allowed = {'COMPLETE': {'result'}, 'FAILED': {'error'},
               'CONFLICT': {'conflict'}, 'PARTIAL': {'conflict'}, 'ABORTED': set(),
        # roll-forward means the mutation DID land, so a durable receipt is
        # required for idempotent replay. The other two never landed, so they
        # must carry nothing.
        'RESOLVED_ROLLED_FORWARD': {'result'},
        'RESOLVED_ROLLED_BACK': set(),
        'RESOLVED_ABANDONED': set()}
    if phase in allowed:
        extra_fields = present - allowed[phase]
        if extra_fields:
            bad(f"phase={phase} must carry only {sorted(allowed[phase]) or 'none'}; "
                f"also found {sorted(extra_fields)}", 'TERMINAL_EVIDENCE_EXCLUSIVITY')

    # --- 16. the durable receipt must describe THIS manifest's target, not another.
    if isinstance(res, dict):
        rc = res.get('receipt')
        if isinstance(rc, dict):
            if m.get('targetName') and rc.get('targetName') != m['targetName']:
                bad(f"result.receipt.targetName={rc.get('targetName')!r} != "
                    f"manifest.targetName={m['targetName']!r}")
            if m.get('finalPath') and rc.get('finalPath') not in (None, m['finalPath']):
                bad(f"result.receipt.finalPath={rc.get('finalPath')!r} != "
                    f"manifest.finalPath={m['finalPath']!r}")
            exp = m.get('expectedAfterContentHash')
            if exp and rc.get('afterContentHash') not in (None, exp):
                bad("result.receipt.afterContentHash != manifest.expectedAfterContentHash")
            if m.get('archiveId') and rc.get('archiveId') not in (None, m['archiveId']):
                bad(f"result.receipt.archiveId={rc.get('archiveId')!r} != "
                    f"manifest.archiveId={m['archiveId']!r}")

    # --- 17. protocol A/C markers must name the action their protocol implies.
    PROTOCOL_MARKER_ACTIONS = {'A': {'create', 'converge'}, 'C': {'rollback'}}
    if isinstance(marker, dict):
        want = PROTOCOL_MARKER_ACTIONS.get(m.get('protocol'))
        if want and marker.get('action') not in want:
            bad(f"protocol {m.get('protocol')} marker.action must be one of "
                f"{sorted(want)}, got {marker.get('action')!r}")

    # --- 18. a capability may only be spent on the action it was minted for.
    PURPOSE_BY_OP = {
        ('apply', 'A'): {'proposal-apply'}, ('apply', 'B'): {'proposal-apply'},
        ('apply', 'C'): {'proposal-apply', 'skill-rollback'},
        ('converge', None): {'proposal-apply', 'skill-converge'},
        # A rollback proposal is minted before any proposalId exists, so it
        # cannot reuse the proposal-apply digest -- it has its own purpose.
        ('create-proposal', None): {'rollback-proposal-create'},
        ('resolution', None): {'operation-resolve'},
    }
    if isinstance(cap, dict):
        if kind == 'move':
            want = {'archive': {'skill-archive'}, 'restore': {'skill-restore'}}.get(m.get('action'))
        else:
            want = PURPOSE_BY_OP.get((kind, m.get('protocol'))) or PURPOSE_BY_OP.get((kind, None))
        if want and cap.get('purpose') not in want:
            bad(f"capClaim.purpose={cap.get('purpose')!r} is not valid for "
                f"kind={kind!r} action={m.get('action')!r}; expected one of {sorted(want)}")

    # --- 19. converge shape: exactly one target, at least two sources, roles correct.
    if kind == 'converge':
        rs = m.get('resources') or []
        targets = [r for r in rs if r.get('role') == 'target']
        srcs = [r for r in rs if r.get('role') == 'source']
        if targets:
            bad(f"converge resources[] must contain sources only; found "
                f"{len(targets)} entry with role='target' (the target lives in .target)")
        if len(srcs) < 2:
            bad(f"converge needs >= 2 sources, got {len(srcs)}")
        tgt_obj = m.get('target')
        if isinstance(tgt_obj, dict):
            if tgt_obj.get('role') != 'target':
                bad(f"manifest.target.role must be 'target', got {tgt_obj.get('role')!r}")
            if m.get('targetName') and tgt_obj.get('name') != m['targetName']:
                bad(f"manifest.target.name={tgt_obj.get('name')!r} != targetName={m['targetName']!r}")

    # --- 20. receipt and call identifiers must be unique within one manifest.
    rcs = m.get('receiptClaims') or []
    for field in ('receiptId', 'callId'):
        vals = [r.get(field) for r in rcs if r.get(field) is not None]
        if len(set(vals)) != len(vals):
            dupe = sorted({v for v in vals if vals.count(v) > 1})
            bad(f"receiptClaims contain duplicate {field}: {dupe}")

    # --- 21. rotation cannot verify an asset it never scanned.
    if kind == 'rotation':
        scanned = set(m.get('scannedAssets') or [])
        verified = set(m.get('verifiedAssets') or [])
        stray = verified - scanned
        if stray:
            bad(f"verifiedAssets not present in scannedAssets: {sorted(stray)}")


    # --- 22. resolution is the unlock path out of CONFLICT/PARTIAL: it must
    # actually release what the frozen operation was holding, and it must not
    # resolve itself.
    if kind == 'resolution':
        if m.get('resolvesOpId') == op_id:
            bad('resolution.resolvesOpId must not be this manifest\'s own opId')
        if m.get('resolvedKind') == 'resolution':
            bad('a resolution cannot resolve another resolution (no chains)')
        decision = m.get('decision')
        # roll-forward means the mutation is being completed -> the original
        # authorization is spent. rollback/abandon means it never landed -> the
        # authorization must return to the pool.
        # releasedCapId may legitimately be null: 7 of the 14 branches can freeze
        # without ever holding a capability (autonomous/auto/tool paths). Whether
        # it must be set is decided by the FROZEN operation, which only the
        # cross-manifest validator can see -- so do not demand it here.
        if phase == 'COMPLETE' and 'releasedCapId' not in m:
            bad('a COMPLETE resolution must record releasedCapId (null is allowed when the '
                'frozen operation held no capability, but the field must be present)')
        if isinstance(cap, dict) and m.get('releasedCapId') == cap.get('capId'):
            bad('resolution must use its OWN capability, not the frozen one it releases '
                f'({cap.get("capId")!r})')

    # --- 23. only a resolution may name a frozen operation.
    if kind != 'resolution' and m.get('resolvesOpId') is not None:
        bad(f'kind={kind!r} must not carry resolvesOpId (only resolution may)')


    # --- 24. a resolved terminal must record who resolved it, with what, and
    # the phase must match the decision. Otherwise "resolved" is unauditable.
    RESOLVED_PHASES = {
        'RESOLVED_ROLLED_FORWARD': 'roll-forward',
        'RESOLVED_ROLLED_BACK': 'rollback',
        'RESOLVED_ABANDONED': 'abandon',
    }
    if phase in RESOLVED_PHASES:
        st = m.get('resolution')
        if not isinstance(st, dict):
            bad(f'phase={phase} requires a resolution state object')
        else:
            if st.get('status') != 'RESOLVED':
                bad(f"phase={phase} requires resolution.status='RESOLVED', "
                    f"got {st.get('status')!r}")
            if not st.get('resolutionOpId'):
                bad(f'phase={phase} requires resolution.resolutionOpId (who resolved it)')
            want = RESOLVED_PHASES[phase]
            if st.get('decision') != want:
                bad(f"phase={phase} requires resolution.decision={want!r}, "
                    f"got {st.get('decision')!r}", 'RESOLVED_DECISION_MISMATCH')
            if not st.get('resolvedAt'):
                bad(f'phase={phase} requires resolution.resolvedAt')
        if phase == 'RESOLVED_ROLLED_FORWARD' and m.get('result') is None:
            bad('RESOLVED_ROLLED_FORWARD means the mutation landed, so a durable result is '
                'required for idempotent replay', 'ROLL_FORWARD_MISSING_RECEIPT')

    # --- 25. CAS state must be internally consistent.
    st = m.get('resolution')
    if isinstance(st, dict):
        status = st.get('status')
        if status == 'UNRESOLVED' and st.get('resolutionOpId'):
            bad('resolution.status=UNRESOLVED must not name a resolutionOpId')
        if status in ('RESOLVING', 'RESOLVED') and not st.get('resolutionOpId'):
            bad(f'resolution.status={status} requires resolutionOpId')
        if status != 'RESOLVED' and st.get('decision'):
            bad(f'resolution.decision is only meaningful once RESOLVED (status={status})')
        if status == 'RESOLVING' and phase in RESOLVED_PHASES:
            bad(f'phase={phase} contradicts resolution.status=RESOLVING')
        # The hole that let rev17's leak come back: status=RESOLVED while the
        # phase is still CONFLICT/PARTIAL. The CAS then refuses every new
        # resolution (409) while authorization stays frozen at 'claimed' -> the
        # operation can never be unfrozen by anyone, which is exactly what the
        # resolution branch exists to prevent.
        if status == 'RESOLVED':
            want_phase = {'roll-forward': 'RESOLVED_ROLLED_FORWARD',
                          'rollback': 'RESOLVED_ROLLED_BACK',
                          'abandon': 'RESOLVED_ABANDONED'}.get(st.get('decision'))
            if phase in ('CONFLICT', 'PARTIAL'):
                bad(f'resolution.status=RESOLVED but phase={phase} is still frozen: the CAS '
                    'would refuse every new resolution while authorization stays claimed, '
                    'leaving the operation permanently unresolvable',
                    'RESOLVED_WITH_FROZEN_PHASE')
            elif want_phase and phase != want_phase:
                bad(f"resolution.status=RESOLVED with decision={st.get('decision')!r} requires "
                    f'phase={want_phase}, got {phase}', 'RESOLVED_PHASE_DECISION_MISMATCH')

    return errs
