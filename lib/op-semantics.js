/**
 * Cross-field invariants for dsh-evolve op manifests -- JS port.
 *
 * This is a line-by-line port of scripts/schema/semantic_validator.py. The
 * Python module is the reference; this file must produce IDENTICAL verdicts.
 * conformance-corpus.json is the proof: every case carries the verdict Python
 * actually produced, and scripts/schema/conformance.test.mjs replays all of them
 * here. A mismatch means the two have drifted and the plan is NOT being enforced
 * at runtime -- which was the whole point of the exercise (the contracts were
 * Python-only, the runtime is JS, and nothing bridged them).
 *
 * Do not "improve" a rule here without changing the Python side and
 * regenerating the corpus, or the bridge silently breaks.
 */

// Terminals that end an operation outright. (py: BASE_TERMINALS)
export const BASE_TERMINALS = new Set([
  'COMPLETE', 'ABORTED', 'FAILED', 'CONFLICT', 'PARTIAL',
]);

// Terminals reached by an operator resolution. These ARE terminal: leaving them
// out made rule 13 reject roll-forward's durable receipt (whose whole purpose is
// idempotent replay) and made rule 15's exclusivity check skip them entirely.
// A new enum value must be added to EVERY set that consumes it.
export const RESOLVED_TERMINALS = new Set([
  'RESOLVED_ROLLED_FORWARD', 'RESOLVED_ROLLED_BACK', 'RESOLVED_ABANDONED',
]);

export const TERMINALS = new Set([...BASE_TERMINALS, ...RESOLVED_TERMINALS]);

// phase -> [allowed capClaim states, allowed receiptClaim states]  (py rule 10)
const TERMINAL_AUTHZ = {
  COMPLETE: [['consumed'], ['consumed']],
  ABORTED: [['available'], ['available']],
  FAILED: [['available'], ['available']],
  // CONFLICT/PARTIAL need a human: authorization stays claimed so the operator
  // can resume, but must never be silently consumed.
  CONFLICT: [['claimed'], ['claimed']],
  PARTIAL: [['claimed'], ['claimed']],
  // After a resolution unfreezes the operation the authorization must have
  // MOVED. roll-forward means the mutation landed, so it was genuinely spent;
  // rollback/abandon mean it never landed, so it returns to the pool.
  RESOLVED_ROLLED_FORWARD: [['consumed'], ['consumed']],
  RESOLVED_ROLLED_BACK: [['available'], ['available']],
  RESOLVED_ABANDONED: [['available'], ['available']],
};

// phase -> the only evidence field it may carry  (py rule 15)
const TERMINAL_EVIDENCE = {
  COMPLETE: ['result'],
  FAILED: ['error'],
  CONFLICT: ['conflict'],
  PARTIAL: ['conflict'],
  ABORTED: [],
  RESOLVED_ROLLED_FORWARD: ['result'],
  RESOLVED_ROLLED_BACK: [],
  RESOLVED_ABANDONED: [],
};

const RESOLVED_PHASES = {
  RESOLVED_ROLLED_FORWARD: 'roll-forward',
  RESOLVED_ROLLED_BACK: 'rollback',
  RESOLVED_ABANDONED: 'abandon',
};

const PROTOCOL_MARKER_ACTIONS = {
  A: ['create', 'converge'],
  C: ['rollback'],
};

// (kind, protocol) -> allowed capability purposes  (py rule 18)
const PURPOSE_BY_OP = new Map([
  ['apply|A', ['proposal-apply']],
  ['apply|B', ['proposal-apply']],
  ['apply|C', ['proposal-apply', 'skill-rollback']],
  ['converge|null', ['proposal-apply', 'skill-converge']],
  // A rollback proposal is minted before any proposalId exists, so it cannot
  // reuse the proposal-apply digest -- it has its own purpose.
  ['create-proposal|null', ['rollback-proposal-create']],
  ['resolution|null', ['operation-resolve']],
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const has = (m, k) => Object.prototype.hasOwnProperty.call(m, k);
const arr = (v) => (Array.isArray(v) ? v : []);

/** Mirror Python's repr() closely enough for message equality checks. */
function rep(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

const sortedRep = (xs) => `[${[...xs].sort().map(rep).join(', ')}]`;

/**
 * Parse an RFC3339 timestamp into epoch millis, or null when unparseable.
 * Returns {ms, hasOffset} so callers can reject offset-less stamps: RFC3339
 * permits different UTC offsets, so string ordering is NOT time ordering
 * ('...T11:00:00+08:00' sorts after '...T12:00:00Z' while being 9h earlier).
 */
function parseStamp(s) {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return { ms, hasOffset };
}

/**
 * Return a list of invariant violations; an empty array means valid.
 * Errors carrying a stable code are prefixed `[CODE] `, exactly as Python does,
 * so tests can assert WHICH rule fired instead of merely that something did.
 */
export function validateSemantics(m) {
  const errs = [];
  const opId = m.opId;
  const kind = m.kind;
  const phase = m.phase;
  const source = m.source;

  const bad = (msg, code) => errs.push(code ? `[${code}] ${msg}` : msg);

  const marker = m.marker;
  const cap = m.capClaim;
  const res = m.result;

  // --- 1. every nested opId must belong to THIS op ---
  if (isObj(marker) && marker.opId !== opId) {
    bad(`marker.opId=${rep(marker.opId)} != manifest.opId=${rep(opId)} `
      + "(a foreign marker would let recovery adopt another op's commit)");
  }
  if (isObj(cap) && cap.claimedByOpId !== opId) {
    bad(`capClaim.claimedByOpId=${rep(cap.claimedByOpId)} != manifest.opId=${rep(opId)}`);
  }
  const owner = m.reservationOwner;
  if (isObj(owner)) {
    if (owner.opId !== opId) {
      bad(`reservationOwner.opId=${rep(owner.opId)} != manifest.opId=${rep(opId)}`);
    }
    if (m.proposalId && owner.proposalId !== m.proposalId) {
      bad(`reservationOwner.proposalId=${rep(owner.proposalId)} != `
        + `manifest.proposalId=${rep(m.proposalId)}`);
    }
  }
  const lock = m.namespaceLockOwner;
  if (isObj(lock) && lock.opId !== opId) {
    bad(`namespaceLockOwner.opId=${rep(lock.opId)} != manifest.opId=${rep(opId)}`);
  }
  if (isObj(res) && isObj(res.receipt)) {
    const rc = res.receipt;
    if (rc.opId !== opId) {
      bad(`result.receipt.opId=${rep(rc.opId)} != manifest.opId=${rep(opId)}`);
    }
    if (rc.kind !== kind) {
      bad(`result.receipt.kind=${rep(rc.kind)} != manifest.kind=${rep(kind)}`);
    }
  }

  // --- 2. marker protocol must match the manifest protocol ---
  if (isObj(marker) && m.protocol && marker.protocol !== m.protocol) {
    bad(`marker.protocol=${rep(marker.protocol)} != manifest.protocol=${rep(m.protocol)}`);
  }

  // --- 3. marker action must match the manifest action ---
  if (isObj(marker) && m.action && marker.action !== m.action) {
    bad(`marker.action=${rep(marker.action)} != manifest.action=${rep(m.action)}`);
  }

  // --- 4. protocol D marker identity must match the move it commits ---
  if (kind === 'move' && isObj(marker)) {
    for (const f of ['logicalSkillName', 'archiveId']) {
      if (has(m, f) && marker[f] !== m[f]) {
        bad(`marker.${f}=${rep(marker[f])} != manifest.${f}=${rep(m[f])}`);
      }
    }
  }

  // --- 5. reservation revision must advance strictly when this op wrote it ---
  const b = m.reservationRevisionBefore;
  const a = m.reservationRevisionAfter;
  if (isInt(b) && isInt(a)) {
    const wrote = kind === 'create-proposal' || (kind === 'direct' && m.action === 'create');
    if (wrote && a <= b) {
      bad(`reservationRevisionAfter=${a} must be > Before=${b} when this op writes the sidecar`);
    } else if (a < b) {
      bad(`reservationRevisionAfter=${a} must never be < Before=${b}`);
    }
  }
  if (kind === 'rotation') {
    const rb = m.ownerRevisionBefore;
    const ra = m.ownerRevisionAfter;
    if (isInt(rb) && isInt(ra) && ra <= rb) {
      bad(`ownerRevisionAfter=${ra} must be > Before=${rb}`);
    }
  }

  // --- 6. protocol B must publish the marker it claims to publish ---
  if (m.protocol === 'B' && isObj(marker)) {
    if (marker.lastCommittedOpId !== m.lastCommittedOpId) {
      bad('marker.lastCommittedOpId != manifest.lastCommittedOpId '
        + '(protocol B publishes both in one rename; they cannot disagree)');
    }
    if (marker.lastCommittedOpId !== opId) {
      bad(`protocol B marker.lastCommittedOpId must equal this opId ${rep(opId)}`);
    }
    for (const f of ['expectedAfterContentHash', 'expectedAfterStateHash']) {
      if (marker[f] !== m[f]) bad(`marker.${f} != manifest.${f}`);
    }
  }

  // --- 7. converge: one usage receipt per source, and target must not be a source ---
  if (kind === 'converge') {
    const sources = arr(m.resources).filter((r) => r.role === 'source');
    const receipts = arr(m.receiptClaims);
    if (receipts.length < sources.length) {
      bad(`converge needs >= 1 usage receipt per source: ${sources.length} sources `
        + `but only ${receipts.length} receipt(s)`);
    }
    const names = sources.map((r) => r.name);
    if (new Set(names).size !== names.length) {
      bad(`converge sources contain duplicates: ${sortedRep(names)}`);
    }
    const tgt = (isObj(m.target) ? m.target.name : undefined);
    if (names.includes(tgt)) bad(`converge target ${rep(tgt)} also appears as a source`);
    const skills = new Set(receipts.map((r) => r.skillName));
    const missing = names.filter((n) => !skills.has(n));
    if (missing.length) {
      bad(`converge sources without a matching usage receipt: ${sortedRep(missing)}`);
    }
  }

  // --- 8. autonomous / auto paths must never carry a Web capability ---
  if (['autonomous-tool', 'auto', 'model-tool'].includes(source)
      && m.capClaim !== null && m.capClaim !== undefined) {
    bad(`source=${rep(source)} must not carry capClaim `
      + '(no Web capability exists on this path)');
  }

  // --- 9. protocol B refine/fold requires a usage receipt naming the target ---
  if (m.protocol === 'B') {
    const names = new Set(arr(m.receiptClaims).map((r) => r.skillName));
    if (m.targetName && !names.has(m.targetName)) {
      bad(`protocol B needs a usage receipt for ${rep(m.targetName)}; `
        + `got ${sortedRep([...names])}`);
    }
  }

  // --- 10. terminal-phase authorization matrix.
  // A capability or receipt left in the wrong state after a terminal phase is a
  // real security hole: 'consumed' on a failed op means the authorization was
  // spent without the mutation landing, and it can never be reused or audited.
  if (has(TERMINAL_AUTHZ, phase)) {
    const [capOk, recOk] = TERMINAL_AUTHZ[phase];
    if (isObj(cap) && !capOk.includes(cap.state)) {
      bad(`phase=${phase} requires capClaim.state in ${sortedRep(capOk)}, `
        + `got ${rep(cap.state)}`, 'TERMINAL_AUTHZ_CAP');
    }
    for (const r of arr(m.receiptClaims)) {
      if (!recOk.includes(r.state)) {
        bad(`phase=${phase} requires receipt ${rep(r.receiptId)} state in `
          + `${sortedRep(recOk)}, got ${rep(r.state)}`, 'TERMINAL_AUTHZ_RECEIPT');
      }
    }
  }

  // --- 11. stamp progress must not overlap ---
  if (isObj(m.stampProgress)) {
    const done = new Set(arr(m.stampProgress.done));
    const both = arr(m.stampProgress.pending).filter((x) => done.has(x));
    if (both.length) {
      bad(`stampProgress lists the same id as done and pending: ${sortedRep(both)}`);
    }
  }

  // --- 12. timestamps must not go backwards (absolute time, not string order) ---
  const ca = m.createdAt;
  const ua = m.updatedAt;
  if (typeof ca === 'string' && typeof ua === 'string') {
    const caP = parseStamp(ca);
    const uaP = parseStamp(ua);
    if (caP === null || uaP === null) {
      bad(`createdAt/updatedAt must be RFC3339: got ${rep(ca)} / ${rep(ua)}`);
    } else if (!caP.hasOffset || !uaP.hasOffset) {
      bad('createdAt/updatedAt must carry a UTC offset (RFC3339)');
    } else if (uaP.ms < caP.ms) {
      bad(`updatedAt=${ua} precedes createdAt=${ca} (compared as absolute time)`);
    }
  }

  // --- 13. non-terminal phases must not carry terminal evidence ---
  if (!TERMINALS.has(phase)) {
    if (m.result !== null && m.result !== undefined) {
      bad(`phase=${rep(phase)} is not terminal but a durable result is present`);
    }
    if (m.error !== null && m.error !== undefined) {
      bad(`phase=${rep(phase)} is not terminal but a durable error is present`);
    }
  }

  // --- 14. tree hashes must MATCH: treeHash permanently excludes the commit
  // marker (plan section 0L.2), so a pure move cannot change the tree hash.
  if (kind === 'move' && m.beforeTreeHash && m.committedTreeHash
      && m.beforeTreeHash !== m.committedTreeHash) {
    bad(`beforeTreeHash=${m.beforeTreeHash.slice(0, 8)}... != `
      + `committedTreeHash=${m.committedTreeHash.slice(0, 8)}...; treeHash excludes `
      + '.evolve-op-commit.json, so a move must not change it (plan 0L.2). '
      + 'A mismatch means the tree content itself changed during the move');
  }

  // --- 15. terminal phases are mutually exclusive in their evidence ---
  const present = ['result', 'error', 'conflict']
    .filter((k) => m[k] !== null && m[k] !== undefined);
  if (has(TERMINAL_EVIDENCE, phase)) {
    const allowed = TERMINAL_EVIDENCE[phase];
    const extra = present.filter((k) => !allowed.includes(k));
    if (extra.length) {
      bad(`phase=${phase} must carry only ${allowed.length ? sortedRep(allowed) : 'none'}; `
        + `also found ${sortedRep(extra)}`, 'TERMINAL_EVIDENCE_EXCLUSIVITY');
    }
  }

  // --- 16. the durable receipt must describe THIS manifest's target ---
  if (isObj(res) && isObj(res.receipt)) {
    const rc = res.receipt;
    if (m.targetName && rc.targetName !== m.targetName) {
      bad(`result.receipt.targetName=${rep(rc.targetName)} != `
        + `manifest.targetName=${rep(m.targetName)}`);
    }
    if (m.finalPath && rc.finalPath !== null && rc.finalPath !== undefined
        && rc.finalPath !== m.finalPath) {
      bad(`result.receipt.finalPath=${rep(rc.finalPath)} != `
        + `manifest.finalPath=${rep(m.finalPath)}`);
    }
    const exp = m.expectedAfterContentHash;
    if (exp && rc.afterContentHash !== null && rc.afterContentHash !== undefined
        && rc.afterContentHash !== exp) {
      bad('result.receipt.afterContentHash != manifest.expectedAfterContentHash');
    }
    if (m.archiveId && rc.archiveId !== null && rc.archiveId !== undefined
        && rc.archiveId !== m.archiveId) {
      bad(`result.receipt.archiveId=${rep(rc.archiveId)} != `
        + `manifest.archiveId=${rep(m.archiveId)}`);
    }
  }

  // --- 17. protocol A/C markers must name the action their protocol implies ---
  if (isObj(marker)) {
    const want = PROTOCOL_MARKER_ACTIONS[m.protocol];
    if (want && !want.includes(marker.action)) {
      bad(`protocol ${m.protocol} marker.action must be one of `
        + `${sortedRep(want)}, got ${rep(marker.action)}`);
    }
  }

  // --- 18. a capability may only be spent on the action it was minted for ---
  if (isObj(cap)) {
    let want;
    if (kind === 'move') {
      want = { archive: ['skill-archive'], restore: ['skill-restore'] }[m.action];
    } else {
      want = PURPOSE_BY_OP.get(`${kind}|${m.protocol ?? 'null'}`)
        || PURPOSE_BY_OP.get(`${kind}|null`);
    }
    if (want && !want.includes(cap.purpose)) {
      bad(`capClaim.purpose=${rep(cap.purpose)} is not valid for `
        + `kind=${rep(kind)} action=${rep(m.action)}; expected one of ${sortedRep(want)}`);
    }
  }

  // --- 19. converge shape: exactly one target, at least two sources ---
  if (kind === 'converge') {
    const rs = arr(m.resources);
    const targets = rs.filter((r) => r.role === 'target');
    const srcs = rs.filter((r) => r.role === 'source');
    if (targets.length) {
      bad('converge resources[] must contain sources only; found '
        + `${targets.length} entry with role='target' (the target lives in .target)`);
    }
    if (srcs.length < 2) bad(`converge needs >= 2 sources, got ${srcs.length}`);
    if (isObj(m.target)) {
      if (m.target.role !== 'target') {
        bad(`manifest.target.role must be 'target', got ${rep(m.target.role)}`);
      }
      if (m.targetName && m.target.name !== m.targetName) {
        bad(`manifest.target.name=${rep(m.target.name)} != targetName=${rep(m.targetName)}`);
      }
    }
  }

  // --- 20. receipt and call identifiers must be unique within one manifest ---
  const rcs = arr(m.receiptClaims);
  for (const field of ['receiptId', 'callId']) {
    const vals = rcs.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
    if (new Set(vals).size !== vals.length) {
      const dupe = [...new Set(vals.filter((v) => vals.filter((x) => x === v).length > 1))];
      bad(`receiptClaims contain duplicate ${field}: ${sortedRep(dupe)}`);
    }
  }

  // --- 21. rotation cannot verify an asset it never scanned ---
  if (kind === 'rotation') {
    const scanned = new Set(arr(m.scannedAssets));
    const stray = [...new Set(arr(m.verifiedAssets))].filter((x) => !scanned.has(x));
    if (stray.length) {
      bad(`verifiedAssets not present in scannedAssets: ${sortedRep(stray)}`);
    }
  }

  // --- 22. resolution must release what the frozen op held, and not resolve itself ---
  if (kind === 'resolution') {
    if (m.resolvesOpId === opId) {
      bad("resolution.resolvesOpId must not be this manifest's own opId");
    }
    if (m.resolvedKind === 'resolution') {
      bad('a resolution cannot resolve another resolution (no chains)');
    }
    // releasedCapId may legitimately be null: 7 of the 14 branches can freeze
    // without ever holding a capability. Whether it must be set is decided by
    // the FROZEN operation, which only the cross-manifest validator can see.
    if (phase === 'COMPLETE' && !has(m, 'releasedCapId')) {
      bad('a COMPLETE resolution must record releasedCapId (null is allowed when the '
        + 'frozen operation held no capability, but the field must be present)');
    }
    if (isObj(cap) && m.releasedCapId === cap.capId) {
      bad('resolution must use its OWN capability, not the frozen one it releases '
        + `(${rep(cap.capId)})`);
    }
  }

  // --- 23. only a resolution may name a frozen operation ---
  if (kind !== 'resolution' && m.resolvesOpId !== null && m.resolvesOpId !== undefined) {
    bad(`kind=${rep(kind)} must not carry resolvesOpId (only resolution may)`);
  }

  // --- 24. a resolved terminal must record who resolved it, with what ---
  if (has(RESOLVED_PHASES, phase)) {
    const st = m.resolution;
    if (!isObj(st)) {
      bad(`phase=${phase} requires a resolution state object`);
    } else {
      if (st.status !== 'RESOLVED') {
        bad(`phase=${phase} requires resolution.status='RESOLVED', got ${rep(st.status)}`);
      }
      if (!st.resolutionOpId) {
        bad(`phase=${phase} requires resolution.resolutionOpId (who resolved it)`);
      }
      const want = RESOLVED_PHASES[phase];
      if (st.decision !== want) {
        bad(`phase=${phase} requires resolution.decision=${rep(want)}, `
          + `got ${rep(st.decision)}`, 'RESOLVED_DECISION_MISMATCH');
      }
      if (!st.resolvedAt) bad(`phase=${phase} requires resolution.resolvedAt`);
    }
    if (phase === 'RESOLVED_ROLLED_FORWARD' && (m.result === null || m.result === undefined)) {
      bad('RESOLVED_ROLLED_FORWARD means the mutation landed, so a durable result is '
        + 'required for idempotent replay', 'ROLL_FORWARD_MISSING_RECEIPT');
    }
  }

  // --- 25. CAS state must be internally consistent ---
  const st = m.resolution;
  if (isObj(st)) {
    const status = st.status;
    if (status === 'UNRESOLVED' && st.resolutionOpId) {
      bad('resolution.status=UNRESOLVED must not name a resolutionOpId');
    }
    if ((status === 'RESOLVING' || status === 'RESOLVED') && !st.resolutionOpId) {
      bad(`resolution.status=${status} requires resolutionOpId`);
    }
    if (status !== 'RESOLVED' && st.decision) {
      bad(`resolution.decision is only meaningful once RESOLVED (status=${status})`);
    }
    if (status === 'RESOLVING' && has(RESOLVED_PHASES, phase)) {
      bad(`phase=${phase} contradicts resolution.status=RESOLVING`);
    }
    // The hole that let rev17's leak come back: status=RESOLVED while the phase
    // is still CONFLICT/PARTIAL. The CAS then refuses every new resolution (409)
    // while authorization stays frozen at 'claimed' -> the operation can never be
    // unfrozen by anyone, which is exactly what resolution exists to prevent.
    if (status === 'RESOLVED') {
      const wantPhase = {
        'roll-forward': 'RESOLVED_ROLLED_FORWARD',
        rollback: 'RESOLVED_ROLLED_BACK',
        abandon: 'RESOLVED_ABANDONED',
      }[st.decision];
      if (phase === 'CONFLICT' || phase === 'PARTIAL') {
        bad(`resolution.status=RESOLVED but phase=${phase} is still frozen: the CAS `
          + 'would refuse every new resolution while authorization stays claimed, '
          + 'leaving the operation permanently unresolvable', 'RESOLVED_WITH_FROZEN_PHASE');
      } else if (wantPhase && phase !== wantPhase) {
        bad(`resolution.status=RESOLVED with decision=${rep(st.decision)} requires `
          + `phase=${wantPhase}, got ${phase}`, 'RESOLVED_PHASE_DECISION_MISMATCH');
      }
    }
  }

  return errs;
}
