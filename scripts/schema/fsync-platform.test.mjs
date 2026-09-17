/**
 * fsync platform contract.
 *
 * Windows FlushFileBuffers requires GENERIC_WRITE: fsync on a handle opened 'r'
 * fails with EPERM, and fsync on a directory handle always does. v0.6.0 shipped
 * lib/skill-proposals.js with a bare `openSync(p,'r') + fsyncSync` and an
 * unguarded fsyncDir, so ProposalStore.create() -- the single entry point of the
 * proposal pipeline, reached by skill_rollback and by every crystallize/refine/
 * fold/converge in the DEFAULT manual/balanced modes -- threw EPERM on Windows.
 *
 * These checks are deliberately structural rather than name-based. The first
 * version of this file asked "does the openSync target LOOK like a directory?"
 * by regex-matching the variable name, and kept a hand-written list of modules to
 * scan. An external review defeated both in one move: renaming a parameter from
 * `p` to `dir` while reverting 'r+' to 'r' put the original bug back with the
 * gate still green, and a brand-new module with the same bug was never even read.
 * Judge the call site, and discover the files.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const libDir = fileURLToPath(new URL('../../lib/', import.meta.url));
const read = (f) => readFileSync(`${libDir}${f}`, 'utf8');

/**
 * Find PATH-LEVEL fsyncs: code that opens a path itself and then flushes it.
 * Those are the ones bound by the platform rules, and they must all live in
 * lib/fsync.js -- four private copies existed in v0.6.1 and two carried a
 * different error-code list, so one unsyncable filesystem produced two
 * behaviours.
 *
 * Flushing a handle you ALREADY hold in write mode (openSync(tmp,'w') ... fsync)
 * is a different thing and stays where it is: the mode is right there at the call
 * site, and centralising it would mean passing file descriptors around.
 *
 * Discovered by scanning, never hand-listed: a hand-written module list left a
 * brand-new module with the identical bug completely unread.
 */
function pathLevelFsyncModules() {
  const all = readdirSync(libDir).filter((f) => f.endsWith('.js') && f !== 'fsync.js');
  const offenders = [];
  for (const f of all) {
    const text = read(f);
    // openSync(<path>, 'r' | 'r+') followed by an fsyncSync in the same vicinity:
    // a handle opened purely in order to flush it. Handles already open for
    // writing ('w'/'wx'/'a') are a different pattern and stay put.
    for (const m of text.matchAll(/openSync\([^)]*?,\s*'r\+?'\s*\)/g)) {
      const after = text.slice(m.index, m.index + 400);
      if (/fsyncSync\s*\(/.test(after)) { offenders.push(f); break; }
    }
  }
  return [...new Set(offenders)];
}

test('no module outside lib/fsync.js opens a path just to fsync it', () => {
  const offenders = pathLevelFsyncModules();
  assert.deepEqual(offenders, [],
    'these modules open a path themselves in order to fsync it instead of calling '
    + 'the shared helpers, and such a copy drifts from the platform rules exactly '
    + `as the four v0.6.1 copies did: ${offenders.join(', ')}`);
});

/** ...and the shared module must genuinely be the one doing it. */
test('lib/fsync.js is the module that performs the flush', () => {
  const text = read('fsync.js');
  assert.match(text, /openSync\(/, 'lib/fsync.js must open the handle');
  assert.match(text, /fsyncSync\(/, 'lib/fsync.js must perform the fsync');
  for (const name of ['fsyncDir', 'fsyncFile', 'FSYNC_SOFT_FAIL']) {
    assert.ok(text.includes(`export ${/^[A-Z]/.test(name) ? 'const' : 'function'} ${name}`),
      `lib/fsync.js must export ${name}`);
  }
});

/**
 * The real rule: a file fsync must not use an O_RDONLY handle. Checked by call
 * SITE -- the openSync literal immediately preceding an fsyncSync -- so renaming
 * the variable changes nothing.
 */
test('no fsync reaches a regular file through an O_RDONLY handle', () => {
  const text = read('fsync.js');
  // Collect (mode, isDirHelper) for each flush path by reading the exported
  // wrappers, not by guessing from identifiers.
  const dirFn = text.slice(text.indexOf('export function fsyncDir'));
  const fileFn = text.slice(text.indexOf('export function fsyncFile'));
  assert.match(dirFn.slice(0, 200), /flush\([^,]+,\s*'r'\)/,
    'fsyncDir is expected to open a directory read-only (soft-failed everywhere)');
  assert.match(fileFn.slice(0, 200), /flush\([^,]+,\s*'r\+'\)/,
    "fsyncFile must open 'r+': 'r' is refused by Windows and 'w' truncates the file");
  assert.equal(/flush\([^,]+,\s*'w'\)/.test(text), false,
    "'w' truncates -- it must never be used to fsync an existing file");
});

/** The soft-fail list must cover the codes real platforms raise. */
test('the fsync soft-fail list covers EPERM (Windows) and ENOTSUP', () => {
  const text = read('fsync.js');
  const m = /FSYNC_SOFT_FAIL\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]/s.exec(text)
    ?? /FSYNC_SOFT_FAIL\s*=\s*\[([^\]]*)\]/s.exec(text);
  assert.ok(m, 'lib/fsync.js must export a single FSYNC_SOFT_FAIL list');
  for (const code of ['EINVAL', 'EACCES', 'EPERM', 'EISDIR', 'ENOTSUP']) {
    assert.ok(m[1].includes(`'${code}'`), `soft-fail list is missing ${code}`);
  }
});

/**
 * A refusal must be reported, not swallowed. This is the property whose absence
 * made fsyncTree a no-op on Windows for a whole release, and no runtime test can
 * see it: the swallowed EPERM looks exactly like success.
 */
test('both fsync helpers report whether the flush happened', () => {
  const text = read('fsync.js');
  for (const name of ['fsyncDir', 'fsyncFile']) {
    const start = text.indexOf(`export function ${name}(`);
    assert.ok(start > 0, `lib/fsync.js must export ${name}`);
    const body = text.slice(start, text.indexOf('\n}', start));
    assert.match(body, /return\s+flush\(/,
      `${name} must return the flush result; a caller that cannot tell success from `
      + 'a platform refusal will publish a durability claim it cannot back');
  }
  assert.match(text, /return\s+true;/, 'flush must report success');
  assert.match(text, /return\s+false;/, 'flush must report a soft refusal');
  // A refusal is reported ONLY for the known platform codes. Reporting false for
  // everything turns a real I/O error (ENOSPC, EIO) into "the platform declined",
  // which is how a genuinely failed write gets treated as an acceptable outcome.
  const flushFn = text.slice(text.indexOf('function flush('), text.indexOf('\n}', text.indexOf('function flush(')));
  assert.match(flushFn, /FSYNC_SOFT_FAIL\.includes\(/,
    'flush must consult the soft-fail list, not blanket-swallow every error');
  assert.match(flushFn, /throw\s+e;/,
    'flush must rethrow codes outside the soft-fail list: ENOSPC/EIO are real failures, '
    + 'not platform refusals');
});

/**
 * fsyncTree must propagate a FILE refusal, and every publish protocol must check
 * it before writing a marker. The marker's whole meaning is "these bytes are on
 * disk"; writing it after a failed flush is the lie that recovery later trusts.
 */
test('a tree whose files could not be flushed never gets a marker', () => {
  const runtime = read('op-runtime.js');
  const tree = runtime.slice(runtime.indexOf('export function fsyncTree'));
  assert.match(tree, /unsynced/,
    'fsyncTree must track which files refused to flush');
  assert.match(tree, /return\s*\{\s*ok:/,
    'fsyncTree must return a verdict, not undefined');
  // The verdict has to come from the helper's RESULT. Calling fsyncFile and
  // discarding what it says is precisely the v0.6.0 bug: the refusal existed, the
  // caller never looked, and the marker went out anyway.
  assert.match(tree, /!\s*fsyncFile\(|fsyncFile\([^)]*\)\s*===\s*false|const\s+\w+\s*=\s*fsyncFile\(/,
    'fsyncTree must branch on fsyncFile\'s return value; ignoring it makes the '
    + 'unsynced list permanently empty and ok permanently true');

  const protocols = read('publish-protocols.js');
  const calls = [...protocols.matchAll(/fsyncTree\(/g)];
  assert.ok(calls.length >= 3, `every publish path must fsync its tree (found ${calls.length})`);
  const guards = [...protocols.matchAll(/if\s*\(!\s*synced\.ok\s*\)/g)];
  assert.equal(guards.length, calls.length,
    `every fsyncTree call must be followed by a refusal check before writeMarker `
    + `(${calls.length} calls, ${guards.length} guards)`);
  // And the guard must come BEFORE the marker in each protocol body.
  for (const m of protocols.matchAll(/const synced = fsyncTree\([^)]*\);/g)) {
    const after = protocols.slice(m.index, m.index + 700);
    const guardAt = after.search(/if\s*\(!\s*synced\.ok\s*\)/);
    const markerAt = after.search(/writeMarker\(/);
    assert.ok(guardAt >= 0 && markerAt >= 0 && guardAt < markerAt,
      'the refusal check must precede writeMarker, or the marker is published anyway');
  }
});

/** A real round trip through the proposal pipeline. */
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
 * Runtime proof that fsyncFile actually opens a WRITE-capable handle, closing the
 * gap the review found: on a read-only file, 'r+' cannot be opened at all, so the
 * helper must report a refusal. A helper that had reverted to 'r' would open the
 * handle happily and -- on Linux -- return true.
 *
 * POSIX-only: Windows ignores chmod on the write bit for files owned by the user,
 * and root ignores it everywhere.
 */
test('fsyncFile needs a write-capable handle (runtime, POSIX)', async (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) {
    t.skip('chmod-based read-only files are not enforced here');
    return;
  }
  const { fsyncFile } = await import('../../lib/fsync.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-evolve-ro-'));
  try {
    const f = join(root, 'locked.txt');
    readFileSync;                              // keep the import list honest
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f, 'x');
    chmodSync(f, 0o400);                       // read-only: 'r+' must fail, 'r' would not
    assert.equal(fsyncFile(f), false,
      "fsyncFile reported success on a read-only file, which means it is not opening 'r+'");
  } finally {
    try { chmodSync(join(root, 'locked.txt'), 0o600); } catch { /* already gone */ }
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

/**
 * A fixture that tests read but git ignores is worse than a missing fixture: the
 * suite is green locally, the commit says the fixture was added, and CI fails on a
 * fresh clone. This repo's blanket `*.tgz` (aimed at pack output) swallowed
 * scripts/schema/fixtures/symlink-escape.tgz exactly that way.
 */
test('every test fixture on disk is actually tracked by git', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  let names;
  try { names = readdirSync(dir); } catch { return; }   // no fixtures yet is fine
  assert.ok(names.length > 0, 'the fixtures directory exists but is empty');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  for (const name of names) {
    const rel = `scripts/schema/fixtures/${name}`;
    const out = spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: repo, encoding: 'utf8' });
    assert.equal(out.status, 0,
      `${rel} exists on disk but git does not track it -- check .gitignore, `
      + 'a fresh clone would not have it');
  }
});
