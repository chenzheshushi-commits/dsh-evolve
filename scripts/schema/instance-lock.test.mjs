/**
 * Fail-closed behaviour when this instance does not own the workspace.
 *
 * Two DSH instances can point at the same evolve workspace. Everything that
 * mutates must refuse rather than race, and the refusal has to be visible: a
 * silent skip looks identical to "there was nothing to do", which is how a
 * second instance quietly deleting memories would go unnoticed.
 *
 * These tests drive the real InstanceLock, not a mock, because the interesting
 * part is what a SECOND lock attempt against the same directory actually returns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InstanceLock } from '../../lib/op-runtime.js';

function ws() {
  return mkdtempSync(join(tmpdir(), 'dsh-lock-'));
}

test('the first instance acquires and a second is refused', () => {
  const dir = ws();
  try {
    const a = new InstanceLock({ workspaceDir: dir });
    const b = new InstanceLock({ workspaceDir: dir });
    const first = a.acquire();
    assert.equal(first.acquired, true, 'the first instance must win');
    const second = b.acquire();
    assert.equal(second.acquired, false, 'the second must lose, not share');
    assert.ok(second.reason, 'and it must say why, so the UI can explain the degraded mode');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('releasing hands ownership to the next instance', () => {
  const dir = ws();
  try {
    const a = new InstanceLock({ workspaceDir: dir });
    const b = new InstanceLock({ workspaceDir: dir });
    assert.equal(a.acquire().acquired, true);
    assert.equal(b.acquire().acquired, false);
    a.release();
    assert.equal(b.acquire().acquired, true, 'a clean shutdown must not strand the workspace');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lock held by a live process is never stolen, even when stale-looking', () => {
  const dir = ws();
  try {
    const a = new InstanceLock({ workspaceDir: dir, ttlMs: 1 });
    assert.equal(a.acquire().acquired, true);
    // Same PID, so the holder is provably alive: TTL alone must not be enough to
    // steal it. Stealing from a live process is how two instances end up both
    // believing they own the workspace.
    const b = new InstanceLock({ workspaceDir: dir, ttlMs: 1, now: () => Date.now() + 60_000 });
    const verdict = b.acquire();
    assert.equal(verdict.acquired, false,
      'an expired TTL on a LIVE owner must not transfer ownership');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lock from a dead process is reclaimed', () => {
  const dir = ws();
  try {
    const a = new InstanceLock({ workspaceDir: dir });
    assert.equal(a.acquire().acquired, true);
    // Rewrite the lock as if it were left by a process that no longer exists.
    // PID 2^22 is above Linux's default pid_max, so it cannot be running.
    const lockPath = join(dir, '.locks', 'instance.lock');
    assert.ok(existsSync(lockPath), 'the lock must be a real file on disk');
    const held = JSON.parse(readFileSync(lockPath, 'utf8'));
    writeFileSync(lockPath, JSON.stringify({ ...held, pid: 4_194_303, instanceId: 'inst_dead' }));

    const b = new InstanceLock({ workspaceDir: dir });
    const verdict = b.acquire();
    assert.equal(verdict.acquired, true,
      'a crashed instance must not lock the workspace forever -- that would disable '
      + 'all automatic maintenance until someone deletes a file by hand');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt lock file does not hand out ownership', () => {
  const dir = ws();
  try {
    mkdirSync(join(dir, '.locks'), { recursive: true });
    writeFileSync(join(dir, '.locks', 'instance.lock'), '{ this is not json');
    const a = new InstanceLock({ workspaceDir: dir });
    const verdict = a.acquire();
    // Either outcome is defensible, but it must be a DECISION, not a crash: an
    // unreadable lock is exactly when a naive implementation throws and takes the
    // whole plugin down at load time.
    assert.equal(typeof verdict.acquired, 'boolean',
      'an unreadable lock must produce a verdict, not an exception');
    if (!verdict.acquired) assert.ok(verdict.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the tidy gate degrades to a visible list instead of mutating', async () => {
  // A miniature of index.js's idle callback: the branch under test is the one
  // that chooses between mutating and listing.
  const calls = { tidied: 0, listed: 0 };
  const store = {
    disposalCandidates: () => { calls.listed += 1; return [{ id: 'm1' }, { id: 'm2' }]; },
  };
  const runTidy = async () => { calls.tidied += 1; return { status: 'ok', candidates: [] }; };
  const warnings = [];

  const idleRun = async (lockAcquired) => {
    if (!lockAcquired) {
      const candidates = store.disposalCandidates();
      if (candidates.length > 0) warnings.push(`disabled: ${candidates.length} listed`);
      return candidates;
    }
    await runTidy();
    return store.disposalCandidates();
  };

  await idleRun(false);
  assert.equal(calls.tidied, 0, 'a non-owning instance must not soft-delete anything');
  assert.equal(warnings.length, 1, 'and the degradation must be reported, not silent');

  await idleRun(true);
  assert.equal(calls.tidied, 1, 'the owning instance still tidies normally');
});

test('index.js gates tidy and prune on lock ownership', () => {
  // Source-level, because the alternative is booting a full harness. Narrow and
  // specific: it names the two call sites that must be guarded.
  const src = readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8');

  const idleStart = src.indexOf("cfg.disposalMode === 'tidy'");
  assert.ok(idleStart > 0, 'the tidy branch must exist');
  // Positions in the whole file, so the window cannot clip either landmark.
  const guardAt = src.indexOf('lockVerdict.acquired', idleStart);
  const tidyAt = src.indexOf('runTidy(', idleStart);
  assert.ok(guardAt > 0, 'automatic tidy must check lock ownership before mutating');
  assert.ok(tidyAt > 0, 'runTidy must still be called by the owning instance');
  assert.ok(guardAt < tidyAt,
    'the ownership check must come BEFORE runTidy, not after it');

  const execStart = src.indexOf('async function execute(planDigest');
  assert.ok(execStart > 0);
  const execBlock = src.slice(execStart, execStart + 1200);
  assert.match(execBlock, /mutationsAllowed/,
    'prune execute must refuse when another instance owns the workspace');
  assert.ok(execBlock.indexOf('mutationsAllowed') < execBlock.indexOf('lookupAndClaim'),
    'the refusal must happen before the plan is claimed, or the digest is burned '
    + 'and cannot be retried once the owning instance goes away');

  // And the dependency is actually injected, since the gate reads it from the
  // controller's own scope.
  assert.match(src, /makePruneController\(\{ store, workspaceDir, cfg, skillOps, mutationsAllowed \}\)/,
    'the controller must receive mutationsAllowed, or the gate is a ReferenceError');
});
