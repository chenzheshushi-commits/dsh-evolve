/**
 * The settings UI and the HTTP routes must agree.
 *
 * There is no react-dom or jsdom in this project, so the panels cannot be
 * rendered here -- and installing a test-only DOM would change the user's
 * dependency tree for the sake of a test. What CAN be verified without guessing
 * is the contract between the two halves, which is where these bugs actually
 * live: a UI that fetches a path the server does not serve, or mints a capability
 * purpose the server does not accept, compiles perfectly and fails in front of
 * the user.
 *
 * Read from the BUILT client (lib/client.js), not the source, so what is checked
 * is what ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { enclosingStatement, splitCallArgs } from './source-scope.mjs';

const client = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../../lib/web-routes.js', import.meta.url), 'utf8');
const caps = readFileSync(new URL('../../lib/capabilities.js', import.meta.url), 'utf8');

/** Every `${API}/x` path the built client fetches. */
function clientPaths() {
  const found = new Set();
  // The bundler turns `${API}/operations` into a concatenation or a literal
  // depending on the surrounding code, so match both shapes.
  for (const m of client.matchAll(/\/api\/evolve\/([a-z0-9/\-{}$.]+)/gi)) found.add(m[1]);
  for (const m of client.matchAll(/API\s*\+\s*"\/([a-z0-9/\-]+)"/gi)) found.add(m[1]);
  for (const m of client.matchAll(/\$\{API\}\/([a-z0-9/\-]+)/gi)) found.add(m[1]);
  return found;
}

test('the built client contains the v0.6.0 panels', () => {
  // If the build silently dropped the new UI, every assertion below would pass
  // vacuously -- so prove the panels are actually in the bundle first.
  assert.match(client, /卡住的操作/, 'the frozen-operations panel must ship');
  assert.match(client, /已归档的 skill/, 'the archive panel must ship');
  assert.match(client, /提议回滚/, 'the rollback-proposal button must ship');
});

test('every endpoint the client calls is served', () => {
  const paths = clientPaths();
  const needed = ['operations', 'skills/archives', 'skills/restore', 'skills/rollback-proposal', 'capability/mint'];
  for (const p of needed) {
    assert.ok([...paths].some((x) => x.startsWith(p)),
      `the client must call ${p} (found: ${[...paths].sort().join(', ')})`);
  }
  // And each one has a matching route. Prefix routes end with '/', so an exact
  // path is served either exactly or by its prefix.
  const served = [...routes.matchAll(/EVOLVE_API_PREFIX\}\/([a-z0-9/\-]*)`/gi)].map((m) => m[1]);
  for (const p of ['operations', 'skills/archives']) {
    assert.ok(served.includes(p), `route ${p} must exist (served: ${served.sort().join(', ')})`);
  }
  for (const p of ['skills/restore', 'skills/rollback-proposal', 'operations/']) {
    const prefix = p.split('/')[0] + '/';
    assert.ok(served.includes(prefix) || served.includes(p),
      `route ${p} must be served, at least by the ${prefix} prefix`);
  }
});

test('every capability purpose the client mints is a real purpose', () => {
  const minted = new Set(
    [...client.matchAll(/purpose:\s*"([a-z\-]+)"/gi)].map((m) => m[1])
      .concat([...client.matchAll(/purpose:\s*'([a-z\-]+)'/gi)].map((m) => m[1])),
  );
  assert.ok(minted.size > 0, 'the client must mint capabilities for privileged actions');
  const known = new Set([...caps.matchAll(/^\s{2}'([a-z\-]+)':\s*\(t\)/gm)].map((m) => m[1]));
  assert.ok(known.size >= 8, `the purpose table must be readable (parsed ${known.size})`);
  for (const p of minted) {
    // proposal-apply / proposal-reject are built by string interpolation in the
    // client, so only literal purposes appear here; all of them must be known.
    assert.ok(known.has(p), `client mints "${p}" but capabilities.js has no such purpose`);
  }
  for (const p of ['operation-resolve', 'skill-restore', 'rollback-proposal-create']) {
    assert.ok(minted.has(p), `the client must mint ${p} for its new panel actions`);
  }
});

test('resolution sends back the conflict hash it displayed', () => {
  // The server rebuilds the capability digest from observedConflictHash, so the
  // MINTED TARGET must carry it. A client that sends it only in the POST body
  // would be refused on every attempt -- and that looks like a broken button
  // rather than a safety feature, so it must be caught here.
  const mintIdx = client.indexOf('operation-resolve');
  assert.ok(mintIdx > 0);
  // Bound the window to the mint call itself: the target object literal, not the
  // later POST body. The digest fields sit between the purpose and the closing of
  // the target, so cut at the first occurrence of the endpoint path after it.
  const postIdx = client.indexOf('/operations/', mintIdx);
  assert.ok(postIdx > mintIdx, 'the resolve POST must follow the mint');
  const mintWindow = client.slice(mintIdx, postIdx);
  assert.match(mintWindow, /observedConflictHash/,
    'the minted capability target must include observedConflictHash, since the '
    + 'server rebuilds the digest from it and would otherwise never match');
  assert.match(mintWindow, /resolvesOpId/, 'and it must bind the operation it resolves');
  // The POST body must carry it too, since the service re-checks the view. Read the
  // whole apiPost statement rather than 400 characters of it: the body is an object
  // literal whose length changes whenever a field is added.
  const bodyStatement = enclosingStatement(client, postIdx);
  assert.match(bodyStatement, /observedConflictHash/,
    'the request body must echo the hash the operator saw');
});

test('the rollback button proposes rather than rolls back', () => {
  const idx = client.indexOf('rollback-proposal-create');
  assert.ok(idx > 0, 'the client must mint the proposal-create purpose');

  // This assertion used to read `client.slice(idx, idx + 500)` and match
  // /rollback-proposal/ in it. `idx` is where the string
  // 'rollback-proposal-create' starts, and /rollback-proposal/ is a prefix of it --
  // so the window matched before it contained anything else. It was TRUE BY
  // CONSTRUCTION: changing the POST target to ${API}/skills/nope-not-here left this
  // test green while two others went red.
  //
  // What the test name claims is that the button POSTs to the proposal endpoint, so
  // assert on the POST itself: find the apiPost call and read its first argument.
  const postIdx = client.indexOf('apiPost(', idx);
  assert.ok(postIdx > idx,
    'the minted purpose must be followed by the apiPost it authorises');
  const { args } = splitCallArgs(client, postIdx + 'apiPost('.length);
  assert.match(args[0], /\/skills\/rollback-proposal[`'"]/,
    'the rollback button must POST to the rollback-proposal endpoint; the URL is the '
    + 'first argument of that apiPost call');

  // There is no direct rollback endpoint at all; make sure the client did not
  // invent one.
  assert.equal(/\/skills\/rollback["'`]/.test(client), false,
    'a direct /skills/rollback call would be a bypass of the review requirement');
});

test('every privileged client action sends an opId', () => {
  // Without an idempotency key the server cannot replay a finished operation, and
  // a retried click publishes twice.
  for (const marker of ['skills/restore', 'skills/rollback-proposal']) {
    const idx = client.indexOf(marker);
    assert.ok(idx > 0, `${marker} must be called`);
    // A 600-character window around the marker had 273 characters of headroom: five
    // lines of ordinary comment turned this red. The opId belongs to the same call,
    // so bound the search by that call instead.
    const callIdx = client.lastIndexOf('apiPost(', idx);
    assert.ok(callIdx > -1, `${marker} must be reached through apiPost`);
    const statement = enclosingStatement(client, callIdx);
    assert.match(statement, /opId/, `${marker} must send an opId`);
  }
});
