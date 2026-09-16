/**
 * One child process that tries to claim a resource and reports the outcome.
 *
 * Used by op-transaction.test.mjs. Promise.all in a single process shares one
 * event loop and one fs cache, so it cannot prove that O_EXCL is what provides
 * mutual exclusion. Two real processes can.
 */

import { ClaimRegistry } from '../../lib/op-transaction.js';

const [, , workspaceDir, resource, opId] = process.argv;

try {
  const reg = new ClaimRegistry({ workspaceDir });
  const r = reg.claim(resource, opId);
  process.stdout.write(JSON.stringify({ opId, status: r.status }));
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ opId, status: 'error', message: String(e.message) }));
  process.exit(1);
}
