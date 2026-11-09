/**
 * One live dsh-evolve per workspace, per process.
 *
 * Why this exists: a profile can end up mounting the same plugin package twice
 * (a bundle entry from `dsh plugin add` plus a stale loader row in the profile's
 * or the home-level `cordis.patch.yml`). Both copies run `apply()` in the same
 * root scope, and the second copy dies on the first globally-unique registration
 * (`prompt section "evolve-protocol" is already registered`). Because `apply()`
 * must never throw into boot, that failure is swallowed and the user sees a plugin
 * that is "enabled" while memory and skills are silently dead.
 *
 * The duplicate is a profile configuration mistake, but a plugin should degrade
 * to "one working copy + a plain-English note" instead of "enabled but broken".
 * The first mount owns the workspace; every later mount in this process returns
 * before touching any host service and records why in `duplicate-mount.log`.
 *
 * Scope: the guard is process-local and keyed by the resolved workspace directory,
 * so separate processes (the instance lock already rejects those) and separate
 * DSH_HOME trees are unaffected. A fiber re-entering `apply()` with the same uid
 * counts as the same instance (that is a retry, not a duplicate).
 *
 * @module dsh-evolve/instance-guard
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** @type {Map<string, { token: symbol, fiberUid: number | undefined }>} */
const ACTIVE = new Map();

/**
 * Claim this process's one live instance for a workspace.
 *
 * Synchronous on purpose: the claim must exist before `apply()` reaches its first
 * `await`, otherwise two copies starting in the same tick would both pass a check
 * performed after an await.
 *
 * @param {object} options
 * @param {string} options.workspaceDir - the plugin workspace (dshHome/evolve-workspace).
 * @param {number | undefined} [options.fiberUid] - ctx.fiber?.uid of the calling mount.
 * @returns {{ owner: boolean, reason: 'owner' | 'duplicate' | 'reapply', release: () => void }}
 *   `owner:false` means the caller must not register anything. `duplicate` is a second
 *   mount (two loader rows); `reapply` is the same fiber re-entering apply() while its
 *   previous registrations are still live (the host reloaded without disposing).
 */
export function claimInstance({ workspaceDir, fiberUid }) {
  const key = resolve(workspaceDir);
  const existing = ACTIVE.get(key);
  if (existing !== undefined) {
    if (fiberUid !== undefined && existing.fiberUid === fiberUid) {
      // Same fiber, and its old effects were never disposed (otherwise the release
      // effect below would have freed this key). Re-registering now would collide on
      // the first globally-named entry; the old instance is still fully wired, so the
      // safe move is to keep it and skip this pass.
      return { owner: false, reason: 'reapply', release: () => {} };
    }
    return { owner: false, reason: 'duplicate', release: () => {} };
  }
  const token = Symbol('dsh-evolve-instance');
  ACTIVE.set(key, { token, fiberUid });
  return {
    owner: true,
    reason: 'owner',
    release: () => {
      const current = ACTIVE.get(key);
      if (current?.token === token) ACTIVE.delete(key);
    },
  };
}

/**
 * Make a duplicate mount visible instead of silent.
 *
 * The host logger is filtered in the desktop app (that is why `last-apply-error.log`
 * exists in the first place), so the durable record goes to the plugin workspace.
 * File writes are best-effort: a failure here must not throw into boot.
 *
 * @param {string} workspaceDir - the plugin workspace directory.
 * @param {{ logger?: { warn?: (message: string) => void }, fiber?: { uid?: number } }} [ctx]
 * @param {'duplicate' | 'reapply'} [reason] - which collision was detected.
 * @returns {string} the message that was recorded.
 */
export function reportDuplicateMount(workspaceDir, ctx, reason = 'duplicate') {
  const fiberUid = ctx?.fiber?.uid ?? 'unknown';
  const message = reason === 'reapply'
    ? `dsh-evolve: apply() re-entered without disposing the previous mount (fiber ${fiberUid}). `
      + 'Keeping the existing instance; this pass registered nothing. If the settings or skills look '
      + 'stale, restart the app to reload cleanly.'
    : `dsh-evolve: duplicate mount ignored (fiber ${fiberUid}). Another instance is already `
      + 'active for this workspace, so this copy registered nothing. If this was not intentional, remove '
      + 'the extra dsh-evolve loader row: check dsh.profile.bundles and both cordis.patch.yml files '
      + '(the profile one and $DSH_HOME/cordis.patch.yml, which applies to every profile).';
  try {
    mkdirSync(workspaceDir, { recursive: true });
    appendFileSync(join(workspaceDir, 'duplicate-mount.log'),
      `${new Date().toISOString()} ${message}\n`);
  } catch { /* diagnostics must never break boot */ }
  try { ctx?.logger?.warn?.(message); } catch { /* host logger is optional */ }
  return message;
}

/** Test-only: clear process-local ownership between cases. */
export function __resetInstanceGuardForTests() {
  ACTIVE.clear();
}
