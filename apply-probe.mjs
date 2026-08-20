// Host-instance apply probe for dsh-evolve v0.2.0.
// Drives apply(ctx, cfg) with a record-only mock ctx that mimics the host's
// cordis service surface (storageDomain, tools, systemPrompt, on/effect/get),
// then asserts every tool/section/hook the plugin promises actually registers.
// This is the reliable verification per the dsh skill (headless --patch boot has
// a storageDomain race that can silently skip the plugin; a mock ctx does not).
// Run: ~/.local/node22/bin/node apply-probe.mjs
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir, 'evolve-apply-'));
process.env.DSH_HOME = home; // resolveDshHome -> this temp dir

// ── minimal in-memory storage-domain table (put/get/delete/entries/size) ──────
function makeTable {
  const m = new Map;
  return {
    put(k, v) { m.set(k, v); return true; },
    get(k) { return m.get(k); },
    delete(k) { return m.delete(k); },
    entries { return [...m.entries]; },
    get size { return m.size; },
  };
}
const openedDomains = new Map;
function makeDomain {
  const tables = new Map;
  return { table(n) { if (!tables.has(n)) tables.set(n, makeTable); return tables.get(n); }, close {} };
}

// ── record-only mock ctx (captures every registration) ────────────────────────
const registered = { tools: [], sections: [], hooks: [], effects: 0 };
const ctx = {
  logger: { info {}, warn {}, error {} },
  storageDomain: {
    get: (name) => openedDomains.get(name),
    open: async (domainDecl) => { const d = makeDomain; openedDomains.set(domainDecl.name, d); return d; },
  },
  tools: {
    register: (tool) => { registered.tools.push(tool.name); },
    get:  => undefined,
  },
  systemPrompt: {
    section: (s) => { registered.sections.push(s.name); },
    context {}, variable {},
  },
  on: (evt) => { registered.hooks.push(evt); },
  effect:  => { registered.effects += 1; },
  get:  => ({ currentInitiator:  => undefined }),
};

const mod = await import('./lib/index.js');
await mod.apply(ctx, {}); // must NOT throw

// ── assert the full v0.2.1 surface ────────────────────────────────────────────
const expectTools = [
  'memory_remember', 'memory_recall', 'memory_index', 'memory_confirm', 'memory_forget',
  'crystallize_skill', 'refine_skill', 'skill_curator', 'archive_skill', 'restore_skill',
  'memory_stats', 'skill_stats',
];
for (const t of expectTools) assert.ok(registered.tools.includes(t), `tool registered: ${t}`);
assert.equal(registered.tools.length, expectTools.length, `exactly ${expectTools.length} tools (got ${registered.tools.length}: ${registered.tools.join(',')})`);
assert.ok(registered.sections.includes('evolve-protocol'), 'system-prompt section registered');

// hooks: pre-step recall, agent/error lessonize, and TWO session/event listeners
// (tool/call usage tracking + turn/end crystallize/refine/curate).
const sessionEventHooks = registered.hooks.filter((h) => h === 'session/event').length;
assert.ok(registered.hooks.includes('agent/pre-step'), 'agent/pre-step hook');
assert.ok(registered.hooks.includes('agent/error'), 'agent/error hook');
assert.ok(sessionEventHooks >= 2, `>=2 session/event hooks (usage + turn/end); got ${sessionEventHooks}`);

// storage domain was opened with the schemastery-legal name.
assert.ok(openedDomains.has('evolve_memory'), 'evolve_memory storage domain opened');

// archive dir is created OUTSIDE the watched skills root.
assert.ok(existsSync(join(home, 'evolve-workspace', 'archived-skills')), 'archive dir scaffolded outside skills root');
assert.ok(existsSync(join(home, 'skills')), 'skills dir scaffolded');

rmSync(home, { recursive: true, force: true });
console.log('OK apply probe:');
console.log('  tools    =', registered.tools.join(', '));
console.log('  sections =', registered.sections.join(', '));
console.log('  hooks    =', registered.hooks.join(', '), `(session/event x${sessionEventHooks})`);
console.log('\nAPPLY PROBE PASSED');
