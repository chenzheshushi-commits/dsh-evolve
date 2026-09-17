/**
 * fsync platform contract (v0.6.1 / F1).
 *
 * Windows FlushFileBuffers requires GENERIC_WRITE: fsync on a handle opened 'r'
 * fails with EPERM, and fsync on a directory handle always does. v0.6.0 shipped
 * lib/skill-proposals.js with a bare `openSync(p,'r') + fsyncSync` and an
 * unguarded fsyncDir, so ProposalStore.create() -- the single entry point of the
 * proposal pipeline, reached by skill_rollback and by every crystallize/refine/
 * fold/converge in the DEFAULT manual/balanced modes -- threw EPERM on Windows.
 * None of the three call sites (index.js) catches it, so the contract return
 * `{proposed:false, reason}` never happened; the tool threw instead.
 *
 * These tests are platform-independent by construction: they assert on the
 * SOURCE-level contract (which open mode, which soft-fail codes) plus a real
 * round trip, so a Linux-only CI still catches a regression that would only
 * BITE on Windows. Mutation-proven: reverting either fix reds this file.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = (f) => readFileSync(new URL(`../../lib/${f}`, import.meta.url), 'utf8');

/** Every fsync of a REGULAR FILE must use a write-capable mode. */
test('no fsync of a regular file goes through an O_RDONLY handle', () => {
  for (const f of ['skill-proposals.js', 'op-runtime.js', 'op-registry.js',
                   'op-transaction.js', 'publish-protocols.js', 'skills.js',
                   'reservations.js', 'skill-operations.js', 'prune-plan.js']) {
    const text = src(f);
    // Collect every openSync(...) call and the mode literal it passes.
    for (const m of text.matchAll(/openSync\(\s*([^,)]+?)\s*,\s*'([^']+)'/g)) {
      const [, target, mode] = m;
      if (mode === 'r') {
        // 'r' is only legal when the target is a DIRECTORY (dir fsync is
        // soft-failed on every platform anyway).
        assert.ok(
          /dir|dirname|\bd\b|root|this\.root/i.test(target),
          `${f}: openSync(${target}, 'r') looks like a FILE fsync; Windows rejects it. Use 'r+'.`,
        );
      }
    }
  }
});

/** The soft-fail list must include the codes Windows actually raises. */
test('fsync soft-fail lists cover EPERM (Windows) and ENOTSUP', () => {
  for (const f of ['skill-proposals.js', 'op-runtime.js']) {
    const text = src(f);
    const lists = [...text.matchAll(/\[((?:\s*'[A-Z]+'\s*,?)+)\]/g)]
      .map((m) => m[1])
      .filter((l) => l.includes('EINVAL') || l.includes('EPERM'));
    assert.ok(lists.length > 0, `${f}: no fsync soft-fail code list found`);
    for (const l of lists) {
      assert.ok(l.includes('EPERM'), `${f}: soft-fail list missing EPERM: [${l}]`);
      assert.ok(l.includes('ENOTSUP'), `${f}: soft-fail list missing ENOTSUP: [${l}]`);
    }
  }
});

/** skill-proposals.js must guard fsyncDir, not just close the handle. */
test('every fsync helper catches, it does not only finally-close', () => {
  const text = src('skill-proposals.js');
  // Slice each helper at its OWN closing brace, not at the next declaration:
  // a body that runs to the following function would borrow that function's
  // catch and this assertion would pass with no guard at all (mutation-proven).
  for (const name of ['fsyncDir', 'fsyncFile']) {
    const start = text.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `skill-proposals.js has no ${name}`);
    const end = text.indexOf('\n}', start);
    assert.ok(end > start, `${name}: cannot find end of body`);
    const fn = text.slice(start, end);
    assert.ok(/catch\s*\(/.test(fn),
      `${name} has no catch: an fsync EPERM on Windows would propagate to the caller`);
    assert.ok(/FSYNC_SOFT_FAIL/.test(fn),
      `${name} must soft-fail through the shared code list, not swallow everything`);
    assert.ok(/finally/.test(fn), `${name} must still close the handle`);
  }
});

/** op-runtime must expose a file-specific fsync and use it inside fsyncTree. */
test('fsyncTree syncs files through the write-capable helper', () => {
  const text = src('op-runtime.js');
  assert.ok(/export function fsyncFile/.test(text), 'op-runtime.js exports no fsyncFile');
  assert.ok(/fsyncPath\(\s*file\s*,\s*'r\+'\s*\)/.test(text), "fsyncFile must open 'r+'");
  const tree = text.slice(text.indexOf('export function fsyncTree'));
  assert.ok(/entry\.isFile\(\)\)\s*fsyncFile\(/.test(tree),
    'fsyncTree still syncs files via the directory helper: on Windows those files are never flushed');
});

/** A real round trip through the proposal pipeline. On Windows this is the test
 *  that would have caught F1 outright; on Linux it guards the happy path. */
test('ProposalStore survives a full create/read/update/claim round trip', async () => {
  const { ProposalStore } = await import('../../lib/skill-proposals.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-evolve-fsync-'));
  try {
    const store = new ProposalStore({
      workspaceDir: join(root, 'ws'), skillsDir: join(root, 'skills'), ownerId: 'o1',
    });
    const p = store.create({ action: 'crystallize', targetSkill: 'demo', body: '# demo\n' });
    assert.equal(p.state, 'pending');
    assert.ok(existsSync(join(root, 'ws', 'skill-proposals', p.id, 'meta.json')));
    assert.equal(store.read(p.id).body.trim(), '# demo');
    assert.equal(store.update(p.id, { state: 'stale' }).state, 'stale');
    assert.equal(store.claim(p.id, 'op1').status, 'stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The `test` script is a hand-written file list, so a new *.test.mjs is easy to
 * write and then never run -- exactly the "looks guarded, actually unguarded"
 * failure this release is about. Cheapest possible guard against it.
 */
test('every scripts/schema/*.test.mjs is wired into the test scripts', () => {
  const dir = new URL('.', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
  for (const key of ['test', 'test:contracts']) {
    for (const f of files) {
      assert.ok(pkg.scripts[key].includes(f), `package.json scripts.${key} never runs ${f}`);
    }
  }
});
