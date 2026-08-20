/**
 * Memory domain declaration + governance defaults + skill-crystallization
 * config. Persisted through the harness storage hub (ctx.storageDomain →
 * ctx.storage), so the stock `json` backend keeps everything in plain JSON
 * under $DSH_HOME/storages — human-inspectable, git-friendly, zero deps.
 *
 * Memory schema/kinds/scopes are the Culeot/dsh-memory structure (MIT). The
 * skill-crystallization defaults (SKILL_DEFAULTS) are new to dsh-evolve.
 *
 * Uses schemastery (bundled by DSH) rather than zod, so this plugin has no
 * third-party runtime dependency beyond what the harness already ships.
 *
 * @module dsh-evolve/spec
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import z from '@deepseek-ai/schemastery';

/** Memory kinds: what a record is FOR. Drives recall filters and governance. */
export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'lesson', 'todo', 'note'];
/** Memory scopes: where a record applies. */
export const MEMORY_SCOPES = ['user', 'project'];

export function isValidKind(value) {
  return MEMORY_KINDS.includes(value);
}
export function isValidScope(value) {
  return MEMORY_SCOPES.includes(value);
}

/**
 * One durable memory record. schemastery mirror of Culeot's MemoryRecord.
 * `crystallized` (new): timestamp when this record last contributed to a
 * crystallized skill — prevents re-crystallizing the same evidence.
 */
export const MemoryRecordSchema = z.object({
  id: z.string,
  content: z.string,
  kind: z.union(MEMORY_KINDS).default('note'),
  tags: z.array(z.string).default([]),
  scope: z.union(MEMORY_SCOPES).default('project'),
  project: z.string.default(''),
  importance: z.number.default(2),
  createdAt: z.string,
  updatedAt: z.string,
  accessedAt: z.string.default(''),
  accessCount: z.number.default(0),
  expiresAt: z.string.default(''),
  crystallizedAt: z.string.default(''),
});

/** The storage domain. `version` stamps the medium; bump on schema changes. */
export const memoryDomain = defineDomain({
  name: 'evolve_memory',
  version: 1,
  tables: {
    records: domainTable(MemoryRecordSchema),
  },
});

/** Memory governance limits. */
export const MEMORY_DEFAULTS = {
  maxRecords: 400,
  maxContentChars: 2000,
  mergeSimilarity: 0.7,
  recencyHalfLifeDays: 90,
  recallLimit: 5,
  injectCount: 3,
  injectMaxChars: 1200,
};

/**
 * Skill-crystallization governance (new to dsh-evolve).
 *
 * Crystallization is DETERMINISTIC (no LLM): when enough high-value evidence
 * accumulates under a shared tag, we ask the *current* model (via a queued
 * nudge, reusing the live turn — zero extra API calls) to author a SKILL.md.
 * The written file lands in ~/.dsh/skills/<name>/SKILL.md and is picked up by
 * DSH's own dsh-skill-filesystem watcher (call/manage/hot-reload for free).
 */
export const SKILL_DEFAULTS = {
  // Minimum count of importance>=2 lesson/decision records sharing a tag
  // before we nudge the model to crystallize a skill for that tag.
  crystallizeMinEvidence: 3,
  // Minimum combined importance across the evidence set (3 lessons of imp2 = 6).
  crystallizeMinImportance: 6,
  // Only these kinds are crystallization evidence (procedural knowledge).
  crystallizeKinds: ['lesson', 'decision'],
  // Skills dir DSH's skill-filesystem watches (user-dsh root).
  // Empty => resolved at runtime to <DSH_HOME>/skills.
  skillsDir: '',
  // Curator: mark a crystallized skill idle after this many days unused.
  curatorIdleDays: 30,
};

export function clampImportance(value) {
  const n = Math.round(Number(value ?? 2));
  return Math.min(3, Math.max(1, Number.isFinite(n) ? n : 2));
}
