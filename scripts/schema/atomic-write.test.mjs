/**
 * Atomic replacement: the mechanism, and the ban that keeps it in one place.
 *
 * Two things are tested here, and the second is the one that decays.
 *
 * 1. writeFileAtomic actually resists what the old shape allowed -- a symlink planted
 *    at the temp path, and a concurrent writer truncating the bytes.
 * 2. No module reimplements it. lib/fsync.js has said in plain text since v0.6.0 that
 *    `openSync(file, 'w')` truncates and must never be used, and nothing enforced
 *    that: writeMarker was doing exactly it, on a live file, in the one protocol that
 *    writes into an existing skill directory. Seven modules also carried their own
 *    `${file}.tmp` copy, two of them under the same function name with DIFFERENT
 *    semantics. A comment is not a gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync, writeSync, closeSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic, isTempName, TMP_SUFFIX } from '../../lib/atomic-write.js';
import { splitCallArgs, lineOf, enclosingStatement } from './source-scope.mjs';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib');

function withTmpDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evolve-atomic-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a replaced file holds exactly the new bytes', () => {
  withTmpDir((root) => {
    const file = join(root, 'state.json');
    writeFileSync(file, 'old');
    writeFileAtomic(file, 'new', 0o644);
    assert.equal(readFileSync(file, 'utf8'), 'new');
  });
});

test('no temp file survives a successful write', () => {
  withTmpDir((root) => {
    const file = join(root, 'state.json');
    writeFileAtomic(file, 'body', 0o644);
    const leftovers = readdirSync(root).filter(isTempName);
    assert.deepEqual(leftovers, [], 'the temp file must be renamed, not left behind');
  });
});

test('a symlink planted at the fixed temp path cannot redirect the write', () => {
  // The measured attack against the old shape: with a fixed `${file}.tmp`, planting
  // SKILL.md.tmp -> ../../PWNED.txt made the save write OUTSIDE the skill tree, with
  // no error. Verified before the fix: the outside file was created and contained the
  // skill body.
  withTmpDir((root) => {
    const inner = join(root, 'skills', 'victim');
    mkdirSync(inner, { recursive: true });
    const outside = join(root, 'PWNED.txt');
    const file = join(inner, 'SKILL.md');
    writeFileSync(file, 'original');
    symlinkSync('../../PWNED.txt', `${file}${TMP_SUFFIX}`);

    writeFileAtomic(file, '# new content\n', 0o644);

    assert.equal(existsSync(outside), false,
      'the write escaped the directory through a pre-placed symlink');
    assert.equal(readFileSync(file, 'utf8'), '# new content\n');
  });
});

test('an exclusive create refuses a pre-existing temp path', () => {
  // Why the above holds: 'wx' fails instead of following or truncating. Pinned
  // directly, because it is the single property the safety rests on.
  withTmpDir((root) => {
    const path = join(root, 'taken');
    writeFileSync(path, 'x');
    assert.throws(() => openSync(path, 'wx'), (e) => e.code === 'EEXIST');
  });
});

test('two concurrent writers cannot truncate each other', () => {
  // The old shape lost data with no error: A wrote "AAAA-complete-AAAA" to the fixed
  // temp name, B opened the same name with 'w' and wrote "BB", and the file held
  // "BB". fsync could not help -- the bytes were gone before any flush.
  withTmpDir((root) => {
    const file = join(root, 'contended.json');
    writeFileAtomic(file, 'AAAA-complete-AAAA', 0o644);
    writeFileAtomic(file, 'BB', 0o644);
    // Sequential here, but the point is the absence of a shared fixed path: each call
    // uses its own random temp name, so neither can open the other's.
    assert.equal(readFileSync(file, 'utf8'), 'BB');
    assert.deepEqual(readdirSync(root).filter(isTempName), []);
  });
});

test('the requested mode is applied, and must be given', () => {
  withTmpDir((root) => {
    const file = join(root, 'secret.json');
    writeFileAtomic(file, '{}', 0o600);
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600,
        'the mode passed at the call site must be the mode on disk');
    }
    assert.throws(() => writeFileAtomic(join(root, 'x'), 'y'), TypeError,
      'an omitted mode must be refused, not defaulted invisibly');
  });
});

test('a failed write leaves no temp file behind', () => {
  withTmpDir((root) => {
    const missing = join(root, 'no-such-dir', 'file.json');
    assert.throws(() => writeFileAtomic(missing, 'body', 0o644));
    assert.equal(existsSync(join(root, 'no-such-dir')), false);
  });
});

/** Every lib/*.js except the atomic writer itself. */
function libSources() {
  return readdirSync(libDir)
    .filter((n) => n.endsWith('.js') && n !== 'atomic-write.js')
    .map((n) => [n, readFileSync(join(libDir, n), 'utf8')]);
}

/** True when the match at `idx` sits inside a line that is a comment. */
function inComment(text, idx) {
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  return /^\s*(?:\/\/|\*|\/\*)/.test(text.slice(lineStart, idx));
}

test("no module opens an existing file with 'w'", () => {
  // This is lib/fsync.js's own sentence, finally enforced:
  //   openSync(file, 'w') + fsyncSync -> OK, but TRUNCATES -- never use it here
  // Scoped to writes of a path (not a staging temp the caller just created), which is
  // why the allowance below names the file and the reason.
  const allowed = new Map([
    // Writes into a staging temp path it created itself, before any rename.
    ['publish-protocols.js', 1],
  ]);
  const offenders = [];
  for (const [name, text] of libSources()) {
    let seen = 0;
    for (const m of text.matchAll(/openSync\(/g)) {
      if (inComment(text, m.index)) continue;
      const { args } = splitCallArgs(text, m.index + m[0].length);
      if (args.length < 2) continue;
      const mode = /^(['"`])(.*)\1$/.exec(args[1].trim());
      if (!mode || mode[2] !== 'w') continue;
      seen += 1;
      if (seen <= (allowed.get(name) ?? 0)) continue;
      offenders.push(`${name}:${lineOf(text, m.index)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "these open an existing file with 'w', which truncates it before a crash can be "
    + 'survived; use writeFileAtomic from lib/atomic-write.js');
});

test('no module reimplements atomic replacement with a fixed temp name', () => {
  // A name-based gate would not have caught this: the three copies were called
  // writeFileAtomic, writeFileDurable and writeJsonAtomic. Match the SHAPE instead --
  // a temp path built by appending .tmp to a destination.
  const offenders = [];
  for (const [name, text] of libSources()) {
    for (const m of text.matchAll(/(?:const|let)\s+(\w*[Tt]mp\w*)\s*=\s*`\$\{[^`]*\}\.tmp`/g)) {
      if (inComment(text, m.index)) continue;
      // A staging DIRECTORY built this way is a different thing: mkdirSync fails when
      // the path exists, so a pre-placed symlink cannot be followed and a second
      // creator cannot truncate anything. skill-proposals.js stages a proposal that
      // way, and its `.tmp` suffix is also what its own list() filters on.
      // Bounded by the statement that declares the temp path, not by a character
      // count -- the window gate in readme-claims.test.mjs rightly flagged the first
      // version of this line, which used `slice(m.index, m.index + 400)`.
      const declaration = enclosingStatement(text, m.index);
      const next = enclosingStatement(text, m.index + declaration.length);
      if (new RegExp(`mkdirSync\\(${m[1]}\\b`).test(declaration + next)) continue;
      offenders.push(`${name}:${lineOf(text, m.index)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a fixed `<dest>.tmp` name is guessable, so it can be pre-placed as a symlink or '
    + 'truncated by a second writer; use writeFileAtomic instead');
});

test('the durability comment in fsync.js still states the ban', () => {
  // The two gates above are anchored on a sentence in another file. If that sentence
  // is reworded away, the gates keep passing while the rule silently loses its
  // stated reason -- so pin the sentence too.
  const fsync = readFileSync(join(libDir, 'fsync.js'), 'utf8');
  assert.match(fsync, /TRUNCATES -- never use it here/,
    'lib/fsync.js must keep stating why write-mode opens are banned');
});
