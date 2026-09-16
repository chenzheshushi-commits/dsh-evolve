/**
 * The idle trigger must read the LIVE config, not a snapshot of it.
 *
 * The bug: `enabled` was destructured into the closure as a boolean, evaluated
 * once when the plugin applied its config. setConfig() mutates the config object
 * in place, so switching disposalMode from manual to suggest in the settings page
 * changed the object but not the captured boolean -- the trigger never armed and
 * the candidate list stayed empty until the whole service restarted. The user's
 * experience was "I turned it on and nothing happens".
 *
 * Both halves are tested separately because they are different failures:
 *   predicate    -> the NEXT write sees the new value
 *   reconfigure  -> the switch takes effect NOW, without waiting for a write
 *
 * Run: node --test scripts/schema/idle-trigger.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createIdleTrigger } from '../../lib/idle-trigger.js';

/** Controllable timer so tests never actually wait. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeoutFn(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return { id, unref() { return this; } };
    },
    clearTimeoutFn(handle) {
      if (handle && typeof handle === 'object') pending.delete(handle.id);
    },
    /** Run the most recently scheduled callback. */
    async fire() {
      const last = [...pending.entries()].pop();
      if (!last) return false;
      pending.delete(last[0]);
      await last[1].fn();
      return true;
    },
    count() { return pending.size; },
    lastDelay() { return [...pending.values()].pop()?.ms; },
  };
}

test('the reproduction: flipping the config used to leave the trigger dead', async () => {
  const timers = fakeTimers();
  const cfg = { disposalMode: 'manual', idleMinutes: 5 };
  const t = createIdleTrigger({
    isEnabled: () => cfg.disposalMode === 'suggest' || cfg.disposalMode === 'tidy',
    getIdleMinutes: () => cfg.idleMinutes,
    onIdle: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  t.noteWrite();
  assert.equal(t.isArmed(), false, 'disabled: a write must not arm anything');

  // Exactly what setConfig does: mutate the object in place.
  cfg.disposalMode = 'suggest';
  t.noteWrite();
  assert.equal(t.isArmed(), true,
    'with a predicate the next write sees the new value; with a captured boolean this stayed false');
});

test('reconfigure arms immediately, without waiting for a write', () => {
  const timers = fakeTimers();
  const cfg = { disposalMode: 'manual', idleMinutes: 5 };
  const t = createIdleTrigger({
    isEnabled: () => cfg.disposalMode !== 'manual',
    getIdleMinutes: () => cfg.idleMinutes,
    onIdle: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  cfg.disposalMode = 'suggest';
  t.reconfigure();
  assert.equal(t.isArmed(), true,
    'a user who flips the toggle and then sits still is exactly who needs this');
});

test('reconfigure cancels the timer when the feature is switched off', () => {
  const timers = fakeTimers();
  const cfg = { disposalMode: 'suggest', idleMinutes: 5 };
  const t = createIdleTrigger({
    isEnabled: () => cfg.disposalMode !== 'manual',
    getIdleMinutes: () => cfg.idleMinutes,
    onIdle: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  t.noteWrite();
  assert.equal(t.isArmed(), true);

  cfg.disposalMode = 'manual';
  t.reconfigure();
  assert.equal(t.isArmed(), false, 'no timer may be left running for a disabled feature');
  assert.equal(timers.count(), 0);
});

test('turning the feature off during the idle window suppresses the callback', async () => {
  const timers = fakeTimers();
  const cfg = { disposalMode: 'suggest', idleMinutes: 5 };
  let ran = 0;
  const t = createIdleTrigger({
    isEnabled: () => cfg.disposalMode !== 'manual',
    getIdleMinutes: () => cfg.idleMinutes,
    onIdle: () => { ran += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  t.noteWrite();
  cfg.disposalMode = 'manual';   // switched off while the timer was pending
  await timers.fire();
  assert.equal(ran, 0, 'running the callback after the user turned it off contradicts the setting');
});

test('the idle window is read live too', () => {
  const timers = fakeTimers();
  const cfg = { disposalMode: 'suggest', idleMinutes: 5 };
  const t = createIdleTrigger({
    isEnabled: () => true,
    getIdleMinutes: () => cfg.idleMinutes,
    onIdle: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  t.noteWrite();
  assert.equal(timers.lastDelay(), 5 * 60000);

  cfg.idleMinutes = 20;
  t.noteWrite();
  assert.equal(timers.lastDelay(), 20 * 60000, 'a captured idleMs would still be 5 minutes');
});

test('a write re-arms rather than stacking timers', () => {
  const timers = fakeTimers();
  const t = createIdleTrigger({
    isEnabled: () => true,
    getIdleMinutes: () => 5,
    onIdle: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  t.noteWrite(); t.noteWrite(); t.noteWrite();
  assert.equal(timers.count(), 1, 'exactly one pending timer, however many writes happen');
});

test('the legacy value form still works', () => {
  // Existing callers pass enabled/idleMinutes; breaking them was not necessary
  // to fix the bug.
  const timers = fakeTimers();
  const t = createIdleTrigger({
    enabled: true,
    idleMinutes: 7,
    onIdle: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  t.noteWrite();
  assert.equal(t.isArmed(), true);
  assert.equal(timers.lastDelay(), 7 * 60000);
});

test('dispose stops everything and reconfigure cannot revive it', async () => {
  const timers = fakeTimers();
  let ran = 0;
  const t = createIdleTrigger({
    isEnabled: () => true,
    getIdleMinutes: () => 5,
    onIdle: () => { ran += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  t.noteWrite();
  t.dispose();
  assert.equal(t.isArmed(), false);
  t.reconfigure();
  assert.equal(t.isArmed(), false, 'a disposed trigger must stay disposed');
  t.noteWrite();
  assert.equal(t.isArmed(), false);
  assert.equal(ran, 0);
});

test('the callback failing does not kill the trigger', async () => {
  const timers = fakeTimers();
  const t = createIdleTrigger({
    isEnabled: () => true,
    getIdleMinutes: () => 5,
    onIdle: () => { throw new Error('recompute blew up'); },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  t.noteWrite();
  await timers.fire();          // must not reject
  t.noteWrite();
  assert.equal(t.isArmed(), true, 'a read-only refresh failing is not fatal');
});

// ── workspace .gitignore (P0) ────────────────────────────────────────────────

test('the workspace gets a .gitignore so runtime data stays out of git', async () => {
  const { MemoryStore } = await import('../../lib/store.js');
  const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const ws = mkdtempSync(join(tmpdir(), 'dsh-ign-'));
  try {
    const records = new Map();
    const table = {
      get: (id) => records.get(id) ?? null,
      entries: () => [...records.entries()],
      size: () => records.size,
      async put(id, r) { records.set(id, r); },
      async delete(id) { records.delete(id); },
      async update(id, fn) { records.set(id, fn(records.get(id))); },
    };
    const store = new MemoryStore(table, {
      workspaceDir: ws, config: {}, logger: { warn() {}, info() {} },
    });

    store._renderMirror();
    const path = join(ws, '.gitignore');
    assert.ok(existsSync(path), 'the workspace often sits inside a repo the user commits');
    const body = readFileSync(path, 'utf8');
    for (const entry of ['*.jsonl', 'skill-proposals/', '.evolve-reservations.json', '.ops/', '.wal/']) {
      assert.ok(body.includes(entry), `must ignore ${entry}`);
    }
    assert.match(body, /does not protect the files on disk/,
      'the file must not imply this makes anything safe -- the real defence is not storing secrets');

    // Upgrade an existing file without clobbering user rules. v0.6.0 adds new
    // runtime surfaces over time; returning early would leave upgraded installs
    // tracking the exact jsonl/proposal files we now need ignored.
    writeFileSync(path, '# mine\ncustom/\n');
    store._renderMirror();
    const upgraded = readFileSync(path, 'utf8');
    assert.match(upgraded, /^# mine\ncustom\//,
      'existing user rules must survive byte-for-byte at the front');
    for (const entry of ['*.jsonl', 'skill-proposals/', '.evolve-owner.json', 'secret-incidents/']) {
      assert.ok(upgraded.split('\n').includes(entry), `existing file must be upgraded with ${entry}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
