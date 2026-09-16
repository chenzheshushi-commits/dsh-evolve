/**
 * Tidy tier: automatically SOFT-delete the exact candidates suggest shows.
 *
 * No physical deletion. No private candidate logic. Automatic mutation starts
 * only after a durable INTENT audit is fsync'd; if that write fails the whole run
 * becomes a read-only suggestion. RESULT audit is fail-open because mutation has
 * already happened and the durable intent is enough to reconcile.
 */
import { appendAudit, appendAuditStrict } from './prune-plan.js';
import { authorizePruneAction } from './prune-authz.js';

export async function runTidy({ store, workspaceDir, cfg = {}, logger = { warn() {} }, now = Date.now(), audit = {} }) {
  // Single source: exactly what suggest exposes.
  const candidates = store.disposalCandidates(now);
  const limit = Math.max(1, Math.min(100, Number(cfg.tidyMaxPerRun ?? 5)));
  const selected = candidates.slice(0, limit);
  if (selected.length === 0) {
    return { status: 'nothing-to-do', candidates: [], softDeleted: [], skipped: [] };
  }

  const strict = audit.appendStrict ?? appendAuditStrict;
  const loose = audit.append ?? appendAudit;
  try {
    strict(workspaceDir, {
      event: 'tidy', source: 'tidy-auto', phase: 'intent',
      candidateIds: selected.map((x) => x.id),
      eligibility: selected.map((x) => ({
        id: x.id, ageDays: x.ageDays, accessCount: x.accessCount,
        injectionCount: x.injectionCount, injectionGeneration: x.injectionGeneration,
      })),
    }, cfg);
  } catch (e) {
    logger.warn?.(`[dsh-evolve] tidy intent audit failed; no records changed: ${e?.message ?? e}`);
    return {
      status: 'suggest-only', reason: `intent audit failed: ${e?.message ?? e}`,
      candidates: selected, softDeleted: [], skipped: [],
    };
  }

  const softDeleted = [];
  const skipped = [];
  for (const expected of selected) {
    // Full record, never id-only: authz reads pinned/kind/importance.
    const record = store.all().find((r) => r.id === expected.id);
    if (!record) { skipped.push({ id: expected.id, reason: 'gone' }); continue; }
    const authz = authorizePruneAction('memory-forget', record, cfg);
    if (!authz.allowed) { skipped.push({ id: expected.id, reason: authz.reason }); continue; }
    if (authz.requires === 'explicit-confirm' || record.importance === 3) {
      skipped.push({ id: expected.id, reason: 'skipped-importance-3' });
      continue;
    }
    try {
      const receipt = await store.softForgetIfEligible(expected.id, expected, now);
      if (receipt?.softDeleted === 1) softDeleted.push(expected.id);
      else skipped.push({ id: expected.id, reason: receipt?.skipped ?? 'soft-delete-refused' });
    } catch (e) {
      skipped.push({ id: expected.id, reason: `error: ${e?.message ?? e}` });
    }
  }

  // Best effort result: intent is already durable and deletions cannot be undone
  // by throwing now. appendAudit also recursively redacts strings.
  try {
    loose(workspaceDir, {
      event: 'tidy', source: 'tidy-auto', phase: 'result',
      softDeleted, skipped,
    }, cfg, logger);
  } catch (e) {
    logger.warn?.(`[dsh-evolve] tidy result audit failed after apply: ${e?.message ?? e}`);
  }
  return { status: 'complete', candidates: selected, softDeleted, skipped };
}
