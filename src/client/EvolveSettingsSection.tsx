/**
 * "dsh-evolve" settings section — a complete settings page with three blocks:
 *
 *  1. LLM refinement: on/off toggle + model dropdown (configured models from the
 *     host via ctx.llm; empty selection = follow DSH's current main model). The
 *     open/close effect is spelled out next to the toggle.
 *  2. Approval queue: lists pending memories (importance-sorted) + a batch-confirm
 *     button — the human-approval convenience entry.
 *  3. Overview: memory stats (totals / by-kind / most-injected) + skill stats
 *     (active/stale/archived) + outcome-triage summary.
 *
 * All data comes from the host's same-origin /api/evolve/* routes (loopback
 * fenced). The component owns its own polling + POSTs.
 */

import { useCallback, useEffect, useState } from 'react'

// The SAME table the host uses (lib/i18n.js). Not external in tsdown.config.ts, so it
// is bundled into lib/client.js -- one table, so the page and the injected prompt
// anchors can never disagree about a language.
import { t as translate, FALLBACK_LANGUAGE } from '../../lib/i18n.js'

const API = '/api/evolve'

interface ModelRow { provider: string; model: string }
interface PendingRow { id: string; kind: string; importance: number; content: string; sourceContext?: string }
/** A memory the user threw away. Kept forever; restorable by hand. */
interface RejectedRow { id: string; kind: string; importance: number; content: string; rejectedAt: string | null }
/** Looks like ours but not bound to this installation; needs explicit claiming. */
interface UnclaimedSkill { name: string; tag: string | null; version: string | null; createdAt: string | null }
interface SkillProposal { id:string; action:string; targetSkill:string; state:string; createdAt:string; description?:string }
interface InjRow { id: string; kind: string; importance: number; injectionCount: number; content: string }
interface TriageSkill { loaded: number; succeeded: number; errored: number }
interface PruneMemCand {
  entityType: 'memory'; id: string; kind?: string; importance: number
  heat?: number; injectionCount?: number; observationCount?: number
  pinned: boolean; protectedKind: boolean; reason: string
  allowedActions: string[]; etag: string | null; content: string
}
interface PruneSkillCand { entityType: 'skill'; kind: string; names: string[]; similarity?: number; zeroLoadCount?: number; allowedActions: string[] }
interface ProtectedRow { id: string; kind: string; importance: number; content: string }
interface ForgottenRow { id: string; kind: string; content: string }
interface PruneState {
  ok: boolean
  budget: { enabled: boolean; used?: number; max?: number; overBudget?: boolean }
  memoryCandidates: PruneMemCand[]
  protectedReview: ProtectedRow[]
  skillCandidates: PruneSkillCand[]
  forgotten: ForgottenRow[]
}
interface EvolveState {
  ok: boolean
  /** Resolved by the HOST (host locale + this plugin's override). See lib/i18n.js. */
  language?: string
  config: {
    refineLLM: boolean; refineProvider: string; refineModel: string; tier1Enabled: boolean
    approvalMode: 'manual' | 'balanced' | 'autonomous'
    reviewMaxAutoPerTurn: number; maxPendingQueue: number
    disposalMode: 'manual' | 'suggest' | 'tidy'
    disposalMinIdleDays: number; tidyMaxPerRun: number; idleMinutes: number
    skillProposalMode: 'inherit'|'manual'|'balanced'|'autonomous'; skillAutoMaxChars:number; skillMaxChars:number
    approvalPromptEnabled:boolean; approvalPromptMaxPerTurn:number
  }
  models: ModelRow[]
  memoryStats: {
    total: number; confirmed: number; pending: number; maxRecords: number
    byKind: Record<string, number>
    topByInjection: InjRow[]
    pendingQueue: PendingRow[]
    rejected?: number
  }
  rejectedQueue?: RejectedRow[]
  unclaimedSkills?: UnclaimedSkill[]
  proposals?: SkillProposal[]
  skillStats: {
    counts: { active: number; stale: number; archived: number }
    triage?: { totalTurns: number; successes: number; failures: number; bySkill: Record<string, TriageSkill> } | { disabled: true }
  }
  retrieval?: {
    mode: string; ftsEnabled: boolean; ftsAvailable: boolean
    lastPath?: string; fusedCount?: number; bigramOnlyCount?: number; ftsErrorCount?: number
  }
  disposalSuggest?: {
    mode: string; computedAt: number
    candidates: Array<{ id: string; kind: string; importance: number; content: string; ageDays: number; reason: string }>
  }
}

/** A CONFLICT/PARTIAL operation waiting for a human decision. */
interface FrozenOperation {
  opId: string
  kind: string
  phase: string
  targetName: string | null
  conflict: { code?: string; message?: string; resources?: string[] } | null
  observedConflictHash: string | null
  resolution: { status: string; decision?: string | null }
  updatedAt: string
}

interface SkillArchive {
  archiveId: string
  logicalSkillName: string
  archivedAt?: string
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return (await res.json()) as T
}
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return (await res.json()) as T
}

const box: React.CSSProperties = { border: '1px solid var(--dsh-border, #333)', borderRadius: 8, padding: 12, marginBottom: 12 }
const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--dsh-border, #444)', cursor: 'pointer', marginRight: 8 }
const btnPrimary: React.CSSProperties = { ...btn, background: 'var(--dsh-accent, #2563eb)', color: '#fff', border: 'none' }
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 12 }
const dim: React.CSSProperties = { opacity: 0.7, fontSize: 13 }
const btnTiny: React.CSSProperties = { ...btn, padding: '2px 8px', fontSize: 11, marginRight: 0 }

interface OwnerProps { close: () => void }

export function EvolveSettingsSection(_props: OwnerProps): React.ReactElement {
  const [state, setState] = useState<EvolveState | null>(null)
  const [note, setNote] = useState<string>('')
  const [saving, setSaving] = useState(false)

  // Language comes from /state, resolved once on the host. Before the first poll
  // lands there is no answer yet, so fall back rather than guessing from the browser:
  // a page that briefly renders the wrong language then switches is worse than one
  // that starts in English.
  const lang = state?.language ?? FALLBACK_LANGUAGE
  const t = useCallback(
    (key: string, vars?: Record<string, unknown>) => translate(lang, key, vars),
    [lang],
  )

  const refresh = useCallback(async () => {
    try { setState(await apiGet<EvolveState>(`${API}/state`)) } catch (e) { setNote(String(e)) }
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => { void refresh() }, 8000)
    return () => window.clearInterval(t)
  }, [refresh])

  const setConfig = useCallback(async (patch: Record<string, unknown>) => {
    setSaving(true); setNote('')
    try {
      await apiPost(`${API}/action`, { action: 'set-config', ...patch })
      await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refresh])

  const confirmBatch = useCallback(async () => {
    setSaving(true); setNote('')
    try {
      const r = await apiPost<{ confirmed: number }>(`${API}/action`, { action: 'confirm-batch' })
      setNote(t('ui.note.batchConfirmed', { count: r.confirmed }))
      await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refresh, t])

  // U1: the discard channel. Without it the queue could only grow -- a wrongly
  // captured memory could be confirmed or ignored, nothing else -- and once it
  // hit maxPendingQueue new memories were dropped at the door.
  const rejectOne = useCallback(async (id: string) => {
    setSaving(true); setNote('')
    try {
      const cap=await apiPost<{capId:string}>(`${API}/capability/mint`,{purpose:'memory-discard',target:{ids:[id]}})
      const r = await apiPost<{ rejected: number }>(`${API}/memory/discard`, { ids: [id], capId:cap.capId, opId:`discard_${Date.now().toString(36)}` })
      setNote(r.rejected > 0 ? t('ui.note.discarded') : t('ui.note.memoryNotFound'))
      await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refresh, t])

  const restoreOne = useCallback(async (id: string) => {
    setSaving(true); setNote('')
    try {
      const cap=await apiPost<{capId:string}>(`${API}/capability/mint`,{purpose:'memory-restore-rejected',target:{ids:[id]}})
      const r = await apiPost<{ restored: number }>(`${API}/memory/restore-rejected`, { ids: [id], capId:cap.capId, opId:`restore_${Date.now().toString(36)}` })
      setNote(r.restored > 0 ? t('ui.note.restoredToPending') : t('ui.note.memoryNotFound'))
      await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refresh, t])

  const claimSkills = useCallback(async (names: string[]) => {
    setSaving(true); setNote('')
    try {
      const r = await apiPost<{ claimed: number }>(`${API}/action`, { action: 'claim-legacy-skills', names })
      setNote(r.claimed > 0 ? t('ui.note.claimed', { count: r.claimed }) : t('ui.note.nothingToClaim'))
      await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refresh, t])

  const proposalAction = useCallback(async (id:string, action:'apply'|'reject') => {
    setSaving(true); setNote('')
    try { const cap=await apiPost<{capId:string}>(`${API}/capability/mint`, {purpose:`proposal-${action}`,target:{proposalId:id}}); const r=await apiPost<{status:string;reason?:string}>(`${API}/proposals/${id}/${action}`, {opId:`${action}_${Date.now().toString(36)}`,capId:cap.capId}); setNote(r.reason?`${r.status}: ${r.reason}`:t('ui.note.proposalDone', { status: r.status })); await refresh() }
    catch(e){setNote(String(e))} finally{setSaving(false)}
  },[refresh, t])

  // ── v0.4.2 controlled prune ──
  const [frozenOps, setFrozenOps] = useState<FrozenOperation[]>([])
  const [archives, setArchives] = useState<SkillArchive[]>([])
  const loadOperations = useCallback(async () => {
    try {
      const r = await apiGet<{ operations: FrozenOperation[] }>(`${API}/operations`)
      setFrozenOps(r.operations ?? [])
    } catch { /* the panel is advisory; a failure must not blank the page */ }
  }, [])
  const loadArchives = useCallback(async () => {
    try {
      const r = await apiGet<{ archives: SkillArchive[] }>(`${API}/skills/archives`)
      setArchives(r.archives ?? [])
    } catch { /* same */ }
  }, [])
  /**
   * Resolve a frozen operation.
   *
   * observedConflictHash is sent back exactly as it was rendered, so a decision
   * made against a conflict that has since changed is refused by the server
   * rather than applied to a different state.
   */
  const resolveOp = useCallback(async (op: FrozenOperation, decision: string) => {
    setSaving(true)
    try {
      const cap = await apiPost<{ capId: string }>(`${API}/capability/mint`, {
        purpose: 'operation-resolve',
        target: {
          resolvesOpId: op.opId, resolvedKind: op.kind,
          observedConflictHash: op.observedConflictHash, decision,
        },
      })
      const r = await apiPost<{ ok: boolean; status: string; reason?: string }>(
        `${API}/operations/${op.opId}/resolve`,
        { decision, resolvedKind: op.kind, observedConflictHash: op.observedConflictHash, capId: cap.capId },
      )
      setNote(r.reason
        ? `${r.status}: ${r.reason}`
        : t(decision === 'ROLL_FORWARD' ? 'ui.note.opRolledForward' : 'ui.note.opRolledBack', { opId: op.opId }))
      await loadOperations()
    } catch (e) { setNote(`❌ ${(e as Error).message}`) }
    finally { setSaving(false) }
  }, [loadOperations, t])
  const restoreArchive = useCallback(async (a: SkillArchive) => {
    setSaving(true)
    try {
      const cap = await apiPost<{ capId: string }>(`${API}/capability/mint`, {
        purpose: 'skill-restore',
        target: { archiveId: a.archiveId, logicalSkillName: a.logicalSkillName },
      })
      const r = await apiPost<{ ok: boolean; status: string; reason?: string; name?: string }>(
        `${API}/skills/restore`,
        { archiveId: a.archiveId, logicalSkillName: a.logicalSkillName, capId: cap.capId, opId: `restore_${Date.now().toString(36)}` },
      )
      setNote(r.reason
        ? `${r.status}: ${r.reason}`
        : t('ui.note.skillRestored', { name: r.name ?? a.logicalSkillName }))
      await loadArchives()
    } catch (e) { setNote(`❌ ${(e as Error).message}`) }
    finally { setSaving(false) }
  }, [loadArchives, t])
  const proposeRollback = useCallback(async (name: string) => {
    setSaving(true)
    try {
      const cap = await apiPost<{ capId: string }>(`${API}/capability/mint`, {
        purpose: 'rollback-proposal-create', target: { logicalSkillName: name },
      })
      const r = await apiPost<{ ok: boolean; status: string; reason?: string; proposalId?: string }>(
        `${API}/skills/rollback-proposal`,
        { name, capId: cap.capId, opId: `rbp_${Date.now().toString(36)}` },
      )
      // Deliberately a proposal, never a rollback: extracting over a live
      // directory has to be reviewed before it runs.
      setNote(r.reason
        ? `${r.status}: ${r.reason}`
        : t('ui.note.rollbackProposalCreated', { id: r.proposalId }))
      await refresh()
    } catch (e) { setNote(`❌ ${(e as Error).message}`) }
    finally { setSaving(false) }
  }, [refresh, t])
  const [prune, setPrune] = useState<PruneState | null>(null)
  const [selMem, setSelMem] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<{ planDigest: string; preview: Array<{ action: string; count: number; allowed: boolean; reason: string; requires?: string }> } | null>(null)

  const refreshPrune = useCallback(async () => {
    try { setPrune(await apiGet<PruneState>(`${API}/prune`)) } catch (e) { /* keep last */ }
  }, [])
  useEffect(() => { void refreshPrune(); const t = window.setInterval(() => { void refreshPrune() }, 8000); return () => window.clearInterval(t) }, [refreshPrune])
  useEffect(() => {
    void loadOperations(); void loadArchives()
    const t = window.setInterval(() => { void loadOperations() }, 8000)
    return () => window.clearInterval(t)
  }, [loadOperations, loadArchives])

  const toggleMem = useCallback((id: string) => { setSelMem((m) => ({ ...m, [id]: !m[id] })) }, [])

  // Stage 1: preview the selected forgets (read-only, gets a planDigest).
  const doPreview = useCallback(async () => {
    if (!prune) return
    const ids = prune.memoryCandidates.filter((c) => selMem[c.id] && c.allowedActions.includes('memory-forget')).map((c) => c.id)
    if (ids.length === 0) { setNote(t('ui.note.noSelectableMemories')); return }
    setSaving(true); setNote('')
    try {
      const r = await apiPost<typeof preview>(`${API}/prune/preview`, { selection: { decisions: [{ action: 'memory-forget', entityType: 'memory', memoryIds: ids, reason: 'panel prune' }] } })
      setPreview(r)
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [prune, selMem, t])

  // Stage 2: execute the previewed plan (idempotent via planDigest).
  const doExecute = useCallback(async () => {
    if (!preview?.planDigest) return
    setSaving(true); setNote('')
    try {
      const r = await apiPost<{ status: string; applied?: unknown[]; skipped?: Array<{ target: string; reason: string }> }>(`${API}/prune/execute`, { planDigest: preview.planDigest })
      if (r.status === 'plan-expired') setNote(t('ui.note.planExpired'))
      else {
        const skipped = (r.skipped?.length ?? 0) > 0
          ? t('ui.note.pruneSkippedSuffix', {
            count: r.skipped!.length,
            details: r.skipped!.map((s) => `${s.target}:${s.reason}`).join('; '),
          })
          : ''
        setNote(t('ui.note.pruneDone', { count: r.applied?.length ?? 0, skipped }))
      }
      setPreview(null); setSelMem({})
      await refreshPrune(); await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [preview, refreshPrune, refresh, t])

  const doRestore = useCallback(async (id: string) => {
    setSaving(true); setNote('')
    try {
      const r = await apiPost<typeof preview>(`${API}/prune/preview`, { selection: { decisions: [{ action: 'memory-restore', entityType: 'memory', memoryIds: [id], reason: 'restore' }] } })
      // restore goes straight through (reversible, low-risk) — reuse execute
      if (r?.planDigest) await apiPost(`${API}/prune/execute`, { planDigest: r.planDigest })
      setNote(t('ui.note.restored'))
      await refreshPrune(); await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refreshPrune, refresh, t])

  const s = state
  const cfg = s?.config
  const triage = s?.skillStats?.triage
  const triageOn = triage && !('disabled' in triage)

  // The model dropdown value: "" means follow-main; otherwise "provider\u0000model".
  const currentModelKey = cfg && cfg.refineProvider && cfg.refineModel ? `${cfg.refineProvider}\u0000${cfg.refineModel}` : ''

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>dsh-evolve</h2>
      <p style={dim}>{t('ui.page.subtitle')}</p>

      {/* ── Block 1: LLM refinement ── */}
      <div style={box}>
        <b>{t('ui.llm.title')}</b>
        <div style={{ marginTop: 8 }}>
          <label style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cfg?.refineLLM ?? false}
              disabled={saving || !cfg}
              onChange={(e) => void setConfig({ refineLLM: e.target.checked })}
            />{' '}
            {t('ui.llm.enable')}
          </label>
        </div>
        <div style={{ ...dim, marginTop: 6 }}>
          <div><b>{t('ui.llm.onLabel')}</b>{t('ui.llm.onDesc')}</div>
          <div style={{ marginTop: 4 }}><b>{t('ui.llm.offLabel')}</b>{t('ui.llm.offDesc1')}<b>{t('ui.llm.offZeroToken')}</b>{t('ui.llm.offDesc2')}</div>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={dim}>{t('ui.llm.modelLabel')}</div>
          <select
            style={{ marginTop: 4, minWidth: 320, padding: 4 }}
            value={currentModelKey}
            disabled={saving || !cfg}
            onChange={(e) => {
              const v = e.target.value
              if (v === '') void setConfig({ refineProvider: '', refineModel: '' })
              else { const [provider, model] = v.split('\u0000'); void setConfig({ refineProvider: provider, refineModel: model }) }
            }}
          >
            <option value="">{t('ui.llm.followMain')}</option>
            {(s?.models ?? []).map((m) => (
              <option key={`${m.provider}\u0000${m.model}`} value={`${m.provider}\u0000${m.model}`}>
                {m.provider} / {m.model}
              </option>
            ))}
          </select>
          <div style={{ ...dim, marginTop: 4 }}>
            {t('ui.llm.modelHint')}
          </div>
        </div>
      </div>

      {/* ── Block 1.5: 摄入自治程度 (v0.5.0 direction 1) ── */}
      <div style={box}>
        <b>{t('ui.ingest.title')}</b>
        <div style={dim}>{t('ui.ingest.desc')}</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            ['manual', t('ui.ingest.manualLabel'), t('ui.ingest.manualDesc')],
            ['balanced', t('ui.ingest.balancedLabel'), t('ui.ingest.balancedDesc')],
            ['autonomous', t('ui.ingest.autonomousLabel'), t('ui.ingest.autonomousDesc')],
          ] as const).map(([mode, label, desc]) => {
            const active = (cfg?.approvalMode ?? 'balanced') === mode
            return (
              <button
                key={mode}
                style={{ ...(active ? btnPrimary : btn), marginRight: 0, flex: '1 1 200px', textAlign: 'left', padding: 10, opacity: saving ? 0.6 : 1 }}
                disabled={saving || !cfg}
                onClick={() => void setConfig({ approvalMode: mode })}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{active ? '● ' : '○ '}{label}</div>
                <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>{desc}</div>
              </button>
            )
          })}
        </div>
        {cfg?.approvalMode === 'autonomous' && (
          <div style={{ ...dim, marginTop: 8, color: 'var(--dsh-warn, #b45309)' }}>
            {t('ui.ingest.autonomousWarn', { perTurn: cfg?.reviewMaxAutoPerTurn ?? 5, queueMax: cfg?.maxPendingQueue ?? 50 })}
          </div>
        )}
      </div>

      <div style={box}>
        <b>{t('ui.skillApproval.title')}</b>
        <div style={dim}>{t('ui.skillApproval.desc')}</div>
        <select value={cfg?.skillProposalMode ?? 'inherit'} disabled={saving||!cfg} onChange={(e)=>void setConfig({skillProposalMode:e.target.value})} style={{marginTop:8,padding:6}}>
          <option value="inherit">{t('ui.skillApproval.inherit', { mode: cfg?.approvalMode ?? 'balanced' })}</option><option value="manual">{t('ui.skillApproval.manual')}</option><option value="balanced">{t('ui.skillApproval.balanced')}</option><option value="autonomous">{t('ui.skillApproval.autonomous')}</option>
        </select>
        <div style={{marginTop:8,fontSize:12}}>
          {t('ui.skillApproval.manualCharsPrefix')}<input type="number" min={1000} max={500000} value={cfg?.skillMaxChars ?? 40000} disabled={saving} onChange={e=>void setConfig({skillMaxChars:Number(e.target.value)})} style={{width:90}} />{t('ui.skillApproval.manualCharsSuffix')}
          {t('ui.skillApproval.autoCharsPrefix')}<input type="number" min={1000} max={200000} value={cfg?.skillAutoMaxChars ?? 10000} disabled={saving} onChange={e=>void setConfig({skillAutoMaxChars:Number(e.target.value)})} style={{width:90}} />{t('ui.skillApproval.autoCharsSuffix')}
        </div>
        <label style={{display:'block',marginTop:10}}><input type="checkbox" checked={cfg?.approvalPromptEnabled ?? false} disabled={saving} onChange={e=>void setConfig({approvalPromptEnabled:e.target.checked})}/>{t('ui.skillApproval.promptToggle')}</label>
        <div style={dim}>{t('ui.skillApproval.promptDescPrefix')}<input type="number" min={0} max={10} value={cfg?.approvalPromptMaxPerTurn ?? 1} disabled={saving} onChange={e=>void setConfig({approvalPromptMaxPerTurn:Number(e.target.value)})} style={{width:48}}/>{t('ui.skillApproval.promptDescSuffix')}</div>
      </div>
      {frozenOps.length>0 ? <div style={{...box, borderColor:'#b45309'}}>
        <b>{t('ui.frozenOps.title', { count: frozenOps.length })}</b>
        <div style={dim}>
          {t('ui.frozenOps.desc')}
        </div>
        <table style={{width:'100%',marginTop:8,...mono}}><tbody>{frozenOps.map(op=><tr key={op.opId}>
          <td style={{verticalAlign:'top'}}>{op.kind}</td>
          <td style={{verticalAlign:'top'}}>{op.targetName ?? '—'}</td>
          <td style={{verticalAlign:'top'}}>
            {op.phase}
            {op.conflict?.message ? <div style={{...dim,marginTop:2}}>{op.conflict.message}</div> : null}
          </td>
          <td style={{textAlign:'right',whiteSpace:'nowrap',verticalAlign:'top'}}>
            {op.resolution?.status==='RESOLVED'
              ? <span style={dim}>{t('ui.frozenOps.resolved', { decision: op.resolution.decision })}</span>
              : <>
                  <button style={btnTiny} disabled={saving} onClick={()=>void resolveOp(op,'ROLL_FORWARD')}>{t('ui.op.rollForwardBtn')}</button>{' '}
                  <button style={btnTiny} disabled={saving} onClick={()=>void resolveOp(op,'ROLL_BACK')}>{t('ui.op.rollBackBtn')}</button>
                </>}
          </td>
        </tr>)}</tbody></table>
      </div> : null}
      {s?.proposals && s.proposals.length>0 ? <div style={box}>
        <b>{t('ui.proposals.title', { count: s.proposals.length })}</b><div style={dim}>{t('ui.proposals.desc')}</div>
        <table style={{width:'100%',marginTop:8,...mono}}><tbody>{s.proposals.map(p=><tr key={p.id}><td>{p.action}</td><td>{p.targetSkill}</td><td>{p.state}</td><td style={{textAlign:'right',whiteSpace:'nowrap'}}>{p.state==='pending'?<><button style={btnTiny} disabled={saving} onClick={()=>void proposalAction(p.id,'apply')}>{t('ui.proposals.apply')}</button>{' '}<button style={btnTiny} disabled={saving} onClick={()=>void proposalAction(p.id,'reject')}>{t('ui.proposals.reject')}</button></>:null}</td></tr>)}</tbody></table>
      </div>:null}

      {/* ── Block 2: Approval queue ── */}
      <div style={box}>
        <b>{t('ui.pending.title')}</b>
        <div style={dim}>{t('ui.pending.desc')}</div>
        {s && s.memoryStats.pendingQueue.length > 0 ? (
          <>
            <table style={{ width: '100%', marginTop: 8, ...mono }}>
              <tbody>
                {s.memoryStats.pendingQueue.map((r) => (
                  <tr key={r.id} style={{ verticalAlign: 'top' }}>
                    <td style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>[{r.kind}/imp{r.importance}]</td>
                    <td style={{ paddingLeft: 8 }}>
                      <div>{r.content}</div>
                      {r.sourceContext ? (
                        <div style={{ ...dim, fontSize: 11, marginTop: 2, borderLeft: '2px solid var(--dsh-border, #444)', paddingLeft: 6 }}>
                          {t('ui.pending.source')}{r.sourceContext}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button style={btnTiny} disabled={saving} onClick={() => void rejectOne(r.id)} title={t('ui.pending.discardTitle')}>
                        {t('ui.pending.discard')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button style={{ ...btnPrimary, marginTop: 10 }} disabled={saving} onClick={() => void confirmBatch()}>
              {t('ui.pending.confirmAll', { count: s.memoryStats.pendingQueue.length })}
            </button>
          </>
        ) : <div style={{ ...dim, marginTop: 8 }}>{t('ui.pending.empty')}</div>}
      </div>

      {/* ── Block 2.1: 已拒绝（U1 的恢复入口） ── */}
      {s?.rejectedQueue && s.rejectedQueue.length > 0 ? (
        <div style={box}>
          <b>{t('ui.rejected.title', { count: s.rejectedQueue.length })}</b>
          <div style={dim}>
            {t('ui.rejected.desc')}
          </div>
          <table style={{ width: '100%', marginTop: 8, ...mono }}>
            <tbody>
              {s.rejectedQueue.map((r) => (
                <tr key={r.id} style={{ verticalAlign: 'top' }}>
                  <td style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>[{r.kind}/imp{r.importance}]</td>
                  <td style={{ paddingLeft: 8 }}>{r.content}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button style={btnTiny} disabled={saving} onClick={() => void restoreOne(r.id)} title={t('ui.rejected.restoreTitle')}>
                      {t('ui.common.restore')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ── Block 2.1b: 待认领 skill（ownership 绑定） ── */}
      {s?.unclaimedSkills && s.unclaimedSkills.length > 0 ? (
        <div style={box}>
          <b>{t('ui.unclaimed.title', { count: s.unclaimedSkills.length })}</b>
          <div style={dim}>
            {t('ui.unclaimed.desc')}
          </div>
          <table style={{ width: '100%', marginTop: 8, ...mono }}>
            <tbody>
              {s.unclaimedSkills.map((k) => (
                <tr key={k.name} style={{ verticalAlign: 'top' }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{k.name}</td>
                  <td style={{ paddingLeft: 8, opacity: 0.6 }}>
                    {k.tag ? `tag: ${k.tag}` : ''}{k.version ? ` · v${k.version}` : ''}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button style={btnTiny} disabled={saving} onClick={() => void claimSkills([k.name])} title={t('ui.unclaimed.claimTitle')}>
                      {t('ui.unclaimed.claim')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            style={{ ...btn, marginTop: 10 }}
            disabled={saving}
            onClick={() => void claimSkills((s.unclaimedSkills ?? []).map((k) => k.name))}
          >
            {t('ui.unclaimed.claimAll', { count: s.unclaimedSkills.length })}
          </button>
        </div>
      ) : null}

      {/* ── Block 2.2: 检索健康度 (v0.5.0 R5) ── */}
      {s?.retrieval ? (
        <div style={box}>
          <b>{t('ui.retrieval.title')}</b>
          <div style={{ ...mono, marginTop: 8 }}>
            {s.retrieval.mode === 'fused' ? (
              <span style={{ color: '#16a34a' }}>{t('ui.retrieval.fused')}</span>
            ) : s.retrieval.mode === 'bigram-only' ? (
              <span style={{ color: 'var(--dsh-warn, #b45309)' }}>{t('ui.retrieval.bigramOnly')}</span>
            ) : s.retrieval.mode === 'fts-degraded' ? (
              <span style={{ color: '#dc2626' }}>{t('ui.retrieval.degraded', { errors: s.retrieval.ftsErrorCount ?? 0 })}</span>
            ) : (
              <span style={dim}>{t('ui.retrieval.unknown')}</span>
            )}
          </div>
          <div style={{ ...dim, fontSize: 12, marginTop: 4 }}>
            {t('ui.retrieval.indexLine', {
              enabled: s.retrieval.ftsEnabled ? t('ui.retrieval.enabled') : t('ui.retrieval.disabled'),
              available: s.retrieval.ftsAvailable ? t('ui.retrieval.available') : t('ui.retrieval.unavailable'),
            })}
            {typeof s.retrieval.fusedCount === 'number'
              ? t('ui.retrieval.counts', { fused: s.retrieval.fusedCount, degraded: s.retrieval.bigramOnlyCount ?? 0 })
              : ''}
          </div>
        </div>
      ) : null}

      {/* ── Block 2.4: 处置自治程度 (v0.5.0 direction 2) ── */}
      <div style={box}>
        <b>{t('ui.disposal.title')}</b>
        <div style={dim}>{t('ui.disposal.desc')}</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            ['manual', t('ui.disposal.manual'), t('ui.disposal.manualDesc')],
            ['suggest', t('ui.disposal.suggest'), t('ui.disposal.suggestDesc')],
            ['tidy', t('ui.disposal.tidy'), t('ui.disposal.tidyDesc')],
          ] as const).map(([mode, label, desc]) => {
            const active = (cfg?.disposalMode ?? 'manual') === mode
            return (
              <button
                key={mode}
                style={{ ...(active ? btnPrimary : btn), marginRight: 0, flex: '1 1 220px', textAlign: 'left', padding: 10, opacity: saving ? 0.6 : 1 }}
                disabled={saving || !cfg}
                onClick={() => void setConfig({ disposalMode: mode })}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{active ? '● ' : '○ '}{label}</div>
                <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 400 }}>{desc}</div>
              </button>
            )
          })}
        </div>
        {(cfg?.disposalMode === 'suggest' || cfg?.disposalMode === 'tidy') ? (
          <label style={{ display: 'block', marginTop: 10 }}>
            {t('ui.disposal.idleLabel')}
            <input type="number" min={1} max={1440}
              style={{ width: 80, marginLeft: 8, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--dsh-border, #444)' }}
              value={cfg.idleMinutes ?? 5} disabled={saving}
              onChange={(e) => void setConfig({ idleMinutes: Number(e.target.value) })}
            />{t('ui.disposal.minutes')}
          </label>
        ) : null}
        {cfg?.disposalMode === 'tidy' ? (
          <label style={{ display: 'block', marginTop: 10 }}>
            {t('ui.disposal.maxPerRunLabel')}
            <input
              type="number" min={1} max={100}
              style={{ width: 80, marginLeft: 8, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--dsh-border, #444)' }}
              value={cfg.tidyMaxPerRun ?? 5}
              disabled={saving}
              onChange={(e) => void setConfig({ tidyMaxPerRun: Number(e.target.value) })}
            />{t('ui.disposal.items')}
          </label>
        ) : null}
        {(cfg?.disposalMode === 'suggest' || cfg?.disposalMode === 'tidy') && s?.disposalSuggest ? (
          <div style={{ marginTop: 10 }}>
            <div style={dim}>{t('ui.disposal.coolingLine', {
              days: cfg?.disposalMinIdleDays ?? 30,
              computed: s.disposalSuggest.computedAt
                ? t('ui.disposal.computedAt', { when: new Date(s.disposalSuggest.computedAt).toLocaleString() })
                : t('ui.disposal.notYetComputed'),
            })}</div>
            {s.disposalSuggest.candidates.length > 0 ? (
              <table style={{ width: '100%', marginTop: 6, ...mono }}>
                <tbody>
                  {s.disposalSuggest.candidates.map((c) => (
                    <tr key={c.id} style={{ verticalAlign: 'top' }}>
                      <td style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>[{c.kind}/imp{c.importance}]</td>
                      <td style={{ paddingLeft: 8 }}>
                        <div>{c.content}</div>
                        <div style={{ ...dim, fontSize: 11 }}>{t('ui.disposal.candidateMeta', { days: c.ageDays, reason: c.reason })}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div style={{ ...dim, marginTop: 6 }}>{t('ui.disposal.noCandidates')}</div>}
            <div style={{ ...dim, fontSize: 12, marginTop: 6 }}>{t('ui.disposal.cleanupHint')}</div>
          </div>
        ) : null}
      </div>

      {/* ── Block 2.5: Controlled prune (v0.4.2) ── */}
      <div style={box}>
        <b>{t('ui.prune.title')}</b>
        <div style={dim}>{t('ui.prune.desc')}</div>

        {/* budget bar */}
        {prune?.budget?.enabled ? (
          <div style={{ ...mono, marginTop: 8, color: prune.budget.overBudget ? '#dc2626' : undefined }}>
            {t('ui.prune.budget', {
              used: prune.budget.used,
              max: prune.budget.max,
              over: prune.budget.overBudget ? t('ui.prune.overBudget') : '',
            })}
          </div>
        ) : null}

        {/* memory candidates (checkbox + heat badges) */}
        <div style={{ marginTop: 10 }}><b style={{ fontSize: 13 }}>{t('ui.prune.memTitle')}</b></div>
        {prune && prune.memoryCandidates.length > 0 ? (
          <table style={{ width: '100%', marginTop: 6, ...mono }}>
            <tbody>
              {prune.memoryCandidates.map((c) => {
                const canForget = c.allowedActions.includes('memory-forget')
                return (
                  <tr key={c.id}>
                    <td style={{ width: 24, verticalAlign: 'top' }}>
                      <input type="checkbox" checked={!!selMem[c.id]} disabled={!canForget || saving} onChange={() => toggleMem(c.id)} />
                    </td>
                    <td>
                      <div>{c.content}</div>
                      <div style={{ ...dim, fontSize: 11 }}>
                        {c.pinned ? <span style={{ color: '#f59e0b' }}>PINNED </span> : null}
                        {c.kind ? `[${c.kind}/imp${c.importance}] ` : ''}
                        {typeof c.heat === 'number' ? t('ui.prune.heat', { heat: c.heat }) : ''}
                        {typeof c.injectionCount === 'number' ? t('ui.prune.injected', { count: c.injectionCount }) : ''}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : <div style={{ ...dim, marginTop: 6 }}>{t('ui.prune.noCandidates')}</div>}

        {/* preview -> execute two-stage */}
        {prune && prune.memoryCandidates.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            {!preview ? (
              <button style={btn} disabled={saving} onClick={() => void doPreview()}>{t('ui.prune.previewBtn')}</button>
            ) : (
              <div style={{ border: '1px dashed var(--dsh-border,#555)', borderRadius: 6, padding: 8 }}>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('ui.prune.previewTitle')}</div>
                <table style={{ width: '100%', ...mono, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ ...dim, textAlign: 'left', borderBottom: '1px solid var(--dsh-border,#444)' }}>
                      <th style={{ padding: '2px 6px' }}>{t('ui.prune.colAction')}</th>
                      <th style={{ padding: '2px 6px' }}>{t('ui.prune.colCount')}</th>
                      <th style={{ padding: '2px 6px' }}>{t('ui.prune.colResult')}</th>
                      <th style={{ padding: '2px 6px' }}>{t('ui.prune.colNote')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--dsh-border,#2a2a2a)' }}>
                        <td style={{ padding: '2px 6px' }}>{p.action}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right' }}>{p.count}</td>
                        <td style={{ padding: '2px 6px', color: p.allowed ? '#16a34a' : '#b45309' }}>{p.allowed ? t('ui.prune.willRun') : t('ui.prune.skipped')}</td>
                        <td style={{ padding: '2px 6px', ...dim }}>{p.allowed ? '' : p.reason}{p.requires ? t('ui.prune.requires', { what: p.requires }) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 8 }}>
                  <button style={btnPrimary} disabled={saving} onClick={() => void doExecute()}>{t('ui.prune.confirmBtn')}</button>
                  <button style={btn} disabled={saving} onClick={() => setPreview(null)}>{t('ui.prune.cancelBtn')}</button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* protected-kind review area (read-only, no forget) */}
        {prune && prune.protectedReview.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <b style={{ fontSize: 13 }}>{t('ui.prune.protectedTitle')}</b>
            <div style={dim}>{t('ui.prune.protectedDesc')}</div>
            {prune.protectedReview.map((r) => (
              <div key={r.id} style={{ ...mono, paddingLeft: 12, opacity: 0.8 }}>· [{r.kind}] {r.content}</div>
            ))}
          </div>
        ) : null}

        {/* skill merge candidates */}
        {prune && prune.skillCandidates.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <b style={{ fontSize: 13 }}>{t('ui.prune.convergeTitle')}</b>
            {prune.skillCandidates.map((sc, i) => (
              <div key={i} style={{ ...mono, paddingLeft: 12, opacity: 0.85 }}>
                {t('ui.prune.convergeMeta', {
                  names: sc.names.join(' ↔ '),
                  similarity: sc.similarity,
                  zeroLoad: typeof sc.zeroLoadCount === 'number' ? t('ui.prune.zeroLoad', { count: sc.zeroLoadCount }) : '',
                })}
              </div>
            ))}
            <div style={{ ...dim, fontSize: 11, marginTop: 4 }}>{t('ui.prune.convergeHint')}</div>
          </div>
        ) : null}

        {/* forgotten (recoverable) */}
        {prune && prune.forgotten.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <b style={{ fontSize: 13 }}>{t('ui.prune.forgottenTitle')}</b>
            {prune.forgotten.map((r) => (
              <div key={r.id} style={{ ...mono, paddingLeft: 12 }}>
                <span style={{ opacity: 0.7 }}>· [{r.kind}] {r.content}</span>
                <button style={{ ...btn, marginLeft: 8, padding: '2px 8px' }} disabled={saving} onClick={() => void doRestore(r.id)}>{t('ui.prune.restoreBtn')}</button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* ── Block 3: Overview ── */}
      <div style={box}>
        <b>{t('ui.overview.title')}</b>
        {s ? (
          <div style={{ marginTop: 8, ...mono }}>
            <div>{t('ui.overview.memLine', {
              total: s.memoryStats.total, confirmed: s.memoryStats.confirmed,
              pending: s.memoryStats.pending, max: s.memoryStats.maxRecords,
            })}</div>
            <div style={{ marginTop: 4 }}>{t('ui.overview.byKind', {
              kinds: Object.entries(s.memoryStats.byKind).map(([k, v]) => `${k}:${v}`).join('  ') || '—',
            })}</div>
            <div style={{ marginTop: 4 }}>{t('ui.overview.mostInjected')}</div>
            {s.memoryStats.topByInjection.length > 0
              ? s.memoryStats.topByInjection.map((r) => (
                <div key={r.id} style={{ paddingLeft: 12, opacity: 0.85 }}>· ({r.injectionCount}×) {r.content}</div>
              ))
              : <div style={{ paddingLeft: 12, opacity: 0.6 }}>—</div>}
            <div style={{ marginTop: 8 }}>
              skill：active {s.skillStats.counts.active} / stale {s.skillStats.counts.stale} / archived {s.skillStats.counts.archived}
            </div>
            {triageOn ? (
              <div style={{ marginTop: 4 }}>
                {t('ui.overview.triage', {
                  turns: (triage as { totalTurns: number }).totalTurns,
                  successes: (triage as { successes: number }).successes,
                  failures: (triage as { failures: number }).failures,
                })}
              </div>
            ) : <div style={{ marginTop: 4, opacity: 0.6 }}>{t('ui.overview.triageOff')}</div>}
          </div>
        ) : <div style={{ ...dim, marginTop: 8 }}>{t('ui.overview.loading')}</div>}
      </div>

      {note ? <div style={box}><pre style={mono}>{note}</pre></div> : null}
      {archives.length>0 ? <div style={box}>
        <b>{t('ui.archives.title', { count: archives.length })}</b>
        <div style={dim}>
          {t('ui.archives.desc')}
        </div>
        <table style={{width:'100%',marginTop:8,...mono}}><tbody>{archives.map(a=><tr key={a.archiveId}>
          <td>{a.logicalSkillName}</td>
          <td style={dim}>{a.archiveId}</td>
          <td style={{textAlign:'right',whiteSpace:'nowrap'}}>
            <button style={btnTiny} disabled={saving} onClick={()=>void restoreArchive(a)}>{t('ui.prune.restoreBtn')}</button>{' '}
            <button style={btnTiny} disabled={saving} onClick={()=>void proposeRollback(a.logicalSkillName)}>{t('ui.archives.proposeRollback')}</button>
          </td>
        </tr>)}</tbody></table>
      </div> : null}

    </div>
  )
}
