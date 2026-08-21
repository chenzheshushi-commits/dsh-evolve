/**
 * Post-build step: rewrap lib/client.js from a bare CJS bundle into the DSH
 * browser module-loader shell.
 *
 * tsdown/rolldown emits the right CJS *body* (externals as `require(...)`,
 * public surface on `exports`). DSH's loader (@deepseek-ai/dsh-client-modules)
 * calls the factory with its own `require` and keeps whatever it returns, so
 * this script just:
 *   1. declares the module/exports pair the CJS body expects,
 *   2. indents the body inside factory: (require) => { ... },
 *   3. returns module.exports,
 *   4. wraps it all in window.__ModuleLoader__.load({ id, factory }).
 * Idempotent: re-running on an already-wrapped file is a no-op.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'lib', 'client.js')
/** Module id DSH registers this plugin's browser half under. */
const MODULE_ID = 'dsh-evolve'

const original = readFileSync(target, 'utf8')

if (original.startsWith('window.__ModuleLoader__.load(')) {
  console.log(`[wrap-client] ${target} already wrapped, skipping`)
  process.exit(0)
}

if (/^\s*(?:import|export)\s/m.test(original)) {
  console.error(
    '[wrap-client] refusing to wrap: lib/client.js contains top-level ESM '
    + 'import/export. The client entry must be built with format "cjs".',
  )
  process.exit(1)
}

let body = original
  .replace(/\n*\/\/#\s*sourceMappingURL=.*\s*$/, '')
  .replace(/^\s*(['"])use strict\1;?\n/, '')
  .replace(/\s+$/, '')

if (!/\bexports\./.test(body) && !/\bmodule\.exports\b/.test(body)) {
  console.error('[wrap-client] refusing to wrap: no CJS exports found in lib/client.js')
  process.exit(1)
}

const indented = body
  .split('\n')
  .map(line => (line.length === 0 ? '' : '\t\t' + line))
  .join('\n')

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(MODULE_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indented}
\t\treturn module.exports;
\t}
});
`

writeFileSync(target, wrapped, 'utf8')
console.log(`[wrap-client] wrapped lib/client.js as ${MODULE_ID} (${wrapped.length} bytes)`)
