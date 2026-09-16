/**
 * Cross-manifest invariants -- JS port of scripts/schema/resolution_validator.py.
 *
 * validateSemantics() sees ONE manifest at a time, so it can only check that a
 * resolution is internally coherent. That is not enough: an earlier revision
 * accepted a resolution whose releasedCapId, releasedReceiptIds, targetName and
 * observedConflictHash were all pure fiction, because nothing compared them
 * against the frozen operation.
 *
 * Must be called INSIDE the operation claim, not only in offline tests -- an
 * offline-only check protects nobody at runtime.
 *
 * Verdicts must match the Python reference exactly; conformance-corpus.json is
 * the proof and scripts/schema/conformance.test.mjs replays every case.
 */

import { createHash } from 'node:crypto';

export const RESOLVABLE_PHASES = new Set(['CONFLICT', 'PARTIAL']);

// Every kind the schema knows about. A resolution claiming some other kind is
// either a typo or an attempt to resolve something that does not exist.
export const KNOWN_KINDS = new Set([
  'create-proposal', 'apply', 'direct', 'converge', 'move', 'rotation', 'resolution',
]);

// Resolution lifecycle on the FROZEN manifest (not on the resolution itself).
export const UNRESOLVED = 'UNRESOLVED';
export const RESOLVING = 'RESOLVING';
export const RESOLVED = 'RESOLVED';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function rep(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

const sortedRep = (xs) => `[${[...xs].sort().map(rep).join(', ')}]`;

/**
 * Serialize like Python's json.dumps(sort_keys=True, separators=(',', ':')).
 *
 * This has to be byte-identical or the hash differs and every pairing check
 * fails: JSON.stringify does NOT sort keys, and Python emits no spaces after
 * separators. Both sides must see the same bytes for the same diagnostics.
 */
function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObj(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return 'null';
}

/** Hash the diagnostics exactly as the resolution must have observed them. */
export function canonicalConflictHash(conflict) {
  if (conflict === null || conflict === undefined) return null;
  return createHash('sha256').update(canonicalJson(conflict), 'utf8').digest('hex');
}

function claimedReceiptIds(manifest) {
  const rcs = Array.isArray(manifest?.receiptClaims) ? manifest.receiptClaims : [];
  return new Set(rcs.filter((r) => r.state === 'claimed').map((r) => r.receiptId));
}

/** Return a list of violations (empty == the pair is consistent). */
export function validateResolutionAgainstTarget(resolution, original) {
  const errs = [];
  const bad = (msg) => errs.push(msg);

  if (!isObj(resolution) || resolution.kind !== 'resolution') {
    bad('validate_resolution_against_target expects a resolution manifest');
    return errs;
  }

  if (original === null || original === undefined) {
    bad(`resolvesOpId=${rep(resolution.resolvesOpId)} names an operation that does not `
      + 'exist (a resolution may not invent its target)');
    return errs;
  }

  // 1. it must point at the operation we were handed
  if (resolution.resolvesOpId !== original.opId) {
    bad(`resolution.resolvesOpId=${rep(resolution.resolvesOpId)} != `
      + `original.opId=${rep(original.opId)}`);
  }

  // 2. only genuinely frozen operations may be resolved
  if (!RESOLVABLE_PHASES.has(original.phase)) {
    bad(`original.phase=${rep(original.phase)} is not resolvable; only `
      + `${sortedRep([...RESOLVABLE_PHASES])} hold frozen authorization`);
  }

  // 3. a resolution may not resolve another resolution (no chains)
  if (original.kind === 'resolution') {
    bad('cannot resolve a resolution (resolutions have no CONFLICT/PARTIAL terminal)');
  }

  // 4. resolvedKind must be real AND match
  if (!KNOWN_KINDS.has(resolution.resolvedKind)) {
    bad(`resolution.resolvedKind=${rep(resolution.resolvedKind)} is not a known kind `
      + `${sortedRep([...KNOWN_KINDS])}`);
  } else if (resolution.resolvedKind !== original.kind) {
    bad(`resolution.resolvedKind=${rep(resolution.resolvedKind)} != `
      + `original.kind=${rep(original.kind)}`);
  }

  // 5. same target -- otherwise a resolution could unfreeze op A while reporting
  // work on skill B. Do NOT short-circuit on the original having a targetName:
  // a rotation branch has none at all, which used to let any skill name through
  // and produced a misattributed audit trail.
  const origTarget = original.targetName ?? null;
  const resTarget = resolution.targetName ?? null;
  if (origTarget === null) {
    // The frozen kind has no target of its own: the resolution must say so too,
    // using the kind name as an explicit, non-forgeable marker.
    const expected = `<no-target:${original.kind}>`;
    if (resTarget !== expected) {
      bad(`original kind=${rep(original.kind)} has no targetName, so `
        + `resolution.targetName must be exactly ${rep(expected)}, got ${rep(resTarget)} `
        + '(otherwise any skill name would be accepted)');
    }
  } else if (resTarget !== origTarget) {
    bad(`resolution.targetName=${rep(resTarget)} != original.targetName=${rep(origTarget)}`);
  }

  // 6. the scene must not have moved since the operator looked at it
  const expectedHash = canonicalConflictHash(original.conflict);
  if (expectedHash === null) {
    bad('original manifest is frozen but carries no conflict diagnostics to observe');
  } else if (resolution.observedConflictHash !== expectedHash) {
    bad(`observedConflictHash=${String(resolution.observedConflictHash).slice(0, 12)}... does not `
      + `match the current diagnostics (${expectedHash.slice(0, 12)}...); the situation changed `
      + 'since the operator reviewed it, so the decision may no longer apply');
  }

  // 7a. releasedCapId must mirror the original EXACTLY, including the null case.
  // 7 of the 14 schema branches can freeze without any capClaim; demanding a
  // non-null id at COMPLETE while also requiring it to equal the original's
  // (absent) cap rejected both directions, so those ops could never be unfrozen.
  const origCap = original.capClaim;
  const origCapId = isObj(origCap) ? (origCap.capId ?? null) : null;
  const releasedCap = resolution.releasedCapId ?? null;
  if (origCapId === null) {
    if (releasedCap !== null) {
      bad('original operation holds no capability, so releasedCapId must be null, '
        + `got ${rep(releasedCap)}`);
    }
  } else if (releasedCap !== origCapId) {
    bad(`releasedCapId=${rep(releasedCap)} != the capability frozen on the `
      + `original operation (${rep(origCapId)})`);
  }

  // 7b. releasing a subset leaks the rest forever, so demand exact equality.
  const origReceipts = claimedReceiptIds(original);
  const released = new Set(Array.isArray(resolution.releasedReceiptIds)
    ? resolution.releasedReceiptIds : []);
  const sameSet = origReceipts.size === released.size
    && [...origReceipts].every((x) => released.has(x));
  if (!sameSet) {
    const missing = [...origReceipts].filter((x) => !released.has(x)).sort();
    const extra = [...released].filter((x) => !origReceipts.has(x)).sort();
    const detail = [];
    if (missing.length) detail.push(`still frozen: ${sortedRep(missing)}`);
    if (extra.length) detail.push(`not held by the original: ${sortedRep(extra)}`);
    bad("releasedReceiptIds must equal the original's claimed receipts exactly "
      + `(${detail.join('; ')}) -- releasing a subset leaks the rest forever`);
  }

  // 8. the resolution must not spend the very capability it is freeing
  const resCap = resolution.capClaim;
  if (isObj(resCap) && resCap.capId === resolution.releasedCapId) {
    bad('resolution must carry its own capability, not the frozen one it releases');
  }

  return errs;
}

/**
 * Guard against two resolutions owning the same frozen operation.
 *
 * Returns {ok, code, detail}. Callers must treat ok=false as fatal for this
 * attempt; 'retry' means the same resolution is replaying and should get the
 * original receipt back. An unknown status fails closed.
 */
export function checkResolutionCas(original, resolutionOpId) {
  const state = isObj(original) && isObj(original.resolution) ? original.resolution : {};
  const status = state.status ?? UNRESOLVED;
  const owner = state.resolutionOpId;

  if (status === UNRESOLVED) {
    return { ok: true, code: 'claim', detail: `${resolutionOpId} may claim this operation` };
  }
  if (status === RESOLVING) {
    if (owner === resolutionOpId) {
      return { ok: true, code: 'retry', detail: 'same resolution replaying; return the original receipt' };
    }
    return {
      ok: false,
      code: 'conflict',
      detail: `operation is already being resolved by ${rep(owner)}; `
        + `${rep(resolutionOpId)} must not proceed (409)`,
    };
  }
  if (status === RESOLVED) {
    if (owner === resolutionOpId) {
      return { ok: true, code: 'retry', detail: 'already resolved by this op; return the original receipt' };
    }
    return {
      ok: false,
      code: 'conflict',
      detail: `operation was already resolved by ${rep(owner)} with decision `
        + `${rep(state.decision)} (409)`,
    };
  }
  return { ok: false, code: 'invalid', detail: `unknown resolution status ${rep(status)} (fail closed)` };
}

export const RESOLVED_PHASE_BY_DECISION = {
  'roll-forward': 'RESOLVED_ROLLED_FORWARD',
  rollback: 'RESOLVED_ROLLED_BACK',
  abandon: 'RESOLVED_ABANDONED',
};

/** Which terminal the FROZEN operation must move to, per decision. */
export function resolvedPhaseFor(decision) {
  return RESOLVED_PHASE_BY_DECISION[decision];
}

/**
 * Where the frozen authorization must end up, per decision.
 *
 * roll-forward means the mutation did land, so the authorization was genuinely
 * spent. rollback/abandon mean it never landed, so it must go back to the pool.
 */
export function authorizationAfterResolution(decision) {
  return { 'roll-forward': 'consumed', rollback: 'available', abandon: 'available' }[decision];
}
