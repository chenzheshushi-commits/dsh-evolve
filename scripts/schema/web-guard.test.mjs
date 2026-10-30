/**
 * Loopback trust fence, including the desktop-shell origin (issue #3).
 *
 * The settings page inside the DeepSeek Harness desktop app (Electron) is served
 * from the custom scheme `dsh-app://app`, so every write it makes carries that
 * as Origin. The old fence compared Origin's host to the loopback Host header,
 * which can never match for an app-scheme page → 403 on every save.
 *
 * The fix is deliberately NARROW (dsh-app://app only, not "any non-http(s)
 * origin"): a file:// page sends `Origin: null`, and a blanket rule would hand
 * the control plane to any local HTML file. These tests pin both directions —
 * the app scheme accepted, everything else still refused — plus the refusal
 * diagnostic that makes the next such report answerable.
 *
 * Run: node --test scripts/schema/web-guard.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import { isTrustedLocalRequest } from '../../lib/web-routes.js';
import { resolveDshHome } from '../../lib/dsh-home.js';

const req = (headers, remoteAddress = '127.0.0.1') => ({
  socket: { remoteAddress },
  headers: { host: '127.0.0.1:57400', ...headers },
});

const HOST = '127.0.0.1:57400';

test('loopback http origin still trusted (web profile unchanged)', () => {
  assert.equal(isTrustedLocalRequest(req({ origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isTrustedLocalRequest(req({ origin: `http://${HOST}` })), true);
  assert.equal(isTrustedLocalRequest(req({ 'sec-fetch-site': 'same-origin' })), true, 'no Origin + same-origin');
  assert.equal(isTrustedLocalRequest(req({ 'sec-fetch-site': 'none' })), true, 'no Origin + none (direct navigation)');
});

test('the desktop shell origin is trusted (settings page can save)', () => {
  assert.equal(isTrustedLocalRequest(req({ origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isTrustedLocalRequest(req({ origin: 'dsh-app://app', 'sec-fetch-site': 'same-site' })), true);
  assert.equal(isTrustedLocalRequest(req({ origin: 'dsh-app://app' })), true, 'Origin present, no fetch metadata');
});

test('the app-scheme allowance stays narrow', () => {
  // Another app-scheme host is NOT the shell.
  assert.equal(isTrustedLocalRequest(req({ origin: 'dsh-app://evil', 'sec-fetch-site': 'same-origin' })), false);
  // Opaque/sandboxed origin (file://, sandboxed iframe) — refused, and this is
  // exactly why the rule is not "any non-http origin".
  assert.equal(isTrustedLocalRequest(req({ origin: 'null', 'sec-fetch-site': 'same-origin' })), false);
  // Another local service's page: same-site but a different authority.
  assert.equal(isTrustedLocalRequest(req({ origin: 'http://127.0.0.1:9999', 'sec-fetch-site': 'same-site' })), false);
  // Cross-site wins over everything, app scheme included.
  assert.equal(isTrustedLocalRequest(req({ origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isTrustedLocalRequest(req({ origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site' })), false);
});

test('the fence itself is unchanged: loopback socket + loopback Host required', () => {
  assert.equal(isTrustedLocalRequest(req({ origin: 'dsh-app://app' }, '8.8.8.8')), false, 'non-loopback peer');
  assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.com', origin: 'dsh-app://app' } }), false, 'non-loopback Host');
  assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'dsh-app://app' } }), false, 'missing Host');
});

test('a refusal is recorded with the three headers that decide it (and no token)', () => {
  const home = mkdtempSync(join(tmpdir(), 'guard-log-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const path = join(home, 'evolve-guard-debug.log');
    assert.equal(existsSync(path), false, 'no log file until something is actually refused');

    // Refused because the origin is opaque: the case a desktop-shell report
    // would first need to distinguish from a hostile one.
    isTrustedLocalRequest(req({ origin: 'null', 'sec-fetch-site': 'same-origin' }));
    // Refused because the authority differs.
    isTrustedLocalRequest(req({ origin: 'http://127.0.0.1:9999' }));

    const text = readFileSync(path, 'utf8');
    assert.match(text, /origin=null/, 'opaque origin recorded verbatim');
    assert.match(text, /origin=http:\/\/127\.0\.0\.1:9999/, 'mismatched origin recorded');
    assert.match(text, new RegExp(`host=${HOST.replace(/[.:]/g, '\\$&')}`), 'host recorded');
    assert.match(text, /site=(same-origin|\(none\))/, 'fetch metadata recorded');
    assert.equal(text.trim().split('\n').length, 2, 'one line per refusal, no spam');

    // A trusted request must not add noise.
    isTrustedLocalRequest(req({ origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin' }));
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2, 'accepted requests are not logged');

    // Never a credential: the harness token rides in the query string, not here.
    assert.doesNotMatch(text, /token=/i);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('the refusal log lands in the default home when DSH_HOME is NOT set', () => {
  // v0.8.1 read process.env.DSH_HOME only, so on a default install (the variable
  // is not exported) the log was written NOWHERE — the one case where someone
  // needs to read it. The harness resolves its home as $DSH_HOME, else ~/.dsh;
  // the log must land in the same place.
  const home = mkdtempSync(join(tmpdir(), 'guard-default-'));
  const prev = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  const prevHome = process.env.HOME;
  process.env.HOME = home;                     // so the default ~/.dsh resolves here
  try {
    isTrustedLocalRequest(req({ origin: 'null', 'sec-fetch-site': 'same-origin' }));
    const path = join(home, '.dsh', 'evolve-guard-debug.log');
    assert.ok(existsSync(path), `the log must exist at ${path} without DSH_HOME set`);
    assert.match(readFileSync(path, 'utf8'), /origin=null/, 'and it holds the refusal');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('the harness home resolves the way the harness resolves it', () => {
  // One resolver, shared by the plugin workspace and the refusal log, so the
  // two can never disagree about where the harness home is.
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/x' }), '/tmp/x');
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), resolveDshHome({}), 'blank falls back');
  assert.equal(resolveDshHome({}), join(homedir(), '.dsh'), 'default is ~/.dsh');
  assert.equal(resolveDshHome({ DSH_HOME: '~/h' }), join(homedir(), 'h'), 'tilde expands');
  assert.ok(isAbsolute(resolveDshHome({ DSH_HOME: 'rel/path' })), 'a relative value becomes absolute');
});
