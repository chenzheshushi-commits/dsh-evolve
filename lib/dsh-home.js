/**
 * The harness home directory, resolved the way the harness resolves it.
 *
 * Precedence, matching `@deepseek-ai/dsh-home-paths`: `$DSH_HOME` when set and
 * non-blank (a leading `~/` is expanded; a relative value is taken against the
 * process cwd), otherwise `~/.dsh`.
 *
 * Why this is its own module: two places need it (the plugin workspace in
 * index.js and the refusal log in web-routes.js), and web-routes.js is imported
 * BY index.js, so neither can import the other without a cycle. A second private
 * copy is exactly how the refusal log came to read `process.env.DSH_HOME` alone —
 * correct only when the variable happened to be set, and silently writing nothing
 * on the default install, where it is not.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * @param {NodeJS.ProcessEnv} [env] injectable for tests; defaults to process.env.
 * @returns {string} an absolute path.
 */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(homedir(), '.dsh');
}
