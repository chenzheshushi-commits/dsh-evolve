/**
 * Tests for the scope helpers that replace every `slice(i, i + N)` window in this
 * directory.
 *
 * These matter more than the usual source-reading test: ten gates are about to
 * depend on `enclosingStatement`, so a bug here weakens all of them at once. The
 * cases below are the shapes actually present in this repo's sources -- nested
 * calls, commas inside strings, regex literals containing braces, template
 * interpolation -- plus the two failure modes the character windows had.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enclosingStatement, enclosingBlock, functionBody, splitCallArgs, lineOf,
} from './source-scope.mjs';

test('a statement ends at its own semicolon', () => {
  const src = 'const a = one();\nconst b = two();\n';
  assert.equal(enclosingStatement(src, 0), 'const a = one();');
});

test('semicolons nested in a call do not end the statement', () => {
  const src = 'call(() => { a; b; }, second);\nafter();';
  assert.equal(enclosingStatement(src, 0), 'call(() => { a; b; }, second);');
});

test('a semicolon inside a string does not end the statement', () => {
  const src = "const msg = 'a; b';\nnext();";
  assert.equal(enclosingStatement(src, 0), "const msg = 'a; b';");
});

test('a semicolon inside a template, including an interpolation, is ignored', () => {
  const src = 'const u = `${base};${path}`;\nnext();';
  assert.equal(enclosingStatement(src, 0), 'const u = `${base};${path}`;');
});

test('a brace inside a regex literal does not open a scope', () => {
  const src = 'const re = /a{2};/;\nnext();';
  assert.equal(enclosingStatement(src, 0), 'const re = /a{2};/;');
});

test('division is not mistaken for a regex', () => {
  const src = 'const r = total / count; const s = 2;';
  assert.equal(enclosingStatement(src, 0), 'const r = total / count;');
});

test('a comment containing a semicolon is skipped', () => {
  // The semicolon must appear ONLY inside the comment, or the statement would end
  // before the skipping code ever runs and the case would pass either way. (It did:
  // the first version of this test stayed green with comment handling deleted.)
  const lineComment = 'const a = one() // note; more\n  .two();\nnext();';
  assert.equal(enclosingStatement(lineComment, 0), 'const a = one() // note; more\n  .two();');

  const blockComment = 'const a = one() /* ; */ .two();\nnext();';
  assert.equal(enclosingStatement(blockComment, 0), 'const a = one() /* ; */ .two();');
});

test('a statement with no semicolon stops at the enclosing close', () => {
  // The shape inside an object literal or argument list: there is no semicolon, and
  // running to end-of-file would swallow unrelated code.
  const src = 'wrap(inner)';
  assert.equal(enclosingStatement(src, 5), 'inner');
});

test('enclosingBlock returns the containing scope, not a byte count', () => {
  const src = 'function f() {\n  claim();\n  if (x) { y(); }\n  allow();\n}\nafter();';
  const body = enclosingBlock(src, src.indexOf('claim'));
  assert.match(body, /claim\(\)/);
  assert.match(body, /allow\(\)/);
  assert.ok(!body.includes('after()'), 'the block must end at its own brace');
});

test('enclosingBlock is unaffected by unrelated growth above it', () => {
  // This is the property the character windows lacked: instance-lock.test.mjs went
  // red when 126 characters of comment pushed an identifier out of a 1200-character
  // window, even though the code was unchanged.
  const body = 'function f() {\n  claim();\n  allow();\n}';
  const grown = `${'// '.padEnd(400, 'x')}\n${body}`;
  const a = enclosingBlock(body, body.indexOf('claim'));
  const b = enclosingBlock(grown, grown.indexOf('claim'));
  assert.equal(a, b, 'the same scope must be returned regardless of surrounding text');
});

test('functionBody stops at the function it names, not at end of file', () => {
  // The trap this exists for: enclosingBlock() anchored on 'function foo' treats the
  // function's OWN brace as depth 1 and runs to the end of the file. Measured on
  // lib/publish-protocols.js it returned 17500 characters instead of 580, pulling in
  // unrelated functions -- so a ban on an identifier matched an occurrence elsewhere.
  const src = 'function target() {\n  wanted();\n}\nfunction other() {\n  forbidden();\n}\n';
  const body = functionBody(src, src.indexOf('function target'));
  assert.match(body, /wanted\(\)/);
  assert.ok(!body.includes('forbidden()'),
    'functionBody must not read past its own closing brace');
});

test('functionBody handles nested braces in the body', () => {
  const src = 'function f() {\n  if (a) { b(); }\n  const o = { k: 1 };\n  done();\n}\nafter();';
  const body = functionBody(src, 0);
  assert.match(body, /done\(\)/);
  assert.ok(!body.includes('after()'));
});

test('splitCallArgs splits on top-level commas only', () => {
  const src = "openSync(join(a, b), 'r+')";
  const { args } = splitCallArgs(src, src.indexOf('(') + 1);
  assert.deepEqual(args, ['join(a, b)', "'r+'"]);
});

test('splitCallArgs keeps commas inside strings and templates', () => {
  const src = "warn('a, b', `${x},${y}`, third)";
  const { args } = splitCallArgs(src, src.indexOf('(') + 1);
  assert.deepEqual(args, ["'a, b'", '`${x},${y}`', 'third']);
});

test('splitCallArgs reports where the call ends', () => {
  const src = 'f(a, b); after();';
  const { end } = splitCallArgs(src, 2);
  assert.equal(src.slice(end), '; after();');
});

test('splitCallArgs on a no-argument call yields one empty entry', () => {
  const src = 'f()';
  const { args } = splitCallArgs(src, 2);
  assert.deepEqual(args, ['']);
});

test('lineOf is 1-based', () => {
  const src = 'a\nb\nc';
  assert.equal(lineOf(src, 0), 1);
  assert.equal(lineOf(src, src.indexOf('c')), 3);
});
