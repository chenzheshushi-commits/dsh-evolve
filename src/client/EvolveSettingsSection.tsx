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

const API = '/api/evolve'

interface ModelRow { provider: string; model: string }
interface PendingRow { id: string; kind: string; importance: number; content: string; sourceContext?: string }
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
  config: {
    refineLLM: boolean; refineProvider: string; refineModel: string; tier1Enabled: boolean
    approvalMode: 'manual' | 'balanced' | 'autonomous'
    reviewMaxAutoPerTurn: number; maxPendingQueue: number
    disposalMode: 'manual' | 'suggest'
    disposalMinIdleDays: number
  }
  models: ModelRow[]
  memoryStats: {
    total: number; confirmed: number; pending: number; maxRecords: number
    byKind: Record<string, number>
    topByInjection: InjRow[]
    pendingQueue: PendingRow[]
  }
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

interface OwnerProps { close: () => void }

export function EvolveSettingsSection(_props: OwnerProps): React.ReactElement {
  const [state, setState] = useState<EvolveState | null>(null)
  const [note, setNote] = useState<string>('')
  const [saving, setSaving] = useState(false)

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
      setNote(`✅ 已批量确认 ${r.confirmed} 条 pending 记忆`)
      await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refresh])

  // ── v0.4.2 controlled prune ──
  const [prune, setPrune] = useState<PruneState | null>(null)
  const [selMem, setSelMem] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<{ planDigest: string; preview: Array<{ action: string; count: number; allowed: boolean; reason: string; requires?: string }> } | null>(null)

  const refreshPrune = useCallback(async () => {
    try { setPrune(await apiGet<PruneState>(`${API}/prune`)) } catch (e) { /* keep last */ }
  }, [])
  useEffect(() => { void refreshPrune(); const t = window.setInterval(() => { void refreshPrune() }, 8000); return () => window.clearInterval(t) }, [refreshPrune])

  const toggleMem = useCallback((id: string) => { setSelMem((m) => ({ ...m, [id]: !m[id] })) }, [])

  // Stage 1: preview the selected forgets (read-only, gets a planDigest).
  const doPreview = useCallback(async () => {
    if (!prune) return
    const ids = prune.memoryCandidates.filter((c) => selMem[c.id] && c.allowedActions.includes('memory-forget')).map((c) => c.id)
    if (ids.length === 0) { setNote('未选择可处理的记忆'); return }
    setSaving(true); setNote('')
    try {
      const r = await apiPost<typeof preview>(`${API}/prune/preview`, { selection: { decisions: [{ action: 'memory-forget', entityType: 'memory', memoryIds: ids, reason: 'panel prune' }] } })
      setPreview(r)
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [prune, selMem])

  // Stage 2: execute the previewed plan (idempotent via planDigest).
  const doExecute = useCallback(async () => {
    if (!preview?.planDigest) return
    setSaving(true); setNote('')
    try {
      const r = await apiPost<{ status: string; applied?: unknown[]; skipped?: Array<{ target: string; reason: string }> }>(`${API}/prune/execute`, { planDigest: preview.planDigest })
      if (r.status === 'plan-expired') setNote('计划已过期，请重新预览')
      else setNote(`✅ 处理完成：软删 ${r.applied?.length ?? 0} 条${(r.skipped?.length ?? 0) > 0 ? `，跳过 ${r.skipped!.length} 条（${r.skipped!.map((s) => `${s.target}:${s.reason}`).join('; ')}）` : ''}`)
      setPreview(null); setSelMem({})
      await refreshPrune(); await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [preview, refreshPrune, refresh])

  const doRestore = useCallback(async (id: string) => {
    setSaving(true); setNote('')
    try {
      const r = await apiPost<typeof preview>(`${API}/prune/preview`, { selection: { decisions: [{ action: 'memory-restore', entityType: 'memory', memoryIds: [id], reason: 'restore' }] } })
      // restore goes straight through (reversible, low-risk) — reuse execute
      if (r?.planDigest) await apiPost(`${API}/prune/execute`, { planDigest: r.planDigest })
      setNote('✅ 已恢复')
      await refreshPrune(); await refresh()
    } catch (e) { setNote(String(e)) } finally { setSaving(false) }
  }, [refreshPrune, refresh])

  const s = state
  const cfg = s?.config
  const triage = s?.skillStats?.triage
  const triageOn = triage && !('disabled' in triage)

  // The model dropdown value: "" means follow-main; otherwise "provider\u0000model".
  const currentModelKey = cfg && cfg.refineProvider && cfg.refineModel ? `${cfg.refineProvider}\u0000${cfg.refineModel}` : ''

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>dsh-evolve</h2>
      <p style={dim}>自进化记忆 + skill 生命周期。所有设置即时保存到插件配置；数据每 8 秒刷新。</p>

      {/* ── Block 1: LLM refinement ── */}
      <div style={box}>
        <b>LLM 精炼 skill 内容</b>
        <div style={{ marginTop: 8 }}>
          <label style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cfg?.refineLLM ?? false}
              disabled={saving || !cfg}
              onChange={(e) => void setConfig({ refineLLM: e.target.checked })}
            />{' '}
            启用 LLM 精炼
          </label>
        </div>
        <div style={{ ...dim, marginTop: 6 }}>
          <div><b>打开</b>：结晶 / 精炼 skill 时，调用一次下方所选模型，把零散记忆提炼成结构化 SKILL.md（去重、分节、写成步骤/坑）。单次调用、仅在结晶/精炼时触发（一次会话可能 0 次），复用 provider 缓存。</div>
          <div style={{ marginTop: 4 }}><b>关闭</b>：改用确定性拼接（原样把记忆条目列进 SKILL.md），<b>零 token</b>、不调用任何模型。功能完全可用，只是内容不经提炼。</div>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={dim}>精炼使用的模型：</div>
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
            <option value="">（跟随 DSH 当前主模型 — 默认）</option>
            {(s?.models ?? []).map((m) => (
              <option key={`${m.provider}\u0000${m.model}`} value={`${m.provider}\u0000${m.model}`}>
                {m.provider} / {m.model}
              </option>
            ))}
          </select>
          <div style={{ ...dim, marginTop: 4 }}>
            不选 = 跟随主模型（主模型换了它自动跟随）。选了则固定用该模型精炼。
          </div>
        </div>
      </div>

      {/* ── Block 1.5: 摄入自治程度 (v0.5.0 direction 1) ── */}
      <div style={box}>
        <b>记忆摄入自治程度</b>
        <div style={dim}>决定「模型/后台评审想记的东西」有多少能自动生效，多少要你先过目。切档只影响之后的新记忆，不会批量放行已有的待确认项。</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            ['manual', '手动', '全部先进待确认，你逐条确认后才生效。最保守。'],
            ['balanced', '平衡（默认）', '拿得准的（锚定你原话、或与已确认高度重复）自动生效；拿不准的进待确认。'],
            ['autonomous', '自治', '凡是可逆、不冲突的都自动生效；重要(imp3)/冲突项仍强制进待确认。写入量另有上限保护。'],
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
            ⚠️ 自治档下后台评审会自动写入更多记忆。每轮最多自动确认 {cfg?.reviewMaxAutoPerTurn ?? 5} 条，待确认队列上限 {cfg?.maxPendingQueue ?? 50} 条——超出的会被拒收以防无界增长。冲突和重要记忆仍需你确认。
          </div>
        )}
      </div>

      {/* ── Block 2: Approval queue ── */}
      <div style={box}>
        <b>待确认记忆（审批门）</b>
        <div style={dim}>模型写入的记忆默认 pending，不会自动注入；人工确认后才「始终生效」。</div>
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
                          来源：{r.sourceContext}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button style={{ ...btnPrimary, marginTop: 10 }} disabled={saving} onClick={() => void confirmBatch()}>
              批量确认全部（{s.memoryStats.pendingQueue.length}）
            </button>
          </>
        ) : <div style={{ ...dim, marginTop: 8 }}>（无待确认记忆）</div>}
      </div>

      {/* ── Block 2.2: 检索健康度 (v0.5.0 R5) ── */}
      {s?.retrieval ? (
        <div style={box}>
          <b>记忆检索状态</b>
          <div style={{ ...mono, marginTop: 8 }}>
            {s.retrieval.mode === 'fused' ? (
              <span style={{ color: '#16a34a' }}>● 融合检索（bigram + 全文索引）— 召回最佳</span>
            ) : s.retrieval.mode === 'bigram-only' ? (
              <span style={{ color: 'var(--dsh-warn, #b45309)' }}>▲ 仅 bigram 检索 — 全文索引不可用，中文长句/转述查询召回会变差</span>
            ) : s.retrieval.mode === 'fts-degraded' ? (
              <span style={{ color: '#dc2626' }}>▲ 全文索引运行时降级 — 召回质量已下降（错误 {s.retrieval.ftsErrorCount ?? 0} 次）</span>
            ) : (
              <span style={dim}>状态未知（尚无检索发生）</span>
            )}
          </div>
          <div style={{ ...dim, fontSize: 12, marginTop: 4 }}>
            全文索引：{s.retrieval.ftsEnabled ? '已启用' : '已关闭'} · {s.retrieval.ftsAvailable ? '可用' : '不可用'}
            {typeof s.retrieval.fusedCount === 'number' ? ` · 融合 ${s.retrieval.fusedCount} 次 / 降级 ${s.retrieval.bigramOnlyCount ?? 0} 次` : ''}
          </div>
        </div>
      ) : null}

      {/* ── Block 2.4: 处置自治程度 (v0.5.0 direction 2) ── */}
      <div style={box}>
        <b>记忆处置自治程度</b>
        <div style={dim}>决定「系统要不要主动提议清理冷记忆」。注意：处置永远只到「提议」——任何档位都不会自动删除，删不删由你在下方受控剪枝里勾选。（技能的合并/归档永远手动，不进自动提议。）</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            ['manual', '手动', '系统不主动提议。你自己在下方受控剪枝里筛选处理。'],
            ['suggest', '建议', '空闲时自动重算「从未注入、从未召回、且过了冷静期」的低价值记忆，列给你看；仍然只提议、不自动删。'],
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
        {cfg?.disposalMode === 'suggest' && s?.disposalSuggest ? (
          <div style={{ marginTop: 10 }}>
            <div style={dim}>冷静期：{cfg?.disposalMinIdleDays ?? 30} 天。空闲时自动重算，{s.disposalSuggest.computedAt ? `上次算于 ${new Date(s.disposalSuggest.computedAt).toLocaleString()}` : '（还未触发，需空闲一段时间）'}</div>
            {s.disposalSuggest.candidates.length > 0 ? (
              <table style={{ width: '100%', marginTop: 6, ...mono }}>
                <tbody>
                  {s.disposalSuggest.candidates.map((c) => (
                    <tr key={c.id} style={{ verticalAlign: 'top' }}>
                      <td style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>[{c.kind}/imp{c.importance}]</td>
                      <td style={{ paddingLeft: 8 }}>
                        <div>{c.content}</div>
                        <div style={{ ...dim, fontSize: 11 }}>冷置 {c.ageDays} 天 · {c.reason}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div style={{ ...dim, marginTop: 6 }}>（暂无低价值候选——库还小或都在用）</div>}
            <div style={{ ...dim, fontSize: 12, marginTop: 6 }}>要真正清理，请到下方「受控剪枝」勾选执行（两阶段预览→确认，全部可逆）。</div>
          </div>
        ) : null}
      </div>

      {/* ── Block 2.5: Controlled prune (v0.4.2) ── */}
      <div style={box}>
        <b>受控剪枝</b>
        <div style={dim}>检测自动、处置显式。冷/低价值记忆与冗余技能在这里由你勾选处理，全部可逆（软删/归档，随时恢复）。</div>

        {/* budget bar */}
        {prune?.budget?.enabled ? (
          <div style={{ ...mono, marginTop: 8, color: prune.budget.overBudget ? '#dc2626' : undefined }}>
            字符预算：已用 {prune.budget.used} / 上限 {prune.budget.max}{prune.budget.overBudget ? '（超限）' : ''}
          </div>
        ) : null}

        {/* memory candidates (checkbox + heat badges) */}
        <div style={{ marginTop: 10 }}><b style={{ fontSize: 13 }}>待清理记忆</b></div>
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
                        {typeof c.heat === 'number' ? `久未主动访问 · heat ${c.heat}` : ''}
                        {typeof c.injectionCount === 'number' ? ` · 自动注入 ${c.injectionCount} 次` : ''}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : <div style={{ ...dim, marginTop: 6 }}>（无待清理候选）</div>}

        {/* preview -> execute two-stage */}
        {prune && prune.memoryCandidates.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            {!preview ? (
              <button style={btn} disabled={saving} onClick={() => void doPreview()}>预览将处理的记忆</button>
            ) : (
              <div style={{ border: '1px dashed var(--dsh-border,#555)', borderRadius: 6, padding: 8 }}>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>预览（软删，全部可恢复）：</div>
                <table style={{ width: '100%', ...mono, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ ...dim, textAlign: 'left', borderBottom: '1px solid var(--dsh-border,#444)' }}>
                      <th style={{ padding: '2px 6px' }}>动作</th>
                      <th style={{ padding: '2px 6px' }}>数量</th>
                      <th style={{ padding: '2px 6px' }}>结果</th>
                      <th style={{ padding: '2px 6px' }}>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--dsh-border,#2a2a2a)' }}>
                        <td style={{ padding: '2px 6px' }}>{p.action}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right' }}>{p.count}</td>
                        <td style={{ padding: '2px 6px', color: p.allowed ? '#16a34a' : '#b45309' }}>{p.allowed ? '将执行' : '跳过'}</td>
                        <td style={{ padding: '2px 6px', ...dim }}>{p.allowed ? '' : p.reason}{p.requires ? `（需 ${p.requires}）` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 8 }}>
                  <button style={btnPrimary} disabled={saving} onClick={() => void doExecute()}>确认执行</button>
                  <button style={btn} disabled={saving} onClick={() => setPreview(null)}>取消</button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* protected-kind review area (read-only, no forget) */}
        {prune && prune.protectedReview.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <b style={{ fontSize: 13 }}>保护记录（需专项审阅）</b>
            <div style={dim}>偏好 / 决策类记忆本版本不支持直接处置（避免误删长期偏好）。仅供审阅。</div>
            {prune.protectedReview.map((r) => (
              <div key={r.id} style={{ ...mono, paddingLeft: 12, opacity: 0.8 }}>· [{r.kind}] {r.content}</div>
            ))}
          </div>
        ) : null}

        {/* skill merge candidates */}
        {prune && prune.skillCandidates.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <b style={{ fontSize: 13 }}>待收敛技能</b>
            {prune.skillCandidates.map((sc, i) => (
              <div key={i} style={{ ...mono, paddingLeft: 12, opacity: 0.85 }}>
                · {sc.names.join(' ↔ ')}｜相似度 {sc.similarity}{typeof sc.zeroLoadCount === 'number' ? `｜零加载 ${sc.zeroLoadCount}` : ''}
              </div>
            ))}
            <div style={{ ...dim, fontSize: 11, marginTop: 4 }}>技能合并/归档请用对话侧 converge_skill / archive_skill（面板暂只做记忆清理）。</div>
          </div>
        ) : null}

        {/* forgotten (recoverable) */}
        {prune && prune.forgotten.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <b style={{ fontSize: 13 }}>已忘记（可恢复）</b>
            {prune.forgotten.map((r) => (
              <div key={r.id} style={{ ...mono, paddingLeft: 12 }}>
                <span style={{ opacity: 0.7 }}>· [{r.kind}] {r.content}</span>
                <button style={{ ...btn, marginLeft: 8, padding: '2px 8px' }} disabled={saving} onClick={() => void doRestore(r.id)}>恢复</button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* ── Block 3: Overview ── */}
      <div style={box}>
        <b>记忆 / skill 概览</b>
        {s ? (
          <div style={{ marginTop: 8, ...mono }}>
            <div>记忆：共 {s.memoryStats.total}（已确认 {s.memoryStats.confirmed} / 待确认 {s.memoryStats.pending}），上限 {s.memoryStats.maxRecords}</div>
            <div style={{ marginTop: 4 }}>按类型：{Object.entries(s.memoryStats.byKind).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}</div>
            <div style={{ marginTop: 4 }}>最常被注入（真正影响决策）：</div>
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
                结果三元组：{(triage as { totalTurns: number }).totalTurns} 轮记录，成功 {(triage as { successes: number }).successes} / 失败 {(triage as { failures: number }).failures}
              </div>
            ) : <div style={{ marginTop: 4, opacity: 0.6 }}>结果三元组：未启用</div>}
          </div>
        ) : <div style={{ ...dim, marginTop: 8 }}>加载中…</div>}
      </div>

      {note ? <div style={box}><pre style={mono}>{note}</pre></div> : null}
    </div>
  )
}
