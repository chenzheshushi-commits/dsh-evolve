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
import {
  readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, chmodSync,
  writeFileSync, openSync, closeSync,
} from 'node:fs';
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
 *
 * Arguments are split by BRACKET BALANCE, not by regex. The v0.6.2 version used
 * /openSync\([^)]*?,\s*'r\+?'\s*\)/, whose `[^)]` cannot cross a nested call, so
 * `openSync(dirname(file), 'r')` in lib/skills.js was invisible -- the one real
 * offender in the tree. Hoisting that argument into a local variable, changing
 * nothing about the behaviour, made the same gate go red. A judgement that depends
 * on how an expression is spelled is the same defect as judging by variable name,
 * one level up.
 */
function splitCallArgs(text, openIdx) {
  // openIdx points just past the '(' of the call. Returns the top-level arguments.
  let depth = 1;
  let i = openIdx;
  const args = [];
  let cur = '';
  let quote = null;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
    } else if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch; cur += ch;
    } else if ('([{'.includes(ch)) {
      depth += 1; cur += ch;
    } else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) break;
      cur += ch;
    } else if (ch === ',' && depth === 1) {
      args.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
    i += 1;
  }
  args.push(cur.trim());
  return { args, end: i };
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/**
 * Text from `from` to the end of the block that contains it, so "is this handle
 * flushed?" is answered within one scope instead of within N characters.
 */
function enclosingBlock(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth === 0) return text.slice(from, i);
      depth -= 1;
    }
  }
  return text.slice(from);
}

/** Every openSync(<path>, 'r'|'r+') whose handle is then fsynced. */
function pathLevelFsyncs(text) {
  const hits = [];
  const unknownModes = [];
  for (const m of text.matchAll(/openSync\(/g)) {
    const { args, end } = splitCallArgs(text, m.index + m[0].length);
    if (args.length < 2) continue;
    const raw = args[1].trim();
    // Quote style is not semantics: openSync(p, "r") is the same call as
    // openSync(p, 'r'). v0.6.3 compared against "'r'" literally, so the double-quoted
    // form was invisible -- the identical half-measure the bracket-balanced splitting
    // was introduced to end.
    const lit = /^(['"`])(.*)\1$/.exec(raw);
    if (!lit) {
      // A computed mode cannot be judged statically. Treat it as suspicious rather
      // than as compliant: `const M='r'; openSync(p, M)` would otherwise walk past.
      unknownModes.push({ line: lineOf(text, m.index), arg: args[0], mode: raw });
      continue;
    }
    const mode = lit[2];
    // Only read modes matter: a handle already open for writing carries its mode
    // at the call site and is a different, legitimate pattern.
    if (mode !== 'r' && mode !== 'r+') continue;
    // Look to the end of the ENCLOSING BLOCK, not a fixed character budget. v0.6.3
    // used `end + 400`, and this repo already has single-line modules hundreds of
    // characters wide (reservations.js:6, skill-proposals.js:53), where an open and
    // its flush trivially land more than 400 apart.
    if (!/fsyncSync\s*\(/.test(enclosingBlock(text, end))) continue;
    hits.push({ line: lineOf(text, m.index), arg: args[0], mode });
  }
  // A computed mode next to an fsync is reported too: it may be 'r'.
  for (const u of unknownModes) {
    if (/fsyncSync\s*\(/.test(text)) hits.push({ ...u, computed: true });
  }
  return hits;
}

function pathLevelFsyncModules() {
  // Recursive: lib/ is flat today, but the moment anyone groups modules into
  // lib/ops/ or lib/memory/ a single-level scan silently stops covering them.
  const all = readdirSync(libDir, { recursive: true })
    .map((f) => String(f).split('\\').join('/'))
    .filter((f) => f.endsWith('.js') && f !== 'fsync.js');
  const offenders = [];
  for (const f of all) {
    for (const hit of pathLevelFsyncs(read(f))) {
      offenders.push(`${f}:${hit.line} openSync(${hit.arg}, ${hit.computed ? `${hit.mode} (computed)` : `'${hit.mode}'`})`);
    }
  }
  return offenders;
}

test('no module outside lib/fsync.js opens a path just to fsync it', () => {
  const offenders = pathLevelFsyncModules();
  assert.deepEqual(offenders, [],
    'these modules open a path themselves in order to fsync it instead of calling '
    + 'the shared helpers, and such a copy drifts from the platform rules exactly '
    + `as the four v0.6.1 copies did:\n  ${offenders.join('\n  ')}`);
});

/**
 * The scan must survive the spelling that defeated the previous one. Without this,
 * a future "simplification" back to a regex would silently restore the blind spot.
 */
test('the path-level scan sees through a nested call in the argument', () => {
  const spellings = [
    "const fd = openSync(p, 'r'); fsyncSync(fd);",
    "const fd = openSync(dirname(file), 'r'); fsyncSync(fd);",
    "const fd = openSync(join(a, b), 'r+'); fsyncSync(fd);",
    "const fd = openSync(resolve(dirname(x), '..'), 'r'); fsyncSync(fd);",
  ];
  for (const src of spellings) {
    assert.equal(pathLevelFsyncs(src).length, 1,
      `the scan missed a path-level fsync written as: ${src}`);
  }
  // And it must NOT flag a handle already opened for writing.
  for (const ok of ["const fd = openSync(tmp, 'w'); fsyncSync(fd);",
                    "const fd = openSync(p, 'wx'); fsyncSync(fd);",
                    "const fd = openSync(logPath, 'a', 0o600); fsyncSync(fd);"]) {
    assert.equal(pathLevelFsyncs(ok).length, 0,
      `the scan wrongly flagged a write-mode handle: ${ok}`);
  }
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
  assert.match(dirFn.slice(0, 300), /flush\([^,]+,\s*'r'\s*,/,
    'fsyncDir is expected to open a directory read-only (soft-failed everywhere)');
  assert.match(fileFn.slice(0, 300), /flush\([^,]+,\s*'r\+'\s*,/,
    "fsyncFile must open 'r+': 'r' is refused by Windows and 'w' truncates the file");
  assert.equal(/flush\([^,]+,\s*'w'/.test(text), false,
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
  assert.match(text, /outcome:\s*FSYNC_FLUSHED/, 'flush must report success');
  assert.match(text, /ok:\s*false/, 'flush must report a soft refusal');
  // The two refusal kinds must stay distinguishable. Collapsing them is what made a
  // single read-only file abort an entire publish in v0.6.2.
  for (const k of ['FSYNC_UNSUPPORTED', 'FSYNC_NOT_WRITABLE']) {
    assert.ok(text.includes(`export const ${k}`), `lib/fsync.js must export ${k}`);
  }
  assert.match(text, /NOT_WRITABLE\s*=\s*Object\.freeze/,
    'the "this object is read-only" codes must be a named list, not inline literals');
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
test('a refused flush is recorded on the marker, not turned into a failure', () => {
  const runtime = read('op-runtime.js');
  const tree = runtime.slice(runtime.indexOf('export function fsyncTree'));
  // fsyncTree must still branch on the helper's RESULT -- discarding it is the
  // v0.6.0 bug where every refusal was invisible.
  assert.match(tree, /const\s+\w+\s*=\s*fsyncFile\(/,
    'fsyncTree must capture fsyncFile\'s result; ignoring it makes every refusal invisible');
  assert.match(tree, /FSYNC_NOT_WRITABLE/,
    'fsyncTree must separate a read-only file from an unsupported platform');
  assert.match(tree, /unsynced/, 'fsyncTree must report which files were not flushed');
  assert.match(tree, /unsupported/, 'fsyncTree must report platform refusals separately');

  const protocols = read('publish-protocols.js');
  const calls = [...protocols.matchAll(/fsyncTree\(/g)];
  assert.ok(calls.length >= 3, `every publish path must fsync its tree (found ${calls.length})`);

  // Every marker write must go through the stamping helper, so a degraded publish
  // is always recorded. A plain writeMarker(dir, marker) would publish silently.
  const bare = [...protocols.matchAll(/writeMarker\(\s*\w+\s*,\s*marker\s*\)/g)];
  assert.deepEqual(bare.map((m) => m[0]), [],
    'a marker written without the durability stamp hides a degraded publish: '
    + `${bare.map((m) => m[0]).join(', ')}`);
  const stamped = [...protocols.matchAll(/writeMarker\([^)]*durabilityMarker\(/g)];
  assert.equal(stamped.length, calls.length,
    `each of the ${calls.length} publish paths must stamp its marker (found ${stamped.length})`);

  // And a read-only file must NOT abort the publish -- that regression made one
  // 0444 file fail every crystallize/refine/rollback.
  assert.equal(/refusing to publish a durability marker/.test(protocols), false,
    'aborting on a refused flush is the v0.6.2 regression: the bytes were written '
    + 'and closed before the flush was attempted, so a read-only file is not '
    + 'evidence of data loss');
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
 * Runtime proof that fsyncFile opens a WRITE-capable handle: on a read-only file
 * 'r+' cannot be opened at all, so the helper must report a refusal, while a helper
 * that had slipped back to 'r' would open it happily and return true. This is the
 * ONLY evidence for that requirement that does not read source text, and F1 showed
 * source-text evidence can be sidestepped by respelling.
 *
 * v0.6.2 skipped it on win32 with the comment "Windows ignores chmod on the write
 * bit". That is FALSE -- measured on Windows 11 / node 22.22.3, chmod 0o444 maps to
 * FILE_ATTRIBUTE_READONLY and openSync('r+') fails with EPERM. The one platform this
 * whole patch series is about was the one platform the proof was disabled on.
 *
 * So probe instead of guessing: make a file read-only, try to open it for writing,
 * and only skip when the filesystem genuinely ignored us (root, FAT/exFAT, some
 * network mounts).
 */
function readOnlyIsEnforced(dir) {
  const probe = join(dir, '.ro-probe');
  writeFileSync(probe, 'x');
  chmodSync(probe, 0o444);
  try {
    closeSync(openSync(probe, 'r+'));
    return false;                              // opened for writing anyway
  } catch {
    return true;
  } finally {
    try { chmodSync(probe, 0o644); } catch { /* best effort */ }
    try { rmSync(probe, { force: true }); } catch { /* best effort */ }
  }
}

test('fsyncFile needs a write-capable handle (runtime)', async (t) => {
  const { fsyncFile } = await import('../../lib/fsync.js');
  const root = mkdtempSync(join(tmpdir(), 'dsh-evolve-ro-'));
  try {
    if (!readOnlyIsEnforced(root)) {
      // A skip does not count as a failure, so this is the one place where the only
      // non-source-text evidence in the file can vanish quietly -- v0.6.3 could be
      // reduced to a permanent skip by making this probe return false. Refuse to skip
      // unless the environment genuinely explains it.
      const excused = (process.getuid && process.getuid() === 0)
        || process.env.DSH_EVOLVE_ALLOW_RO_SKIP === '1';
      assert.ok(excused,
        'the read-only bit is not enforced here, but this is not root either. That '
        + 'combination usually means the probe itself broke rather than the filesystem '
        + 'being unusual -- and skipping would silently remove the only runtime proof '
        + "that fsyncFile opens 'r+'. Set DSH_EVOLVE_ALLOW_RO_SKIP=1 if this really is "
        + 'a FAT/exFAT or network mount.');
      t.skip('this filesystem does not enforce the read-only bit (root, or FAT/exFAT)');
      return;
    }
    const f = join(root, 'locked.txt');
    writeFileSync(f, 'x');
    chmodSync(f, 0o444);                       // read-only: 'r+' must fail, 'r' would not
    const r = fsyncFile(f);
    assert.equal(r.ok, false,
      "fsyncFile reported success on a read-only file, which means it is not opening 'r+'");
    // And it must say WHY. A bare false forced publish-protocols to treat a
    // read-only file and an unsupported platform as the same event.
    assert.equal(r.outcome, 'not-writable',
      `a read-only FILE must report not-writable, got "${r.outcome}" (code ${r.code})`);
  } finally {
    try { chmodSync(join(root, 'locked.txt'), 0o644); } catch { /* already gone */ }
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


/**
 * F7/F8: the degradation record must have a consumer, and must not carry a field
 * that always says "fine".
 *
 * v0.6.3 wrote `durability` onto the marker and nothing read it -- a note waiting to
 * be deleted by whoever next tidies up unused fields, and the only durable trace that
 * a tree was published without a full flush. It also returned an `ok` from fsyncTree
 * that was true unconditionally, which invites `if (!ok) abort` that can never fire.
 */
test('a degraded publish is both recorded and read back', () => {
  const runtime = read('op-runtime.js');
  const protocols = read('publish-protocols.js');

  // Written by the publish side...
  assert.match(protocols, /durability:/,
    'publish-protocols must stamp the degradation onto the marker');

  // ...and read by the recovery side, at every point that INTERPRETS a marker.
  // Protocol B is excluded by construction: it commits via a state block inside the
  // file itself and writes no marker, so it has no durability note to carry.
  const markerReads = [...runtime.matchAll(/readMarker\(([^)]*)\)/g)];
  assert.ok(markerReads.length >= 3,
    `expected several marker reads in reconcile (found ${markerReads.length})`);
  for (const m of markerReads) {
    const after = runtime.slice(m.index, m.index + 500);
    const verdict = after.indexOf("verdict: 'roll-forward'");
    if (verdict < 0) continue;                 // not a commit-confirming read
    assert.match(after.slice(verdict, verdict + 220), /degraded\(/,
      'a roll-forward that trusts a marker must also carry its durability note, or a '
      + 'degraded publish leaves no trace outside the log');
  }
  assert.match(runtime, /function degraded\(/, 'op-runtime must define the reader');

  // And fsyncTree must not resurrect an always-true ok.
  const tree = runtime.slice(runtime.indexOf('export function fsyncTree'));
  const body = tree.slice(0, tree.indexOf('\n}'));
  assert.equal(/ok:\s*true/.test(body), false,
    'fsyncTree must not return a hard-coded ok: a field named ok that is always true '
    + 'invites `if (!ok) abort` that never fires');
});

/**
 * F10: budgetStatus takes records whose injectionCount is already the EFFECTIVE
 * count. Only the store can compute that, so the contract lives in a comment -- and
 * a comment cannot stop a second caller from passing raw records and quietly
 * reintroducing the second definition this release removed.
 */
test('budgetStatus has exactly one caller, the store that substitutes effective counts', () => {
  const files = readdirSync(libDir, { recursive: true })
    .map((f) => String(f).split('\\').join('/'))
    .filter((f) => f.endsWith('.js') && f !== 'memory-convergence.js');
  const callers = files.filter((f) => /\bbudgetStatus\(/.test(read(f)));
  assert.deepEqual(callers, ['store.js'],
    'budgetStatus expects effective injection counts, which only the store can '
    + `compute; another caller would pass raw records: ${callers.join(', ')}`);
  const store = read('store.js');
  const call = /budgetStatus\(([^,]+),/.exec(store);
  assert.ok(call, 'store.js must call budgetStatus');
  assert.equal(/confirmed\(\)/.test(call[1]), false,
    'store.js passes this.confirmed() straight through, so the tie-break reads the '
    + 'persisted injectionCount instead of the effective one -- the two definitions '
    + 'are back');
  assert.match(store, /effectiveInjectionCount\(/,
    'store.js must substitute effective injection counts before calling');
});
