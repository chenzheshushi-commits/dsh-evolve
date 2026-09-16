/**
 * OpRegistry against a real filesystem.
 *
 * Real directories on purpose: the whole point of this module is durability
 * (tmp -> rename -> fsync, refusing to rewrite history, surviving a crash
 * mid-advance), and a mocked fs proves none of that.
 *
 * Run: node --test scripts/schema/op-registry.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpRegistry, rewriteHistory } from '../../lib/op-registry.js';

function withWorkspace(fn) {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-ops-'));
  try {
    return fn(ws, new OpRegistry({ workspaceDir: ws }));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** A manifest that satisfies the semantic contract, so tests exercise storage. */
function liveManifest(opId = 'op-1') {
  return {
    opId,
    kind: 'direct',
    source: 'autonomous-tool',
    action: 'create',
    phase: 'CREATED',
    targetName: 'my-skill',
    createdAt: '2026-09-16T00:00:00Z',
    updatedAt: '2026-09-16T00:00:00Z',
  };
}

test('create writes a manifest and read returns it', () => {
  withWorkspace((ws, reg) => {
    const m = reg.create(liveManifest());
    assert.equal(m.opId, 'op-1');
    assert.ok(existsSync(join(ws, '.ops', 'op-1', 'manifest.json')),
      'manifest must live under .ops/<opId>/, never beside the asset');
    assert.deepEqual(reg.read('op-1').phase, 'CREATED');
  });
});

test('read returns null for an operation that was never recorded', () => {
  withWorkspace((ws, reg) => {
    assert.equal(reg.read('never-existed'), null);
  });
});

test('create refuses to overwrite an existing operation', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    assert.throws(() => reg.create(liveManifest()), /already exists/);
  });
});

test('advance moves the phase forward and stamps updatedAt', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    const next = reg.advance('op-1', { phase: 'CLAIMED' });
    assert.equal(next.phase, 'CLAIMED');
    assert.notEqual(next.updatedAt, '2026-09-16T00:00:00Z', 'updatedAt must advance');
    assert.equal(next.createdAt, '2026-09-16T00:00:00Z', 'createdAt must not move');
  });
});

test('advance refuses to rewrite what the operation IS', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    for (const patch of [{ kind: 'apply' }, { opId: 'op-other' }, { targetName: 'other-skill' }]) {
      assert.throws(() => reg.advance('op-1', patch), /refusing to rewrite immutable field/,
        `patch ${JSON.stringify(patch)} must be rejected`);
    }
    assert.equal(reg.read('op-1').kind, 'direct', 'the manifest must be untouched');
  });
});

test('a terminal is final: advance refuses to reopen it', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    reg.advance('op-1', {
      phase: 'ABORTED',
      capClaim: null,
    });
    assert.throws(() => reg.advance('op-1', { phase: 'COMMITTED' }), /already terminal/);
  });
});

test('advance rejects a patch that would break the semantic contract', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    // A non-terminal phase carrying a durable error violates rule 13; the
    // registry must refuse to persist it rather than write it and hope.
    assert.throws(
      () => reg.advance('op-1', { phase: 'PREPARED', error: { code: 'EIO', message: 'x', at: '2026-09-16T01:00:00Z' } }),
      /would violate its contract/,
    );
    assert.equal(reg.read('op-1').phase, 'CREATED', 'the rejected advance must not land');
  });
});

test('completedReceipt is the retry path: it answers only for COMPLETE ops', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    assert.equal(reg.completedReceipt('op-1'), null, 'a live op has no receipt yet');

    const receipt = {
      opId: 'op-1', kind: 'direct', targetName: 'my-skill',
      archiveId: null, finalPath: null, afterContentHash: null,
    };
    reg.advance('op-1', {
      phase: 'COMPLETE',
      result: { outcome: 'ok', completedAt: '2026-09-16T02:00:00Z', receipt },
    });
    assert.deepEqual(reg.completedReceipt('op-1'), receipt,
      'a same-opId retry must get the original receipt back without re-checking the capability');
  });
});

test('a corrupt manifest is not treated as absent', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    writeFileSync(join(ws, '.ops', 'op-1', 'manifest.json'), '{ this is not json');
    assert.throws(() => reg.read('op-1'), /corrupt/,
      'treating it as absent would let a second operation start over a half-finished one');
  });
});

test('a crash between tmp and rename leaves the previous manifest intact', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    reg.advance('op-1', { phase: 'CLAIMED' });
    // Simulate the crash: a stale .tmp is present, the real file is the old one.
    writeFileSync(join(ws, '.ops', 'op-1', 'manifest.json.tmp'), '{"phase":"HALF-WRITTEN"}');
    assert.equal(reg.read('op-1').phase, 'CLAIMED',
      'the .tmp must be invisible to readers -- an un-renamed write never happened');
    // And the next advance still works, overwriting the stale tmp.
    assert.equal(reg.advance('op-1', { phase: 'PREPARED' }).phase, 'PREPARED');
  });
});

test('pendingRecovery lists interrupted operations and excludes finished ones', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest('op-live'));
    reg.advance('op-live', { phase: 'COMMITTED' });

    reg.create(liveManifest('op-done'));
    reg.advance('op-done', { phase: 'ABORTED', capClaim: null });

    const pending = reg.pendingRecovery().map((m) => m.opId);
    assert.deepEqual(pending, ['op-live'],
      'only operations that never reached a terminal need recovery');
  });
});

test('an unreadable operation is surfaced, not silently skipped', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest('op-ok'));
    mkdirSync(join(ws, '.ops', 'op-broken'), { recursive: true });
    writeFileSync(join(ws, '.ops', 'op-broken', 'manifest.json'), 'not json at all');

    const broken = reg.list().find((m) => m.opId === 'op-broken');
    assert.ok(broken, 'the broken op must appear in the listing');
    assert.equal(broken.phase, 'UNREADABLE');
    assert.ok(reg.pendingRecovery().some((m) => m.opId === 'op-broken'),
      'it is exactly the operation a human needs to see');
  });
});

test('unsafe opIds cannot escape the .ops directory', () => {
  withWorkspace((ws, reg) => {
    for (const bad of ['../escape', 'a/b', '', null]) {
      assert.throws(() => reg.dirFor(bad), /unsafe opId/, `${JSON.stringify(bad)} must be refused`);
    }
  });
});

test('rewriteHistory reports only genuine changes', () => {
  const cur = liveManifest();
  assert.deepEqual(rewriteHistory(cur, { phase: 'CLAIMED' }), [], 'advancing state is fine');
  assert.deepEqual(rewriteHistory(cur, { kind: 'direct' }), [],
    'setting a field to the value it already has is not a rewrite');
  assert.deepEqual(rewriteHistory(cur, { kind: 'apply', opId: 'x' }).sort(), ['kind', 'opId']);
});

test('the manifest on disk is pretty-printed JSON a human can read', () => {
  withWorkspace((ws, reg) => {
    reg.create(liveManifest());
    const raw = readFileSync(join(ws, '.ops', 'op-1', 'manifest.json'), 'utf8');
    assert.ok(raw.includes('\n  "opId"'), 'recovery is a human activity too');
    assert.ok(raw.endsWith('\n'), 'trailing newline');
  });
});
