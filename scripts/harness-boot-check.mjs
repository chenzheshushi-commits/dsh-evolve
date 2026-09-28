#!/usr/bin/env node
/**
 * Boot the plugin inside a REAL harness and check it activates.
 *
 * Why this exists: `pnpm run test` imports `lib/index.js` through this repo's own
 * `node_modules`, so a host-side rename (`CallId` -> `ToolCallId` in harness 0.1.7)
 * is invisible to all 382 tests. In the harness the linked plugin's
 * `@deepseek-ai/dsh-*` imports are resolved against the RUNNING installation, so
 * the plugin can fail to import while every unit test is green. That is exactly
 * what happened: the harness logged `evolve (dsh-evolve): failed to import` on
 * every boot and the only way to see it was to boot.
 *
 * This is a pre-release gate, not a per-push one: it installs and starts a whole
 * harness. `verify.yml` runs it on `workflow_dispatch` only.
 *
 * Usage:
 *   node scripts/harness-boot-check.mjs --harness <path-to-harness-tree> [--port 3099]
 *   node scripts/harness-boot-check.mjs --version 0.1.7-rc.2      # installs it first
 *
 * The plugin is mounted with pnpm's `link:` on purpose: that is how it is deployed,
 * and it is the linked-package path the harness's ResolutionRouter special-cases.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE22 = process.execPath;
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const PORT = Number(arg('port') ?? 3099);
const BOOT_TIMEOUT_MS = Number(arg('timeout') ?? 120_000);
const work = mkdtempSync(join(tmpdir(), 'dsh-boot-check-'));
const logs = { out: '', err: '' };
let child;

function fail(message) {
  console.error(`[harness-boot-check] FAIL: ${message}`);
  console.error('--- harness stdout (tail) ---');
  console.error(logs.out.split('\n').slice(-15).join('\n'));
  console.error('--- harness stderr (tail) ---');
  console.error(logs.err.split('\n').slice(-25).join('\n'));
  cleanup(1);
}

function cleanup(code) {
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}

/** Find the harness bin.js, either from an explicit tree or by installing a version. */
function locateHarness() {
  const tree = arg('harness');
  if (tree) {
    const bin = join(resolve(tree), 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    if (!existsSync(bin)) fail(`no harness bin.js under ${tree} (${bin})`);
    return bin;
  }
  const version = arg('version') ?? '0.1.7-rc.2';
  const dest = join(work, 'harness');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'dsh-boot-harness', private: true }));
  console.log(`[harness-boot-check] installing @deepseek-ai/dsh@${version} ...`);
  execFileSync('corepack', ['pnpm', 'add', `@deepseek-ai/dsh@${version}`, '--reporter=append-only'],
    { cwd: dest, stdio: 'inherit', env: { ...process.env, PATH: `${dirname(NODE22)}:${process.env.PATH}` } });
  const bin = join(dest, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!existsSync(bin)) fail(`install produced no bin.js at ${bin}`);
  return bin;
}

/** A minimal web profile whose only plugin is this one, mounted by link:. */
function writeProfile(home) {
  const profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-harness-boot-check-profile',
    private: true,
    type: 'module',
    dependencies: { 'dsh-evolve': `link:${REPO}` },
    // The shipped web profile is base + web-app, plus the plugin under test. Bundles
    // resolve from the harness installation except ours, which is linked above --
    // exactly the deployment shape whose resolution path broke in 0.1.7.
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-evolve'] } },
  }, null, 2));
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: evolve\n  name: dsh-evolve\n');
  execFileSync('corepack', ['pnpm', 'install', '--no-frozen-lockfile', '--reporter=append-only'],
    { cwd: profile, stdio: 'inherit', env: { ...process.env, PATH: `${dirname(NODE22)}:${process.env.PATH}` } });
}

function freePort(port) {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.once('listening', () => s.close(() => ok(true)));
    s.listen(port, '127.0.0.1');
  });
}

/**
 * The harness authenticates every route, including the plugin's own API. The boot
 * prints a one-time token URL; exchanging it is what a browser does, so this check
 * does the same rather than assuming a bare loopback call is enough.
 * @returns the session cookie header value.
 */
async function establishSession() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`harness exited early with code ${child.exitCode}`);
    const m = logs.out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_\-]+)/);
    if (m) {
      const res = await fetch(`http://127.0.0.1:${PORT}/?token=${m[1]}`, { redirect: 'manual' });
      const cookie = res.headers.get('set-cookie');
      if (cookie) return cookie.split(';')[0];
      const landed = await fetch(`http://127.0.0.1:${PORT}/?token=${m[1]}`);
      const jar = landed.headers.get('set-cookie');
      if (jar) return jar.split(';')[0];
      fail('the one-time token did not produce a session cookie');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail('the harness never printed its token URL');
}

async function waitForState(cookie) {
  const url = `http://127.0.0.1:${PORT}/api/evolve/state`;
  // Same-origin markers the plugin's loopback fence requires; a browser sends these.
  const headers = {
    Host: `127.0.0.1:${PORT}`,
    Origin: `http://127.0.0.1:${PORT}`,
    'sec-fetch-site': 'same-origin',
    Cookie: cookie,
  };
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let last = 'no attempt yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`harness exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      if (res.status === 200) {
        const json = JSON.parse(text);
        return json;
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e?.message ?? e).slice(0, 80);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`/api/evolve/state never answered (${last})`);
}

const bin = locateHarness();
console.log(`[harness-boot-check] harness: ${bin}`);
const version = execFileSync(NODE22, [bin, '--version'], { encoding: 'utf8' }).trim();
console.log(`[harness-boot-check] harness version: ${version}`);

if (!await freePort(PORT)) fail(`port ${PORT} is already in use`);
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
writeProfile(home);
console.log('[harness-boot-check] profile ready; booting ...');

child = spawn(NODE22, [bin, 'web', '--no-open', '--port', String(PORT)], {
  env: {
    ...process.env,
    HOME: join(work, 'fakehome'),
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => { logs.out += d; });
child.stderr.on('data', (d) => { logs.err += d; });

const cookie = await establishSession();
const state = await waitForState(cookie);
const refused = logs.err.split('\n').filter((l) =>
  /failed to import|did not activate|MODULE_NOT_FOUND|SyntaxError|Cannot find module/.test(l));

console.log(`[harness-boot-check] /api/evolve/state -> ok=${state.ok} language=${state.language} `
  + `configKeys=${Object.keys(state.config ?? {}).length} memories=${state.memoryStats?.total ?? 0}`);
console.log(`[harness-boot-check] activation failures on stderr: ${refused.length}`);
for (const line of refused) console.log(`  ${line}`);

if (refused.length > 0) fail('the harness refused at least one entry');
if (state.ok !== true) fail('the plugin answered but reported ok=false');
if (!state.config || Object.keys(state.config).length < 10) {
  fail('the settings surface did not come up (empty config view)');
}
console.log(`[harness-boot-check] PASS — dsh-evolve activates inside harness ${version}`);
cleanup(0);
