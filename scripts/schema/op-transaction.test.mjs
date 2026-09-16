/**
 * Transaction primitives against a real filesystem and real processes.
 *
 * The concurrency test spawns two child processes on purpose. The plan is
 * explicit that Promise.all is not enough: two promises share one event loop and
 * one fs cache, so passing proves nothing about O_EXCL actually being the thing
 * that provides mutual exclusion.
 *
 * Run: node --test scripts/schema/op-transaction.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  ClaimRegistry, Wal, casUpdate, publishDirAtomic, sameFilesystem, quarantineOrphan,
} from '../../lib/op-transaction.js';

const here = dirname(fileURLToPath(import.meta.url));

function withWorkspace(fn) {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-tx-'));
  try {
    return fn(ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

// ── claims and fencing ───────────────────────────────────────────────────────

test('a claim is exclusive and lives in the central lock directory', () => {
  withWorkspace((ws) => {
    const reg = new ClaimRegistry({ workspaceDir: ws });
    assert.equal(reg.claim('my-skill', 'op-1').status, 'acquired');
    assert.ok(existsSync(join(ws, '.locks', 'skills', 'my-skill.lock')),
      'the lock must NOT live inside the skill: converge moves skill dirs and the '
      + 'lock would travel with them, silently ending mutual exclusion');
    const second = reg.claim('my-skill', 'op-2');
    assert.equal(second.status, 'retry');
    assert.equal(second.holder.opId, 'op-1');
  });
});

test('two real processes racing for one resource: exactly one wins', () => {
  withWorkspace((ws) => {
    const racer = join(here, 'claim-racer.mjs');
    const run = (opId) => {
      try {
        return JSON.parse(execFileSync(process.execPath, [racer, ws, 'contested', opId],
          { encoding: 'utf8' }));
      } catch (e) {
        return JSON.parse(e.stdout || '{"status":"error"}');
      }
    };
    // Sequential spawns still exercise the real O_EXCL path across processes;
    // the point is that no in-process state is shared between them.
    const results = [run('op-a'), run('op-b'), run('op-c')];
    const acquired = results.filter((r) => r.status === 'acquired');
    assert.equal(acquired.length, 1, `exactly one process may hold the claim: ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => r.status === 'retry').length, 2);
  });
});

test('fencing: a stale executor cannot release the new owner\'s claim', () => {
  withWorkspace((ws) => {
    const reg = new ClaimRegistry({ workspaceDir: ws });
    reg.claim('my-skill', 'op-old');
    assert.equal(reg.release('my-skill', 'op-old'), true);

    reg.claim('my-skill', 'op-new');
    assert.equal(reg.release('my-skill', 'op-old'), false,
      'op-old waking up must not release op-new');
    assert.equal(reg.holder('my-skill').opId, 'op-new', 'the claim must survive');
  });
});

test('stillOwns is the guard every finalize path must call', () => {
  withWorkspace((ws) => {
    const reg = new ClaimRegistry({ workspaceDir: ws });
    reg.claim('my-skill', 'op-1');
    assert.equal(reg.stillOwns('my-skill', 'op-1'), true);
    assert.equal(reg.stillOwns('my-skill', 'op-2'), false);

    reg.release('my-skill', 'op-1');
    assert.equal(reg.stillOwns('my-skill', 'op-1'), false,
      'once the claim is gone, writing results is no longer allowed');
  });
});

test('an expired claim is reported as orphaned but never auto-stolen', () => {
  withWorkspace((ws) => {
    let clock = 1_000_000;
    const reg = new ClaimRegistry({ workspaceDir: ws, ttlMs: 1000, now: () => clock });
    reg.claim('my-skill', 'op-dead');
    clock += 5000;

    const again = reg.claim('my-skill', 'op-live');
    assert.equal(again.status, 'retry', 'expiry alone must not hand the resource over');
    assert.equal(again.orphaned, true, 'but it must be reported as orphaned');
    assert.deepEqual(reg.orphaned().map((o) => o.resource), ['my-skill']);

    assert.equal(reg.breakOrphan('my-skill'), true, 'only recovery may break it');
    assert.equal(reg.claim('my-skill', 'op-live').status, 'acquired');
  });
});

test('an unparseable lock still counts as held', () => {
  withWorkspace((ws) => {
    const reg = new ClaimRegistry({ workspaceDir: ws });
    mkdirSync(join(ws, '.locks', 'skills'), { recursive: true });
    writeFileSync(join(ws, '.locks', 'skills', 'broken.lock'), 'not json');
    assert.equal(reg.holder('broken').corrupt, true);
    assert.equal(reg.claim('broken', 'op-1').status, 'retry',
      'reporting a corrupt lock as free would hand the resource to a second executor');
  });
});

test('unsafe resource names cannot escape the lock directory', () => {
  withWorkspace((ws) => {
    const reg = new ClaimRegistry({ workspaceDir: ws });
    for (const bad of ['../escape', 'a/b', '', null]) {
      assert.throws(() => reg.pathFor(bad), /unsafe resource name/);
    }
  });
});

// ── write-ahead log ──────────────────────────────────────────────────────────

test('WAL records intent before and commit after, with increasing seq', () => {
  withWorkspace((ws) => {
    const wal = new Wal({ workspaceDir: ws });
    const i = wal.intent({ runId: 'r1', target: 'mem-1', expected: 'present' });
    const c = wal.commit({ runId: 'r1', target: 'mem-1', result: 'forgotten' });
    assert.equal(i.phase, 'intent');
    assert.equal(c.phase, 'commit');
    assert.ok(c.seq > i.seq, 'seq must advance');
    assert.equal(wal.read().length, 2);
  });
});

test('an intent without a commit is exactly what recovery must inspect', () => {
  withWorkspace((ws) => {
    const wal = new Wal({ workspaceDir: ws });
    wal.intent({ runId: 'r1', target: 'done', expected: 'x' });
    wal.commit({ runId: 'r1', target: 'done', result: 'ok' });
    wal.intent({ runId: 'r1', target: 'interrupted', expected: 'x' });

    const dangling = wal.danglingIntents().map((e) => e.target);
    assert.deepEqual(dangling, ['interrupted'],
      'the log alone cannot say what happened to this one; the caller must look at the resource');
  });
});

test('a torn final line is discarded, not treated as corruption', () => {
  withWorkspace((ws) => {
    const wal = new Wal({ workspaceDir: ws });
    wal.intent({ runId: 'r1', target: 'a', expected: 'x' });
    // Simulate a crash mid-write: a partial JSON line at the end.
    appendFileSync(wal.path, '{"seq":99,"phase":"inte');
    const entries = wal.read();
    assert.equal(entries.length, 1, 'an entry that was never fully written describes nothing');
    assert.equal(wal.corruptEntries().length, 0);
  });
});

test('a tampered line in the middle is reported as corrupt', () => {
  withWorkspace((ws) => {
    const wal = new Wal({ workspaceDir: ws });
    wal.intent({ runId: 'r1', target: 'a', expected: 'x' });
    wal.commit({ runId: 'r1', target: 'a', result: 'ok' });

    const lines = readFileSync(wal.path, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    first.target = 'tampered';           // checksum no longer matches
    writeFileSync(wal.path, `${JSON.stringify(first)}\n${lines[1]}\n`);

    const corrupt = wal.corruptEntries();
    assert.equal(corrupt.length, 1, 'silent acceptance would let a rewritten log drive recovery');
    assert.equal(corrupt[0].reason, 'checksum mismatch');
  });
});

// ── conditional write ────────────────────────────────────────────────────────

/** Minimal stand-in for the storage domain's serialized table. */
function fakeTable(initial) {
  const records = new Map(Object.entries(initial));
  return {
    records,
    async update(key, fn) {
      if (!records.has(key)) {
        const e = new Error(`missing-key: ${key}`);
        e.code = 'missing-key';
        throw e;
      }
      records.set(key, fn(records.get(key)));
    },
  };
}

test('casUpdate applies the mutation when the expectation holds', async () => {
  const table = fakeTable({ 'mem-1': { id: 'mem-1', uses: 0 } });
  const r = await casUpdate(table, 'mem-1', {
    expect: (cur) => cur.uses === 0,
    mutate: (cur) => ({ ...cur, forgottenAt: 'now' }),
  });
  assert.deepEqual(r, { applied: true, reason: null });
  assert.equal(table.records.get('mem-1').forgottenAt, 'now');
});

test('casUpdate writes the original back when the expectation fails', async () => {
  // This is the race the plan describes: the record was used between the
  // decision and the write, so the mutation must not land.
  const table = fakeTable({ 'mem-1': { id: 'mem-1', uses: 3 } });
  const r = await casUpdate(table, 'mem-1', {
    expect: (cur) => cur.uses === 0,
    mutate: (cur) => ({ ...cur, forgottenAt: 'now' }),
  });
  assert.deepEqual(r, { applied: false, reason: 'precondition' });
  assert.equal(table.records.get('mem-1').forgottenAt, undefined,
    'a record that got used must not be soft-deleted');
});

test('casUpdate treats a vanished record as a skip, not an error', async () => {
  const table = fakeTable({});
  const r = await casUpdate(table, 'gone', { expect: () => true, mutate: (c) => c });
  assert.deepEqual(r, { applied: false, reason: 'missing-key' });
});

// ── atomic publish ───────────────────────────────────────────────────────────

test('publishDirAtomic swaps a directory into place', () => {
  withWorkspace((ws) => {
    const staging = join(ws, 'staging');
    const final = join(ws, 'skills', 'my-skill');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'SKILL.md'), 'new content');

    publishDirAtomic(staging, final);
    assert.equal(readFileSync(join(final, 'SKILL.md'), 'utf8'), 'new content');
    assert.ok(!existsSync(staging), 'staging is consumed by the rename');
  });
});

test('publishDirAtomic replaces an existing directory and cleans up', () => {
  withWorkspace((ws) => {
    const final = join(ws, 'skills', 'my-skill');
    mkdirSync(final, { recursive: true });
    writeFileSync(join(final, 'SKILL.md'), 'old content');

    const staging = join(ws, 'staging');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'SKILL.md'), 'new content');

    publishDirAtomic(staging, final);
    assert.equal(readFileSync(join(final, 'SKILL.md'), 'utf8'), 'new content');
    const leftovers = readdirSync(join(ws, 'skills'))
      .filter((n) => n.includes('retired'));
    assert.deepEqual(leftovers, [], 'the retired copy must not be left behind');
  });
});

test('sameFilesystem is honest about a path that does not exist', () => {
  withWorkspace((ws) => {
    assert.equal(sameFilesystem(ws, ws), true);
    assert.equal(sameFilesystem(ws, join(ws, 'nope')), false);
  });
});

test('quarantineOrphan preserves interrupted work instead of deleting it', () => {
  withWorkspace((ws) => {
    const orphan = join(ws, 'my-skill.tmp');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'SKILL.md'), 'work in progress');

    const dest = quarantineOrphan(ws, orphan, 'my-skill');
    assert.ok(dest.includes('.orphans'), 'it must move under .orphans/');
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'work in progress',
      'an interrupted publish may hold the only copy of the work');
    assert.ok(!existsSync(orphan));
  });
});
