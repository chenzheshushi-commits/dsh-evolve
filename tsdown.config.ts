import { defineConfig } from 'tsdown'

/**
 * Client-only build for dsh-evolve's web settings section.
 *
 * The HOST half of dsh-evolve is hand-written ESM in lib/ (index.js, store.js,
 * skills.js, spec.js, search.js, fts.js, llm-refine.js, web-routes.js) — it
 * needs no build. Only the browser half is compiled here:
 *
 *   src/client/index.ts -> lib/client.js  CJS bundle, which scripts/wrap-client.mjs
 *   then rewraps into the DSH module-loader shell
 *   (window.__ModuleLoader__.load({ id, factory: (require) => {...} })).
 *
 * Why CJS: the DSH loader hands the factory a `require` and expects the plugin
 * to return `module.exports`. Rolldown's CJS output already emits exactly that
 * shape, so wrap-client.mjs only swaps the outer wrapper for the loader shell.
 */

/** Everything the DSH web runtime provides to plugins at load time. */
const CLIENT_EXTERNAL = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig([
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false, // never delete the hand-written lib/*.js host half
    sourcemap: false,
    treeshake: true,
    external: CLIENT_EXTERNAL,
    // Force .js (not .cjs) so the built file matches package.json exports.
    outExtensions: () => ({ js: '.js' }),
  },
])
