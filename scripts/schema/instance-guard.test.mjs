/**
 * A profile can mount dsh-evolve twice (a bundle entry plus a stale loader row in
 * the profile's or the home-level cordis.patch.yml). Both copies used to run
 * apply() in the same root scope; the second died on
 *
 *   prompt section "evolve-protocol" is already registered
 *
 * and the plugin's own catch swallowed it, so the desktop app showed the plugin as
 * enabled while memory and skills were dead -- the exact log users reported.
 *
 * Behaviour pinned here:
 *   - the first live mount owns the workspace;
 *   - a later mount in the same process stops BEFORE touching any host service and
 *     leaves a durable duplicate-mount.log note;
 *   - a failed first mount releases ownership so a retry/other copy can still try;
 *   - separate workspaces are independent.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimInstance,
  reportDuplicateMount,
  __resetInstanceGuardForTests,
} from '../../lib/instance-guard.js';

let root;
const workspace = () => join(root, 'evolve-workspace');

beforeEach(() => {
  __resetInstanceGuardForTests();
  root = mkdtempSync(join(tmpdir(), 'dsh-evolve-guard-'));
});

afterEach(() => {
  __resetInstanceGuardForTests();
  rmSync(root, { recursive: true, force: true });
});

test('the first live mount owns the workspace; a second fiber does not', () => {
  const first = claimInstance({ workspaceDir: workspace(), fiberUid: 11 });
  assert.equal(first.owner, true, 'the first mount must own the workspace');

  const second = claimInstance({ workspaceDir: workspace(), fiberUid: 12 });
  assert.equal(second.owner, false,
    'a second fiber in the same process must be treated as a duplicate mount');

  first.release();
  const third = claimInstance({ workspaceDir: workspace(), fiberUid: 13 });
  assert.equal(third.owner, true,
    'once the owner is released, the next mount must be able to take over');
  third.release();
});

test('the same fiber re-entering apply() while its effects are live is skipped as a reapply', () => {
  const first = claimInstance({ workspaceDir: workspace(), fiberUid: 21 });
  assert.equal(first.owner, true);

  const retry = claimInstance({ workspaceDir: workspace(), fiberUid: 21 });
  assert.equal(retry.owner, false,
    'a fiber whose old effects were never disposed must not register a second time');
  assert.equal(retry.reason, 'reapply');

  retry.release();
  const other = claimInstance({ workspaceDir: workspace(), fiberUid: 22 });
  assert.equal(other.owner, false,
    'releasing the skipped retry handle must not drop the original ownership');

  first.release();
  const takeover = claimInstance({ workspaceDir: workspace(), fiberUid: 23 });
  assert.equal(takeover.owner, true,
    'once the original effects are disposed, a fresh apply must be able to own the workspace again');
  takeover.release();
});

test('separate workspaces do not share ownership', () => {
  const a = claimInstance({ workspaceDir: join(root, 'a'), fiberUid: 31 });
  const b = claimInstance({ workspaceDir: join(root, 'b'), fiberUid: 32 });
  assert.equal(a.owner, true);
  assert.equal(b.owner, true);
  a.release();
  b.release();
});

test('a duplicate mount of the real apply() touches no host service and records why', async () => {
  const { apply } = await import('../../lib/index.js');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const owner = claimInstance({ workspaceDir: workspace(), fiberUid: 41 });
    assert.equal(owner.owner, true);

    const seen = [];
    const allowed = new Set(['fiber', 'logger']);
    const ctx = new Proxy({ fiber: { uid: 42 }, logger: { warn: () => {} } }, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        seen.push(prop);
        if (!allowed.has(prop)) throw new Error(`duplicate apply touched ctx.${String(prop)}`);
        return target[prop];
      },
    });

    await apply(ctx, {});

    assert.deepEqual(seen.filter((p) => p !== 'fiber' && p !== 'logger'), [],
      'the duplicate copy must return before registering tools, routes, prompt sections or hooks');
    const log = readFileSync(join(workspace(), 'duplicate-mount.log'), 'utf8');
    assert.match(log, /duplicate mount ignored/);
    assert.match(log, /cordis\.patch\.yml/);
    assert.match(log, /dsh\.profile\.bundles/);
    owner.release();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('a failed first mount releases ownership instead of leaving the plugin dead', async () => {
  const { apply } = await import('../../lib/index.js');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    // No host services in this fake ctx: _applyInner must fail and the plugin must
    // record that failure, exactly as it does in a real boot.
    const broken = {
      fiber: { uid: 51 },
      logger: { warn: () => {} },
      effect: () => {},
    };
    const outcome = await apply(broken, {});
    // cordis wraps apply() in an effect: a thenable resolving to a non-disposer
    // throws `TypeError: Invalid effect`, which hides the actual cause. A degraded
    // mount must resolve to undefined and leave the log as the only signal.
    assert.equal(outcome, undefined, 'a degraded mount must not resolve to false (cordis: Invalid effect)');
    assert.equal(existsSync(join(workspace(), 'last-apply-error.log')), true,
      'the first mount must persist its own failure instead of failing silently');

    const retry = claimInstance({ workspaceDir: workspace(), fiberUid: 52 });
    assert.equal(retry.owner, true,
      'a failed mount must not keep ownership: a corrected/retried mount has to be able to run');
    retry.release();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('the real apply() re-entering on the same fiber keeps the old instance and records why', async () => {
  const { apply } = await import('../../lib/index.js');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const owner = claimInstance({ workspaceDir: workspace(), fiberUid: 71 });
    assert.equal(owner.owner, true);

    const seen = [];
    const allowed = new Set(['fiber', 'logger']);
    const ctx = new Proxy({ fiber: { uid: 71 }, logger: { warn: () => {} } }, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        seen.push(prop);
        if (!allowed.has(prop)) throw new Error(`reapply touched ctx.${String(prop)}`);
        return target[prop];
      },
    });

    await apply(ctx, {});
    assert.deepEqual(seen.filter((p) => p !== 'fiber' && p !== 'logger'), [],
      'a re-entering apply() must not rebuild tools, routes or prompt sections on top of the live ones');
    const log = readFileSync(join(workspace(), 'duplicate-mount.log'), 'utf8');
    assert.match(log, /re-entered without disposing/);
    owner.release();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('the duplicate note is written even when the workspace did not exist yet', () => {
  const deep = join(root, 'nested', 'evolve-workspace');
  reportDuplicateMount(deep, { fiber: { uid: 61 }, logger: { warn: () => {} } });
  assert.equal(existsSync(join(deep, 'duplicate-mount.log')), true);
});
