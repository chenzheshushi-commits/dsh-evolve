"""Generate the dsh-evolve v0.6.0 op-manifest JSON Schema (rev14).

rev13 shipped a file that FAILED Draft202012Validator.check_schema() because one
branch listed `targetName` twice in `required`. The rev13 verifier never called
check_schema(), so 18/18 was a false green. rev14 therefore:

  * dedupes `required` mechanically (helper refuses duplicates outright);
  * adds phase-conditional constraints via allOf/if-then so COMPLETE without a
    durable result, FAILED without an error, and CONFLICT/PARTIAL without
    diagnostics are all rejected structurally;
  * gives protocols A/B/C/D their own marker types instead of one loose marker;
  * adds the Web rollback-proposal branch the API already exposes;
  * closes durableResult.receipt.

Cross-field invariants that JSON Schema cannot express (opId equality across
nested objects, revision monotonicity, receipt cardinality) live in
semantic_validator.py and are declared co-equal construction contracts.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / 'op-manifest.schema.json'

TERMINALS = ['COMPLETE', 'ABORTED', 'FAILED', 'CONFLICT', 'PARTIAL']

# Resolved terminals: a frozen operation must be able to REACH a state that
# records how it was unfrozen. rev18 had none, so A93(6) ("the original enters a
# resolved terminal") had no phase to land on.
RESOLVED_TERMINALS = ['RESOLVED_ROLLED_FORWARD', 'RESOLVED_ROLLED_BACK', 'RESOLVED_ABANDONED']



def req(*names):
    """Build a required list, refusing duplicates at generation time.

    rev13's bug was a duplicated entry in exactly this position, so the guard
    lives here rather than in a downstream check.
    """
    out = []
    for n in names:
        if n in out:
            raise AssertionError(f'duplicate required field: {n}')
        out.append(n)
    return out


def obj(required, properties, *, title):
    for r in required:
        if r not in properties:
            raise AssertionError(f'{title}: required {r!r} missing from properties')
    return {
        'title': title,
        'type': 'object',
        'additionalProperties': False,
        'required': required,
        'properties': properties,
    }


def const(v): return {'const': v}
def enum(*v): return {'enum': list(v)}
def s(): return {'type': 'string', 'minLength': 1}
def sha(): return {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}
def integer(minimum=0): return {'type': 'integer', 'minimum': minimum}
def arr(items, min_items=0): return {'type': 'array', 'items': items, 'minItems': min_items}
def ref(n): return {'$ref': f'#/$defs/{n}'}
def dt(): return {'type': 'string', 'format': 'date-time'}
def nullable(sch): return {'anyOf': [sch, {'type': 'null'}]}


# Phase-conditional rules: a terminal phase must carry its evidence, and a
# non-terminal phase must not pretend to have finished.
PHASE_RULES = [
    {'if': {'properties': {'phase': const('COMPLETE')}, 'required': ['phase']},
     'then': {'properties': {'result': ref('durableResult'), 'error': {'type': 'null'}},
              'required': ['result']}},
    {'if': {'properties': {'phase': const('FAILED')}, 'required': ['phase']},
     'then': {'properties': {'error': ref('durableError'), 'result': {'type': 'null'}},
              'required': ['error']}},
    {'if': {'properties': {'phase': const('CONFLICT')}, 'required': ['phase']},
     'then': {'properties': {'conflict': ref('conflictDiagnostics'), 'result': {'type': 'null'}},
              'required': ['conflict']}},
    {'if': {'properties': {'phase': const('PARTIAL')}, 'required': ['phase']},
     'then': {'properties': {'conflict': ref('conflictDiagnostics')}, 'required': ['conflict']}},
    {'if': {'properties': {'phase': const('ABORTED')}, 'required': ['phase']},
     'then': {'properties': {'result': {'type': 'null'}}}},
    # Anything not terminal must not carry a durable result.
    {'if': {'properties': {'phase': {'not': {'enum': TERMINALS + RESOLVED_TERMINALS}}},
            'required': ['phase']},
     'then': {'properties': {'result': {'type': 'null'}}}},
    # A resolved terminal must record who resolved it and how.
    {'if': {'properties': {'phase': {'enum': RESOLVED_TERMINALS}}, 'required': ['phase']},
     'then': {'required': ['resolution']}},
]


def base_props(kind, phases, *, source=None, protocol=None, terminals=None):
    p = {
        'schemaVersion': const(1),
        'kind': const(kind),
        'opId': s(),
        'revision': integer(0),
        'phase': enum(*(phases + (TERMINALS if terminals is None else terminals))),
        'createdAt': dt(),
        'updatedAt': dt(),
        'eventsPath': s(),
        'result': nullable(ref('durableResult')),
        'error': nullable(ref('durableError')),
        'conflict': nullable(ref('conflictDiagnostics')),
    }
    if source is not None:
        p['source'] = const(source)
    if protocol is not None:
        p['protocol'] = const(protocol)
    # Any branch that can freeze must be able to carry CAS ownership and to
    # reach a resolved terminal. Resolutions themselves are excluded: they can
    # never freeze (see RESOLUTION_TERMINALS).
    reachable = set(p['phase']['enum'])
    if reachable & {'CONFLICT', 'PARTIAL'}:
        p['phase'] = enum(*(sorted(reachable | set(RESOLVED_TERMINALS))))
        p['resolution'] = ref('resolutionState')
    return p


COMMON = ['schemaVersion', 'kind', 'opId', 'revision', 'phase', 'createdAt',
          'updatedAt', 'eventsPath', 'result', 'error', 'conflict']


def branch(required, properties, *, title):
    b = obj(required, properties, title=title)
    b['allOf'] = PHASE_RULES
    return b


DEFS = {
    # CAS ownership of a frozen operation. rev18 documented this object but
    # never declared it, so additionalProperties:false rejected every manifest
    # carrying it -> status was always absent -> two different resolutions both
    # got (True,'claim') and the double-unfreeze bug was never actually fixed.
    'resolutionState': obj(req('status'),
                           {'status': enum('UNRESOLVED', 'RESOLVING', 'RESOLVED'),
                            'resolutionOpId': {'type': ['string', 'null']},
                            'decision': {'anyOf': [enum('roll-forward', 'rollback', 'abandon'),
                                                   {'type': 'null'}]},
                            'resolvedAt': {'anyOf': [dt(), {'type': 'null'}]}},
                           title='Resolution CAS state on a freezable operation'),
    'capClaim': obj(req('capId', 'purpose', 'digest', 'claimedByOpId', 'state'),
                    {'capId': s(), 'purpose': s(), 'digest': sha(), 'claimedByOpId': s(),
                     'state': enum('claimed', 'consumed', 'available')}, title='Capability claim'),
    'receiptClaim': obj(req('receiptId', 'skillName', 'callId', 'state'),
                        {'receiptId': s(), 'skillName': s(), 'callId': s(),
                         'state': enum('claimed', 'consumed', 'available')}, title='Usage receipt claim'),
    # Protocol-specific markers. Protocol D moves a whole tree and has no
    # SKILL.md hashes to promise, so it must not inherit the content-hash marker.
    'markerAC': obj(req('opId', 'protocol', 'action', 'expectedAfterContentHash', 'expectedAfterStateHash'),
                    {'opId': s(), 'protocol': enum('A', 'C'),
                     'action': enum('create', 'converge', 'rollback'),
                     'expectedAfterContentHash': sha(), 'expectedAfterStateHash': sha()},
                    title='Commit marker (protocol A/C: directory publish)'),
    'markerB': obj(req('opId', 'protocol', 'action', 'expectedAfterContentHash', 'expectedAfterStateHash', 'lastCommittedOpId'),
                   {'opId': s(), 'protocol': const('B'), 'action': enum('refine', 'fold'),
                    'expectedAfterContentHash': sha(), 'expectedAfterStateHash': sha(),
                    'lastCommittedOpId': s()},
                   title='Commit marker (protocol B: in-place SKILL.md state)'),
    'markerD': obj(req('opId', 'protocol', 'action', 'logicalSkillName', 'archiveId'),
                   {'opId': s(), 'protocol': const('D'),
                    'action': enum('archive', 'restore', 'autoArchive'),
                    'logicalSkillName': s(), 'archiveId': s()},
                   title='Commit marker (protocol D: tree move, no content hash)'),
    'reservationOwner': obj(req('proposalId', 'opId'), {'proposalId': s(), 'opId': s()},
                            title='Reservation owner'),
    'stampProgress': obj(req('done', 'pending'), {'done': arr(s()), 'pending': arr(s())},
                         title='Evidence stamp progress'),
    'member': obj(req('path', 'type', 'size', 'mode', 'contentHash'),
                  {'path': s(), 'type': enum('file', 'directory'), 'size': integer(0),
                   'mode': integer(0), 'contentHash': sha()}, title='Validated tar member'),
    'resource': obj(req('role', 'name', 'beforePath', 'stagingPath', 'finalPath',
                        'beforeContentHash', 'beforeStateHash', 'afterContentHash',
                        'afterStateHash', 'backupPath', 'status'),
                    {'role': enum('source', 'target'), 'name': s(),
                     'beforePath': {'type': ['string', 'null']}, 'stagingPath': s(),
                     'finalPath': s(), 'archiveId': {'type': ['string', 'null']},
                     'beforeContentHash': nullable(sha()), 'beforeStateHash': nullable(sha()),
                     'afterContentHash': nullable(sha()), 'afterStateHash': nullable(sha()),
                     'backupPath': {'type': ['string', 'null']},
                     'status': enum('pending', 'staged', 'committed', 'archived', 'rolled-back')},
                    title='Converge resource'),
    'lockOwner': obj(req('instanceId', 'opId', 'pid', 'processStartToken', 'bootId', 'acquiredAt', 'ttlMs'),
                     {'instanceId': s(), 'opId': s(), 'pid': integer(1), 'processStartToken': s(),
                      'bootId': s(), 'acquiredAt': dt(), 'ttlMs': integer(1)},
                     title='Fenced lock owner'),
    'durableResult': obj(req('outcome', 'receipt', 'completedAt'),
                         {'outcome': enum('ok', 'degraded'),
                          'receipt': obj(req('opId', 'kind', 'targetName'),
                                         {'opId': s(), 'kind': s(), 'targetName': s(),
                                          'archiveId': {'type': ['string', 'null']},
                                          'finalPath': {'type': ['string', 'null']},
                                          'afterContentHash': nullable(sha())},
                                         title='Idempotent replay receipt'),
                          'completedAt': dt()}, title='Durable idempotent result'),
    'durableError': obj(req('code', 'message', 'at'), {'code': s(), 'message': s(), 'at': dt()},
                        title='Durable failure'),
    'conflictDiagnostics': obj(req('code', 'message', 'resources', 'at'),
                               {'code': s(), 'message': s(), 'resources': arr(s()), 'at': dt()},
                               title='Conflict/partial diagnostics'),
}

branches = []

# ---- proposal creation: split by source AND action (rev13 had one model-tool-only branch) ----
for source, action_schema, extra_props, extra_req, title in [
    ('model-tool', enum('create', 'refine', 'fold', 'converge'),
     {'sourceIds': arr(s(), 1), 'reservationKey': sha(),
      'reservationRevisionBefore': integer(0), 'reservationRevisionAfter': integer(1),
      'reservationOwner': ref('reservationOwner')},
     ['sourceIds', 'reservationKey', 'reservationRevisionBefore', 'reservationRevisionAfter', 'reservationOwner'],
     'Create proposal from model tool (evidence-backed)'),
    # Rollback proposals come from a fixed backup artifact and have no memory
    # evidence, so forcing sourceIds/reservation on them was wrong.
    # A rollback proposal is a real write (it seals an artifact and takes disk),
    # so it needs its own capability. rev16 documented the purpose but never put
    # capClaim in the schema, so the plan demanded a capability the contract
    # forbade.
    ('web-user', const('rollback'),
     {'artifactId': sha(), 'artifactSha256': sha(), 'artifactPath': s(),
      'memberManifest': arr(ref('member'), 1), 'capClaim': ref('capClaim')},
     ['artifactId', 'artifactSha256', 'artifactPath', 'memberManifest', 'capClaim'],
     'Create rollback proposal from Web (artifact-backed, capability-gated)'),
]:
    p = base_props('create-proposal', ['PREPARED', 'RESERVED'], source=source)
    p.update({'action': action_schema, 'targetName': s(), 'proposalId': s(), 'proposalHash': sha()})
    p.update(extra_props)
    branches.append(branch(req(*(COMMON + ['source', 'action', 'targetName', 'proposalId', 'proposalHash'] + extra_req)),
                           p, title=title))

# ---- apply protocols A/B/C for Web-approved proposals ----
APPLY = [
    ('A', ['CAP_CLAIMED', 'PROPOSAL_CLAIMED', 'INTENT', 'COMMITTED', 'META_APPLIED', 'RESV_CONSUMED', 'STAMPS_DONE', 'AUTHZ_CONSUMED'],
     {'stagingPath': s(), 'finalPath': s(), 'marker': ref('markerAC'),
      'expectedAfterContentHash': sha(), 'expectedAfterStateHash': sha(),
      'backupPath': {'type': ['string', 'null']}},
     ['stagingPath', 'finalPath', 'marker', 'expectedAfterContentHash', 'expectedAfterStateHash', 'backupPath'],
     'Web proposal apply: new skill directory (protocol A)'),
    ('B', ['CAP_CLAIMED', 'PROPOSAL_CLAIMED', 'RECEIPT_CLAIMED', 'INTENT', 'COMMITTED', 'META_APPLIED', 'RESV_CONSUMED', 'STAMPS_DONE', 'AUTHZ_CONSUMED'],
     {'beforeContentHash': sha(), 'beforeStateHash': sha(), 'expectedAfterContentHash': sha(),
      'expectedAfterStateHash': sha(), 'tmpPath': s(), 'finalPath': s(), 'backupPath': s(),
      'marker': ref('markerB'), 'lastCommittedOpId': s()},
     ['beforeContentHash', 'beforeStateHash', 'expectedAfterContentHash', 'expectedAfterStateHash',
      'tmpPath', 'finalPath', 'backupPath', 'marker', 'lastCommittedOpId'],
     'Web proposal apply: rewrite SKILL.md (protocol B)'),
    ('C', ['CAP_CLAIMED', 'PROPOSAL_CLAIMED', 'INTENT', 'RETIRED', 'COMMITTED', 'META_APPLIED', 'AUTHZ_CONSUMED'],
     {'artifactId': sha(), 'artifactSha256': sha(), 'artifactPath': s(),
      'memberManifest': arr(ref('member'), 1), 'retiredPath': s(), 'stagingPath': s(),
      'finalPath': s(), 'marker': ref('markerAC'),
      'expectedRestoredContentHash': sha(), 'expectedRestoredStateHash': sha()},
     ['artifactId', 'artifactSha256', 'artifactPath', 'memberManifest', 'retiredPath',
      'stagingPath', 'finalPath', 'marker', 'expectedRestoredContentHash', 'expectedRestoredStateHash'],
     'Web proposal apply: rollback directory (protocol C)'),
]
for protocol, phases, extras, extra_req, title in APPLY:
    p = base_props('apply', phases, source='web-proposal', protocol=protocol)
    # targetName listed exactly once -- rev13 duplicated it here and broke check_schema().
    p.update({'proposalId': s(), 'targetName': s(), 'capClaim': ref('capClaim'),
              'receiptClaims': arr(ref('receiptClaim')),
              'reservationRevisionBefore': integer(0), 'reservationRevisionAfter': integer(0),
              'reservationOwner': ref('reservationOwner'), 'stampProgress': ref('stampProgress')})
    p.update(extras)
    branches.append(branch(req(*(COMMON + ['source', 'protocol', 'proposalId', 'targetName', 'capClaim',
                                           'receiptClaims', 'reservationRevisionBefore',
                                           'reservationRevisionAfter', 'reservationOwner',
                                           'stampProgress'] + extra_req)), p, title=title))

# ---- autonomous direct: no proposal, no capability ----
p = base_props('direct', ['PREPARED', 'RESERVED', 'INTENT', 'COMMITTED', 'RESV_CONSUMED', 'STAMPS_DONE'],
               source='autonomous-tool', protocol='A')
p.update({'action': const('create'), 'targetName': s(), 'sourceIds': arr(s(), 1),
          'reservationKey': sha(), 'reservationRevisionBefore': integer(0),
          'reservationRevisionAfter': integer(1), 'reservationOwner': ref('reservationOwner'),
          'stagingPath': s(), 'finalPath': s(), 'marker': ref('markerAC'),
          'expectedAfterContentHash': sha(), 'expectedAfterStateHash': sha(),
          'stampProgress': ref('stampProgress'), 'configRevision': integer(0)})
branches.append(branch(req(*(COMMON + ['source', 'protocol', 'action', 'targetName', 'sourceIds',
                                       'reservationKey', 'reservationRevisionBefore', 'reservationRevisionAfter',
                                       'reservationOwner', 'stagingPath', 'finalPath', 'marker',
                                       'expectedAfterContentHash', 'expectedAfterStateHash',
                                       'stampProgress', 'configRevision'])), p,
                       title='Autonomous direct create (protocol A)'))

p = base_props('direct', ['RECEIPT_CLAIMED', 'INTENT', 'COMMITTED', 'STAMPS_DONE', 'AUTHZ_CONSUMED'],
               source='autonomous-tool', protocol='B')
p.update({'action': enum('refine', 'fold'), 'targetName': s(), 'beforeContentHash': sha(),
          'beforeStateHash': sha(), 'expectedAfterContentHash': sha(), 'expectedAfterStateHash': sha(),
          'tmpPath': s(), 'finalPath': s(), 'backupPath': s(), 'marker': ref('markerB'),
          'lastCommittedOpId': s(), 'receiptClaims': arr(ref('receiptClaim'), 1),
          'stampProgress': ref('stampProgress'), 'configRevision': integer(0)})
branches.append(branch(req(*(COMMON + ['source', 'protocol', 'action', 'targetName', 'beforeContentHash',
                                       'beforeStateHash', 'expectedAfterContentHash', 'expectedAfterStateHash',
                                       'tmpPath', 'finalPath', 'backupPath', 'marker', 'lastCommittedOpId',
                                       'receiptClaims', 'stampProgress', 'configRevision'])), p,
                       title='Autonomous direct refine/fold (protocol B)'))

# ---- converge ----
for source, cap_required in [('web-proposal', True), ('autonomous-tool', False)]:
    p = base_props('converge', ['PREPARED', 'SOURCES_STAGED', 'COMMITTED', 'ARCHIVE_FINALIZED'], source=source)
    p.update({'proposalId': {'type': ['string', 'null']}, 'targetName': s(),
              'target': ref('resource'), 'resources': arr(ref('resource'), 2),
              'receiptClaims': arr(ref('receiptClaim'), 1), 'configRevision': integer(0)})
    r = COMMON + ['source', 'proposalId', 'targetName', 'target', 'resources', 'receiptClaims', 'configRevision']
    if cap_required:
        p['capClaim'] = ref('capClaim')
        r = r + ['capClaim']
    branches.append(branch(req(*r), p, title=f'Converge from {source}'))

# ---- protocol D moves ----
for source, action_schema, cap_required, title in [
    ('web-proposal', enum('archive', 'restore'), True, 'Web archive/restore move (protocol D)'),
    ('model-tool', enum('archive', 'restore'), False, 'Model-tool archive/restore move (protocol D)'),
    ('auto', const('autoArchive'), False, 'Automatic archive move (protocol D)'),
]:
    p = base_props('move', ['INTENT', 'COMMITTED'], source=source, protocol='D')
    p.update({'action': action_schema, 'sourceKey': s(), 'destKey': s(),
              'beforeTreeHash': sha(), 'committedTreeHash': sha(), 'marker': ref('markerD'),
              'logicalSkillName': s(), 'archiveId': s(), 'configRevision': integer(0)})
    r = COMMON + ['source', 'protocol', 'action', 'sourceKey', 'destKey', 'beforeTreeHash',
                  'committedTreeHash', 'marker', 'logicalSkillName', 'archiveId', 'configRevision']
    if cap_required:
        p['capClaim'] = ref('capClaim')
        r = r + ['capClaim']
    branches.append(branch(req(*r), p, title=title))

# ---- resolution: the ONLY way out of CONFLICT/PARTIAL ----
# rev16 froze capability+receipts at 'claimed' on CONFLICT/PARTIAL while also
# declaring those phases absorbing. With no resolution operation that is a
# permanent resource leak: the original op cannot continue, and a new op can
# never acquire the held capability. This branch is the human's unlock path.
# A resolution must NEVER be able to enter CONFLICT/PARTIAL: rule 22 forbids
# resolving a resolution, so a frozen resolution would recreate exactly the
# deadlock this branch exists to break. If it finds the scene changed it must
# fail BEFORE mutating and release its own capability.
RESOLUTION_TERMINALS = ['COMPLETE', 'FAILED', 'ABORTED']
p = base_props('resolution', ['CLAIMED', 'INTENT', 'APPLIED'], source='web-user',
               terminals=RESOLUTION_TERMINALS)
p.update({
    'resolvesOpId': s(),          # the CONFLICT/PARTIAL manifest being resolved
    'resolvedKind': s(),          # its kind, copied for auditability
    'decision': enum('roll-forward', 'rollback', 'abandon'),
    'capClaim': ref('capClaim'),  # resolution carries its OWN capability
    'releasedCapId': {'type': ['string', 'null']},   # the frozen cap being freed
    'releasedReceiptIds': arr(s()),
    'observedConflictHash': sha(),   # diagnostics must not have changed since
    'targetName': s(),
})
p['conflict'] = {'type': 'null'}   # a resolution can never itself be in conflict
branches.append(branch(req(*(COMMON + ['source', 'resolvesOpId', 'resolvedKind', 'decision',
                                       'capClaim', 'releasedCapId', 'releasedReceiptIds',
                                       'observedConflictHash', 'targetName'])), p,
                       title='Operator resolution of a CONFLICT/PARTIAL operation'))

# ---- rotation: no protocol, no capability ----
p = base_props('rotation', ['DUAL_KEY_PERSISTED', 'RESIGNING', 'VERIFIED', 'ACTIVE_SWITCHED'])
p.update({'fromKeyId': s(), 'toKeyId': s(), 'ownerRevisionBefore': integer(0),
          'ownerRevisionAfter': integer(1), 'scannedAssets': arr(s()), 'verifiedAssets': arr(s()),
          'namespaceLockOwner': ref('lockOwner')})
branches.append(branch(req(*(COMMON + ['fromKeyId', 'toKeyId', 'ownerRevisionBefore', 'ownerRevisionAfter',
                                       'scannedAssets', 'verifiedAssets', 'namespaceLockOwner'])), p,
                       title='Ownership key rotation'))

schema = {
    '$schema': 'https://json-schema.org/draft/2020-12/schema',
    '$id': 'https://local.dsh-evolve/schema/op-manifest-rev14.json',
    'title': 'dsh-evolve v0.6.0 operation manifest (rev14)',
    'description': ('Structural construction contract. Cross-field invariants (opId equality, '
                    'revision monotonicity, receipt cardinality) are enforced by '
                    'semantic_validator.py, which is a CO-EQUAL construction contract.'),
    'oneOf': branches,
    '$defs': DEFS,
}

if __name__ == '__main__':
    from jsonschema import Draft202012Validator
    Draft202012Validator.check_schema(schema)  # fail the build, not the reviewer
    OUT.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'check_schema: PASS')
    print(f'branches: {len(branches)}')
    print(f'written: {OUT}')
