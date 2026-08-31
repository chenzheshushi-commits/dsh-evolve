/**
 * Web settings-page control plane for dsh-evolve (v0.3.0).
 *
 * Plain ESM (no build) — the HOST half. Registers same-origin /api/evolve/*
 * routes behind a loopback trust fence and exposes the data the browser
 * settings section needs:
 *   GET  /api/evolve/state         -> { config, models, memoryStats, skillStats }
 *   POST /api/evolve/action        -> { action: 'confirm-batch'|'set-config', ... }
 *   GET  /api/evolve/prune         -> { budget, memoryCandidates[], skillCandidates[], forgotten[] }
 *   POST /api/evolve/prune/preview -> { planDigest, preview }   (read-only, no mutation, no audit)
 *   POST /api/evolve/prune/execute -> { status, applied[], skipped[] } | { status:'plan-expired' }
 *
 * Wired in from index.js only when the webServer + settings services exist
 * (i.e. the web profile). Headless/other profiles skip it entirely — the
 * plugin's memory/skill features never depend on this.
 *
 * The loopback fence is ported verbatim from a sibling plugin
 * (itself from dsh-web-ui-shared): privileged config writes MUST be same-origin.
 */

export const EVOLVE_API_PREFIX = '/api/evolve';
const ACTION_LIMIT = 64 * 1024;

// ── CONFIG_KEY_SPECS: single source of truth for the settings control plane ──
// (评审 B1/C4). ONE table drives all three sides of every configurable key:
//   1. set-config  — validate + collect the patch (type/enum checked here);
//   2. /state      — read each key back (with default) for the settings page;
//   3. frontend    — the EvolveState.config interface mirrors these keys.
// Adding a key here wires it end-to-end; a key NOT here is unreachable from the UI
// (that was the B1/C4 bug: approvalMode etc. had no whitelist entry = dead config).
// Each spec: { type, default, enum? }. type ∈ 'boolean'|'string'|'int'|'enum'.
export const CONFIG_KEY_SPECS = {
  // — LLM refinement (pre-existing 4 keys) —
  refineLLM: { type: 'boolean', default: false },
  refineProvider: { type: 'string', default: '' },
  refineModel: { type: 'string', default: '' },
  tier1Enabled: { type: 'boolean', default: true },
  // — v0.5.0 ingestion autonomy —
  approvalMode: { type: 'enum', default: 'balanced', enum: ['manual', 'balanced', 'autonomous'] },
  reviewMaxAutoPerTurn: { type: 'int', default: 5, min: 0, max: 100 },
  maxPendingQueue: { type: 'int', default: 50, min: 0, max: 1000 },
  // — v0.5.0 disposal autonomy (manual/suggest; tidy deferred to v0.6.x) —
  disposalMode: { type: 'enum', default: 'manual', enum: ['manual', 'suggest'] },
  disposalMinIdleDays: { type: 'int', default: 30, min: 1, max: 3650 },
};

/**
 * Validate ONE config value against its spec. Returns { ok, value } or
 * { ok:false, error }. Illegal type / out-of-enum / out-of-range → rejected
 * (the caller turns that into a 400, never a silent default — 评审 B1/C4).
 */
export function validateConfigValue(key, raw) {
  const spec = CONFIG_KEY_SPECS[key];
  if (!spec) return { ok: false, error: `unknown config key: ${key}` };
  switch (spec.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') return { ok: false, error: `${key} must be boolean` };
      return { ok: true, value: raw };
    case 'string':
      if (typeof raw !== 'string') return { ok: false, error: `${key} must be string` };
      return { ok: true, value: raw };
    case 'enum':
      if (typeof raw !== 'string' || !spec.enum.includes(raw)) {
        return { ok: false, error: `${key} must be one of ${spec.enum.join('|')}` };
      }
      return { ok: true, value: raw };
    case 'int': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, error: `${key} must be an integer` };
      if (spec.min != null && raw < spec.min) return { ok: false, error: `${key} must be >= ${spec.min}` };
      if (spec.max != null && raw > spec.max) return { ok: false, error: `${key} must be <= ${spec.max}` };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, error: `unhandled spec type for ${key}` };
  }
}

/** Read every configured key back from a raw config, applying defaults. */
export function readConfigView(cfg = {}) {
  const view = {};
  for (const [key, spec] of Object.entries(CONFIG_KEY_SPECS)) {
    const v = cfg[key];
    if (spec.type === 'boolean') view[key] = typeof v === 'boolean' ? v : spec.default;
    else if (spec.type === 'enum') view[key] = (typeof v === 'string' && spec.enum.includes(v)) ? v : spec.default;
    else if (spec.type === 'int') view[key] = (typeof v === 'number' && Number.isInteger(v)) ? v : spec.default;
    else view[key] = v ?? spec.default;
  }
  return view;
}


// ── loopback trust fence ─────────────────────────────────────────────────────
function isIPv4Loopback(v4) {
  const parts = v4.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isLoopbackAddress(address) {
  if (address === undefined) return false;
  const n = address.toLowerCase();
  if (n === '::1') return true;
  if (n.startsWith('::ffff:')) return isIPv4Loopback(n.slice(7));
  return isIPv4Loopback(n);
}
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}
export function isTrustedLocalRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try { hostUrl = new URL('http://' + host); } catch { return false; }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (origin === undefined) return site === 'same-origin' || site === 'none';
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > ACTION_LIMIT) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * List configured models for the settings dropdown, via ctx.llm. Returns
 * [{ provider, model }...]; best-effort (empty on any failure). The user picks
 * one to override the refine model; empty selection = follow the main model.
 */
async function listConfiguredModels(llm) {
  if (!llm) return [];
  const out = [];
  const seen = new Set();
  const push = (provider, model) => {
    const key = `${provider}\u0000${model}`;
    if (provider && !seen.has(key)) { seen.add(key); out.push({ provider, model }); }
  };
  try {
    // Providers are enumerable synchronously as { id, name }.
    let providers = [];
    try { providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []; } catch { providers = []; }
    // Also include configurable provider routes (some are declared but not active adapters).
    try {
      if (typeof llm.listConfigurableProviders === 'function') {
        for (const cp of llm.listConfigurableProviders() ?? []) {
          const pid = cp?.provider ?? cp?.id;
          if (pid && !providers.some((p) => (p?.id ?? p) === pid)) providers.push({ id: pid, name: cp?.displayName ?? pid });
        }
      }
    } catch { /* best-effort */ }
    for (const p of providers) {
      const pid = p?.id ?? p;
      let models = [];
      try { models = typeof llm.listModels === 'function' ? await llm.listModels(pid) : []; } catch { models = []; }
      if (Array.isArray(models) && models.length > 0) {
        for (const m of models) push(pid, m?.id ?? m);
      } else {
        // Adapter doesn't enumerate models (returns []); still offer the provider
        // so the user can pick it (blank model = provider default).
        push(pid, '');
      }
    }
  } catch { /* best-effort — empty list just means "follow main model" only */ }
  return out;
}

/**
 * Build the WebRoute[] for the evolve settings page.
 * @param deps { store, getConfig, setConfig, skillStates, ctx }
 */
export function makeEvolveRoutes(deps) {
  const { store, getConfig, setConfig, skillStates, llm, getSuggestedDisposal } = deps;
  const guard = (req, res) => {
    if (isTrustedLocalRequest(req)) return true;
    json(res, 403, { ok: false, error: 'forbidden' });
    return false;
  };

  const state = {
    kind: 'exact',
    path: `${EVOLVE_API_PREFIX}/state`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
      if (!guard(req, res)) return;
      // Each data source is independently guarded: one failing section must not
      // blank the whole settings page (and must never surface as a bare 400).
      // Config view is driven by CONFIG_KEY_SPECS (评审 B1/C4): every configurable
      // key reads back here with its default, so the settings page always sees the
      // COMPLETE config — never a partial patch. (This /state read, NOT set-config's
      // return value, is the authoritative source for the frontend's local config.)
      let config = readConfigView({});
      try { config = readConfigView(getConfig() ?? {}); } catch { /* keep defaults */ }
      let models = [];
      try { models = await listConfiguredModels(llm); } catch { models = []; }
      let memoryStats = { total: 0, confirmed: 0, pending: 0, maxRecords: 0, byKind: {}, topByInjection: [], pendingQueue: [] };
      try { memoryStats = store.stats({ topN: 5 }); } catch { /* keep defaults */ }
      let skillStatsVal = { counts: { active: 0, stale: 0, archived: 0 }, triage: { disabled: true } };
      try { skillStatsVal = skillStates(); } catch { /* keep defaults */ }
      // R5 (v0.5.0): retrieval-path observability for the settings page.
      let retrieval = { mode: 'unknown', ftsEnabled: true, ftsAvailable: false };
      try { retrieval = store.retrievalStatus(); } catch { /* keep defaults */ }
      // v0.5.0 direction 2: idle-computed disposal-suggest snapshot (read-only).
      let disposalSuggest = { candidates: [], computedAt: 0, mode: 'manual' };
      try { if (typeof getSuggestedDisposal === 'function') disposalSuggest = getSuggestedDisposal(); } catch { /* keep defaults */ }
      try {
        json(res, 200, { ok: true, config, models, memoryStats, skillStats: skillStatsVal, retrieval, disposalSuggest });
      } catch (e) {
        json(res, 500, { ok: false, error: e?.message ?? String(e) });
      }
    },
  };

  const action = {
    kind: 'exact',
    path: `${EVOLVE_API_PREFIX}/action`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
      if (!guard(req, res)) return;
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'json-required' });
      }
      let body;
      try { body = await readJson(req); } catch (e) {
        return json(res, 400, { ok: false, error: e?.message ?? 'bad-json' });
      }
      const kind = body?.action;
      try {
        if (kind === 'confirm-batch') {
          const pending = store.list({ pending: true });
          const ids = Array.isArray(body.ids) && body.ids.length > 0 ? body.ids : pending.map((r) => r.id);
          const confirmed = [];
          for (const id of ids) {
            try { const r = await store.confirm(id); if (r) confirmed.push(id); } catch { /* skip */ }
          }
          return json(res, 200, { ok: true, confirmed: confirmed.length, remainingPending: store.list({ pending: true }).length });
        }
        if (kind === 'set-config') {
          // Driven by CONFIG_KEY_SPECS (评审 B1/C4): every provided key is validated
          // against its spec; unknown keys, wrong types, out-of-enum, out-of-range
          // → 400 (never a silent 200 that drops the value). Empty patch → 400 too.
          const patch = {};
          const errors = [];
          for (const [key, raw] of Object.entries(body)) {
            if (key === 'action') continue;
            if (!(key in CONFIG_KEY_SPECS)) { errors.push(`unknown key: ${key}`); continue; }
            const v = validateConfigValue(key, raw);
            if (!v.ok) { errors.push(v.error); continue; }
            patch[key] = v.value;
          }
          if (errors.length > 0) return json(res, 400, { ok: false, error: errors.join('; ') });
          if (Object.keys(patch).length === 0) return json(res, 400, { ok: false, error: 'empty patch — no valid config keys provided' });
          await setConfig(patch);
          // Return the COMPLETE config view (not the bare patch): the frontend can
          // trust this as the full new state without clobbering unsent keys (评审 F1).
          let full = readConfigView(patch);
          try { full = readConfigView(getConfig() ?? {}); } catch { /* patch view is a safe fallback */ }
          return json(res, 200, { ok: true, config: full });
        }
        return json(res, 400, { ok: false, error: 'invalid-action' });
      } catch (e) {
        return json(res, 500, { ok: false, error: e?.message ?? String(e) });
      }
    },
  };

  // ── v0.4.2 prune routes ────────────────────────────────────────────────
  // deps.prune supplies the controlled-pruning surface (built in index.js):
  //   listCandidates() -> { budget, memoryCandidates, skillCandidates, forgotten }
  //   buildPlanFromSelection(selection) -> plan (also stored in registry)
  //   previewPlan(plan) -> human-readable preview (no mutation)
  //   executePlan(planDigest) -> { status, applied, skipped } | {status:'plan-expired'}
  const prune = deps.prune;

  const pruneList = {
    kind: 'exact',
    path: `${EVOLVE_API_PREFIX}/prune`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' });
      if (!guard(req, res)) return;
      if (!prune) return json(res, 200, { ok: true, budget: { enabled: false }, memoryCandidates: [], skillCandidates: [], forgotten: [] });
      // each source independently guarded (never a bare 400 that disables the UI)
      let out = { budget: { enabled: false }, memoryCandidates: [], skillCandidates: [], forgotten: [] };
      try { out = await prune.listCandidates(); } catch (e) { /* keep empty */ }
      try { return json(res, 200, { ok: true, ...out }); }
      catch (e) { return json(res, 500, { ok: false, error: e?.message ?? String(e) }); }
    },
  };

  const prunePreview = {
    kind: 'exact',
    path: `${EVOLVE_API_PREFIX}/prune/preview`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
      if (!guard(req, res)) return;
      if (!prune) return json(res, 503, { ok: false, error: 'prune-unavailable' });
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'json-required' });
      }
      let body; try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e?.message ?? 'bad-json' }); }
      try {
        const { planDigest, preview } = await prune.preview(body?.selection ?? body);
        return json(res, 200, { ok: true, planDigest, preview });
      } catch (e) { return json(res, 500, { ok: false, error: e?.message ?? String(e) }); }
    },
  };

  const pruneExecute = {
    kind: 'exact',
    path: `${EVOLVE_API_PREFIX}/prune/execute`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
      if (!guard(req, res)) return;
      if (!prune) return json(res, 503, { ok: false, error: 'prune-unavailable' });
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'json-required' });
      }
      let body; try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e?.message ?? 'bad-json' }); }
      try {
        const result = await prune.execute(body?.planDigest, { confirm: body?.confirm === true });
        return json(res, 200, { ok: true, ...result });
      } catch (e) { return json(res, 500, { ok: false, error: e?.message ?? String(e) }); }
    },
  };

  return [state, action, pruneList, prunePreview, pruneExecute];
}
