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
interface PendingRow { id: string; kind: string; importance: number; content: string }
interface InjRow { id: string; kind: string; importance: number; injectionCount: number; content: string }
interface TriageSkill { loaded: number; succeeded: number; errored: number }
interface EvolveState {
  ok: boolean
  config: { refineLLM: boolean; refineProvider: string; refineModel: string; tier1Enabled: boolean }
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

      {/* ── Block 2: Approval queue ── */}
      <div style={box}>
        <b>待确认记忆（审批门）</b>
        <div style={dim}>模型写入的记忆默认 pending，不会自动注入；人工确认后才「始终生效」。</div>
        {s && s.memoryStats.pendingQueue.length > 0 ? (
          <>
            <table style={{ width: '100%', marginTop: 8, ...mono }}>
              <tbody>
                {s.memoryStats.pendingQueue.map((r) => (
                  <tr key={r.id}>
                    <td style={{ opacity: 0.6, whiteSpace: 'nowrap' }}>[{r.kind}/imp{r.importance}]</td>
                    <td style={{ paddingLeft: 8 }}>{r.content}</td>
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
