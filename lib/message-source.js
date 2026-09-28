/**
 * Session-format producer attribution for every message this plugin injects.
 *
 * DSH 0.1.7 moved the session log to format v4, which RETIRES the v3
 * `{ kind: 'plugin', plugin: 'dsh-evolve' }` wrapper: native v4 admission refuses
 * any message whose source kind is the literal `'plugin'` (see
 * `@deepseek-ai/dsh-session-format-v3-to-v4`), and its v3→v4 migrator rewrites such
 * rows to `plugin:<plugin>` — the producer-owned kind used here. Writing the v3
 * shape from a v0.8.0+ install would make the harness refuse the log the moment it
 * is read back, which is the same class of failure as the missing-`summary` bug in
 * v0.5.2.
 *
 * `form: 'notice'` still requires a one-line `summary` (ContextFormed), so every
 * call site must pass one. Keeping this in ONE module is deliberate: three call
 * sites re-spelling the kind is how a schema change turns into a partial fix.
 * @module dsh-evolve/message-source
 */

/** Producer-owned source kind, matching what the v3→v4 migrator derives for us. */
export const SOURCE_KIND = 'plugin:dsh-evolve';

/**
 * Source record for a collapsed one-line notice injected into the model context.
 * @param summary - one-line account of what happened (bounded by the harness).
 * @returns a v4-shaped producer-owned message source.
 */
export function noticeSource(summary) {
  return { kind: SOURCE_KIND, form: 'notice', summary };
}
