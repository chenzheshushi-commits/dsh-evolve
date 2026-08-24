/**
 * Heat: a READ-ONLY time-coldness signal (v0.4.2).
 *
 * ⚠️⚠️ READ-ONLY SIGNAL — MUST NOT drive any mutation, archive, or deletion.
 * Heat only orders prune candidates and feeds UI display. Disposal always goes
 * through the controlled prune gate (authorizePruneAction + human confirm).
 *
 * ⚠️ HEAT IS TIME-COLDNESS, NOT USAGE VALUE. accessedAt only advances on
 * explicit recall; auto-injection bumps injectionCount ONLY (by design, v0.2.1,
 * to avoid the inject→rank→inject Matthew effect). A frequently auto-injected
 * memory can therefore look "cold". injectionCount / observationCount MUST stay
 * as independent sort keys ORDERED BEFORE heat — never let heat alone represent
 * value.
 *
 * Formula (power-law decay): H = 1 / (1 + λ·Δt)^α, Δt in days, H in (0,1].
 * Fresh → ~1; old → →0. Bigger λ (per-kind) or α = cools faster.
 *
 * @module dsh-evolve/heat
 */

const MS_PER_DAY = 86400000;

function daysBetween(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / MS_PER_DAY);
}

function powerLaw(deltaDays, lambda, alpha) {
  if (!(lambda > 0)) return 1; // λ<=0 => never cools (immune); guard against NaN
  return 1 / Math.pow(1 + lambda * deltaDays, alpha);
}

/**
 * Memory heat. Time basis = accessedAt || createdAt — NEVER updatedAt
 * (merging / refining bumps updatedAt but that is not "access", and treating
 * such a bump as "coldness decay" produces wrong results). λ from
 * cfg.heatKindDecay by kind, α from cfg.heatGlobalAlpha.
 */
export function memoryHeat(record, cfg = {}, now = Date.now()) {
  const alpha = cfg.heatGlobalAlpha ?? 1.2;
  const decayMap = cfg.heatKindDecay ?? {};
  const lambda = decayMap[record.kind] ?? 0.001;
  const basis = record.accessedAt || record.createdAt || '';
  const dt = daysBetween(basis, now);
  return powerLaw(dt, lambda, alpha);
}

/**
 * Skill heat. Skills have no MEMORY_KINDS — use a single decay rate
 * (cfg.heatSkillDecay). Time basis = lastActivityAt || createdAt || mtime.
 * @param skillUsage { lastActivityAt?, createdAt?, mtime? } (ms epoch or ISO)
 */
export function skillHeat(skillUsage, cfg = {}, now = Date.now()) {
  const alpha = cfg.heatGlobalAlpha ?? 1.2;
  const lambda = cfg.heatSkillDecay ?? 0.002;
  const u = skillUsage || {};
  let basisIso = u.lastActivityAt || u.createdAt || '';
  if (!basisIso && u.mtime) {
    basisIso = (typeof u.mtime === 'number') ? new Date(u.mtime).toISOString() : String(u.mtime);
  }
  const dt = daysBetween(basisIso, now);
  return powerLaw(dt, lambda, alpha);
}

/**
 * Annotate items with a read-only `_heat` (shallow copy; never mutates input).
 * @param items array of records or skill-usage objects
 * @param heatFn memoryHeat or skillHeat
 */
export function annotateHeat(items, heatFn, cfg = {}, now = Date.now()) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({ ...it, _heat: heatFn(it, cfg, now) }));
}
