/**
 * Web settings-page control plane for dsh-evolve (v0.3.0).
 *
 * Plain ESM (no build) — the HOST half. Registers same-origin /api/evolve/*
 * routes behind a loopback trust fence and exposes the data the browser
 * settings section needs:
 *   GET  /api/evolve/state   -> { config, models, memoryStats, skillStats }
 *   POST /api/evolve/action  -> { action: 'confirm-batch'|'set-config', ... }
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
  const { store, getConfig, setConfig, skillStates, llm } = deps;
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
      let config = { refineLLM: false, refineProvider: '', refineModel: '', tier1Enabled: true };
      try {
        const cfg = getConfig() ?? {};
        config = {
          refineLLM: cfg.refineLLM === true,
          refineProvider: cfg.refineProvider ?? '',
          refineModel: cfg.refineModel ?? '',
          tier1Enabled: cfg.tier1Enabled !== false,
        };
      } catch { /* keep defaults */ }
      let models = [];
      try { models = await listConfiguredModels(llm); } catch { models = []; }
      let memoryStats = { total: 0, confirmed: 0, pending: 0, maxRecords: 0, byKind: {}, topByInjection: [], pendingQueue: [] };
      try { memoryStats = store.stats({ topN: 5 }); } catch { /* keep defaults */ }
      let skillStatsVal = { counts: { active: 0, stale: 0, archived: 0 }, triage: { disabled: true } };
      try { skillStatsVal = skillStates(); } catch { /* keep defaults */ }
      try {
        json(res, 200, { ok: true, config, models, memoryStats, skillStats: skillStatsVal });
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
          const patch = {};
          if (typeof body.refineLLM === 'boolean') patch.refineLLM = body.refineLLM;
          if (typeof body.refineProvider === 'string') patch.refineProvider = body.refineProvider;
          if (typeof body.refineModel === 'string') patch.refineModel = body.refineModel;
          if (typeof body.tier1Enabled === 'boolean') patch.tier1Enabled = body.tier1Enabled;
          await setConfig(patch);
          return json(res, 200, { ok: true, config: patch });
        }
        return json(res, 400, { ok: false, error: 'invalid-action' });
      } catch (e) {
        return json(res, 500, { ok: false, error: e?.message ?? String(e) });
      }
    },
  };

  return [state, action];
}
