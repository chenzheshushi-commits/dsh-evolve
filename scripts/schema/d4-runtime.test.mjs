/**
 * The D4 approval path, executed rather than grepped.
 *
 * The existing approval-path tests read lib/index.js as text. That proves the
 * code was WRITTEN, not that it RUNS: a wrong condition, an unawaited promise or
 * a rejected-outcome branch that never fires all pass a source scan. These tests
 * drive the real plugin through a mock host ctx (the same shape apply-probe.mjs
 * uses), register the real tools, inject a real approval service, and call
 * memory_remember's execute() for each outcome.
 *
 * What must hold:
 *
 *   - allowed-once  -> the memory is confirmed
 *   - rejected      -> the memory is rejected
 *   - cancelled     -> it stays PENDING (fail closed)
 *   - unavailable   -> it stays PENDING (fail closed)
 *   - a throwing approval service -> it stays PENDING, and does not break the tool
 *   - the per-turn cap is enforced, and a second turn gets a fresh budget
 *   - with the feature off, the service is never called at all
 *   - background paths never ask
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTable() {
  const m = new Map();
  return {
    put(k, v) { m.set(k, v); return true; },
    get(k) { return m.get(k); },
    delete(k) { return m.delete(k); },
    entries() { return [...m.entries()]; },
    async update(k, fn) {
      if (!m.has(k)) { const e = new Error(`missing-key: ${k}`); e.code = 'missing-key'; throw e; }
      const next = fn(m.get(k));
      m.set(k, next);
      return next;
    },
    get size() { return m.size; },
  };
}

/**
 * Boot the real plugin against a mock host.
 *
 * `approvalOutcome` is a function so a test can vary the answer per call and
 * count invocations -- the per-turn cap is only observable that way.
 */
async function boot({ cfg = {}, approvalOutcome = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'evolve-d4-'));
  process.env.DSH_HOME = home;

  const domains = new Map();
  const makeDomain = () => {
    const tables = new Map();
    return {
      table(n) { if (!tables.has(n)) tables.set(n, makeTable()); return tables.get(n); },
      close() {},
    };
  };

  const tools = new Map();
  const calls = [];
  const childPlugins = [];

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    storageDomain: {
      get: (name) => domains.get(name),
      open: async (decl) => { const d = makeDomain(); domains.set(decl.name, d); return d; },
    },
    tools: { register: (tool) => { tools.set(tool.name, tool); }, get: () => undefined },
    systemPrompt: { section() {}, context() {}, variable() {} },
    on: () => {},
    effect: () => {},
    get: () => ({ currentInitiator: () => undefined }),
    llm: { stream: async function* () {} },
    plugin(child, cfg2) {
      childPlugins.push(child?.name ?? '(anon)');
      const deps = child?.inject ?? [];
      // The approval child declares inject:['approval']. Provide a real-shaped
      // approval service so the child actually installs approvalAsk -- that
      // installation is the thing under test.
      if (deps.every((d) => ctx[d] !== undefined) && typeof child?.apply === 'function') {
        void child.apply(ctx, cfg2);
      }
    },
    // The host's approval service. `request` is what the plugin calls through.
    approval: approvalOutcome ? {
      request: async ({ reason }) => {
        calls.push({ reason });
        const out = approvalOutcome(calls.length);
        if (out instanceof Error) throw out;
        return out;
      },
    } : undefined,
  };

  const mod = await import('./../../lib/index.js');
  await mod.apply(ctx, cfg);
  return {
    home, tools, calls, childPlugins,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A fake session object: identity is what the per-turn counter keys on. */
const session = (id) => ({ id, agent: null });

/** exec shape the tool reads: agent (with session), callId, signal. */
function execFor(sess) {
  const agent = { session: sess };
  sess.agent = agent;
  return { agent, callId: `call_${sess.id}`, signal: undefined };
}

/** An importance>=2 memory with no explicit user request -> lands pending. */
const pendingArgs = (content) => ({
  content, kind: 'lesson', importance: 2, scope: 'global', tags: [],
});

async function remember(env, sess, content) {
  const tool = env.tools.get('memory_remember');
  assert.ok(tool, 'memory_remember must be registered');
  return tool.execute(pendingArgs(content), execFor(sess));
}

test('the approval child installs only when the host provides the service', async () => {
  const withSvc = await boot({ cfg: { approvalPromptEnabled: true }, approvalOutcome: () => 'allowed-once' });
  try {
    assert.ok(withSvc.childPlugins.includes('dsh-evolve-approval'),
      'the approval child must be declared');
  } finally { withSvc.cleanup(); }

  // No approval service on ctx: the child must not install, and the mother plugin
  // must still boot. This is the headless case.
  const withoutSvc = await boot({ cfg: { approvalPromptEnabled: true } });
  try {
    assert.ok(withoutSvc.tools.has('memory_remember'),
      'the plugin must load fine without the optional approval service');
    const r = await remember(withoutSvc, session('s1'), 'no approval service present');
    assert.equal(r.saved, true);
    assert.equal(r.status, 'pending',
      'without the service the memory must stay pending, not be silently confirmed');
  } finally { withoutSvc.cleanup(); }
});

test('allowed-once confirms the memory', async () => {
  const env = await boot({ cfg: { approvalPromptEnabled: true }, approvalOutcome: () => 'allowed-once' });
  try {
    const r = await remember(env, session('s1'), 'user approved this memory');
    assert.equal(r.saved, true);
    assert.equal(env.calls.length, 1, 'the approval service must actually be called');
    assert.equal(r.status, 'confirmed',
      'an approved memory must leave pending -- otherwise the prompt achieved nothing');
  } finally { env.cleanup(); }
});

test('rejected rejects the memory and says so', async () => {
  const env = await boot({ cfg: { approvalPromptEnabled: true }, approvalOutcome: () => 'rejected' });
  try {
    const r = await remember(env, session('s1'), 'user rejected this memory');
    assert.equal(env.calls.length, 1);
    assert.equal(r.status, 'rejected',
      'a rejection is its own outcome: reporting it as confirmed tells the model the '
      + 'user accepted a fact they just declined, and the model then relies on it');
    assert.equal(r.saved, false,
      'a caller that only checks `saved` must not conclude the memory is available');
    assert.match(r.note, /丢弃/, 'and the note must not claim it was stored');
  } finally { env.cleanup(); }
});

test('cancelled and unavailable both fail closed to pending', async () => {
  for (const outcome of ['cancelled', 'unavailable', 'something-unexpected']) {
    const env = await boot({ cfg: { approvalPromptEnabled: true }, approvalOutcome: () => outcome });
    try {
      const r = await remember(env, session('s1'), `outcome ${outcome}`);
      assert.equal(env.calls.length, 1);
      assert.equal(r.status, 'pending',
        `"${outcome}" must leave the memory pending: an unanswered prompt is not consent`);
    } finally { env.cleanup(); }
  }
});

test('a throwing approval service leaves the memory pending and does not break the tool', async () => {
  const env = await boot({
    cfg: { approvalPromptEnabled: true },
    approvalOutcome: () => new Error('approval service exploded'),
  });
  try {
    const r = await remember(env, session('s1'), 'approval throws');
    assert.equal(r.saved, true, 'the tool must still return a result');
    assert.equal(r.status, 'pending', 'and fail closed');
  } finally { env.cleanup(); }
});

test('the per-turn cap is enforced and the service stops being called', async () => {
  const env = await boot({
    cfg: { approvalPromptEnabled: true, approvalPromptMaxPerTurn: 1 },
    approvalOutcome: () => 'allowed-once',
  });
  try {
    const s = session('s1');
    const first = await remember(env, s, 'first in this turn');
    const second = await remember(env, s, 'second in this turn');
    assert.equal(env.calls.length, 1,
      'the second write must NOT prompt: an uncapped prompt is how a model floods '
      + 'the user into clicking approve');
    assert.equal(first.status, 'confirmed');
    assert.equal(second.status, 'pending', 'the uncapped write stays pending');
  } finally { env.cleanup(); }
});

test('a different session has its own budget', async () => {
  const env = await boot({
    cfg: { approvalPromptEnabled: true, approvalPromptMaxPerTurn: 1 },
    approvalOutcome: () => 'allowed-once',
  });
  try {
    const a = await remember(env, session('s1'), 'session one');
    const b = await remember(env, session('s2'), 'session two');
    assert.equal(env.calls.length, 2, 'the cap is per session, not global');
    assert.equal(a.status, 'confirmed');
    assert.equal(b.status, 'confirmed');
  } finally { env.cleanup(); }
});

test('a cap above one allows exactly that many prompts', async () => {
  const env = await boot({
    cfg: { approvalPromptEnabled: true, approvalPromptMaxPerTurn: 2 },
    approvalOutcome: () => 'allowed-once',
  });
  try {
    const s = session('s1');
    await remember(env, s, 'one');
    await remember(env, s, 'two');
    await remember(env, s, 'three');
    assert.equal(env.calls.length, 2, 'the configured cap must be the actual limit');
  } finally { env.cleanup(); }
});

test('with the feature disabled the approval service is never called', async () => {
  const env = await boot({
    cfg: { approvalPromptEnabled: false },
    approvalOutcome: () => 'allowed-once',
  });
  try {
    const r = await remember(env, session('s1'), 'feature off');
    assert.equal(env.calls.length, 0,
      'default-off must mean off: prompting when disabled is the failure users notice');
    assert.equal(r.status, 'pending');
  } finally { env.cleanup(); }
});

test('a call without an open turn never prompts', async () => {
  const env = await boot({ cfg: { approvalPromptEnabled: true }, approvalOutcome: () => 'allowed-once' });
  try {
    const tool = env.tools.get('memory_remember');
    // No exec at all: this is the shape a background/internal caller has. The
    // prompt would have nowhere to appear, so it must not be attempted.
    const r = await tool.execute(pendingArgs('no exec context'), undefined);
    assert.equal(env.calls.length, 0, 'a prompt outside an open turn must not be attempted');
    assert.equal(r.status, 'pending');
    // Missing callId is the same situation.
    const r2 = await tool.execute(pendingArgs('no callId'), { agent: { session: session('s9') } });
    assert.equal(env.calls.length, 0, 'without a callId there is no turn to attach to');
    assert.equal(r2.status, 'pending');
  } finally { env.cleanup(); }
});

test('a low-importance memory does not prompt', async () => {
  const env = await boot({ cfg: { approvalPromptEnabled: true }, approvalOutcome: () => 'allowed-once' });
  try {
    const tool = env.tools.get('memory_remember');
    const r = await tool.execute(
      { content: 'trivial note', kind: 'note', importance: 1, scope: 'global', tags: [] },
      execFor(session('s1')),
    );
    assert.equal(env.calls.length, 0,
      'importance 1 must not interrupt the user; the gate is for consequential writes');
    assert.ok(r.saved);
  } finally { env.cleanup(); }
});

test('the reason shown to the user carries the memory, not a generic string', async () => {
  const env = await boot({ cfg: { approvalPromptEnabled: true }, approvalOutcome: () => 'allowed-once' });
  try {
    await remember(env, session('s1'), 'a very specific fact about the deployment');
    assert.equal(env.calls.length, 1);
    assert.match(env.calls[0].reason, /a very specific fact about the deployment/,
      'the prompt must show WHAT is being saved, or the user cannot decide');
  } finally { env.cleanup(); }
});
