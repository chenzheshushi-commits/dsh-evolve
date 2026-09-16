/**
 * Filter out project process artifacts before they become memories.
 *
 * The real incident: three records like "dsh-evolve v0.6.0 rev3 复评：统一事务模型
 * 使方案较rev2显著提升，但仍有开工阻断" landed in the review queue as lesson/imp3.
 * Those belong in the project's plan document, not in cross-session memory.
 *
 * How the root cause was misdiagnosed the first time is worth remembering: the
 * obvious explanation was "the background reviewer scraped the conversation", and
 * a whole layer of defence was designed around blocking that path. Reading the
 * actual records disproved it -- sourceContext was empty (the review path always
 * writes a snapshot) and each carried 5-6 semantic tags (the review parser emits
 * no tags at all). The model had written them itself via memory_remember.
 * "Which mechanism would produce this data" is a hypothesis; "what do this
 * record's fields actually look like" is evidence.
 *
 * ── Why the matching is deliberately narrow ─────────────────────────────────
 *
 * A first design flagged any of 评审/review/audit/实现方案/更新报告/评分, which would
 * have killed a large class of genuine lessons: "代码评审必须覆盖并发路径",
 * "audit log 写入后必须 fsync". Process words are a WEIGHTED SIGNAL ONLY and never
 * fire on their own. A record is a process artifact when:
 *
 *   (a) it names an in-house project, or pairs a semver with a rev number, AND
 *   (b) it contains at least one process-structure word
 *
 * plus one standalone pattern strong enough on its own: "v0.6.0 rev3", the shape
 * that only ever appears in review correspondence.
 *
 * The filter looks at content shape and provenance, never at `kind` -- the model
 * fills kind in itself, so deciding anything from it was already rejected once.
 */

/** Projects whose names only show up when discussing our own work. */
const PROJECT_NAMES = [
  'dsh-evolve', 'dsh_evolve', 'deepseek-harness', 'smallwh', 'trsupport',
  'kol-crm', 'product-hub', 'carrier-ship', 'arcreel', 'netscope',
];

/**
 * Words that describe the process of reviewing work rather than a lesson from it.
 * Never sufficient alone -- see the module comment.
 */
const PROCESS_WORDS = [
  '评审', '复评', '重新评估', '独立审查', '质证', '开工阻断', '评分',
  '实现方案', '方向备忘', '更新报告', '评估报告', '验收清单',
  'rubric',
];

/** "v0.6.0 rev3" and friends: a version paired with a revision. */
const VERSION_REV = /v\d+\.\d+\.\d+\s*(?:rev|revision)\s*\d+/i;

const SEMVER = /\bv\d+\.\d+\.\d+\b/;
const REV_TOKEN = /\brev[1-9]\d*\b/i;

/** Provenance values that are allowed to write whatever they like. */
const TRUSTED_PROVENANCE = new Set(['explicit-user-request', 'system-generated']);

/**
 * Classify a candidate memory.
 *
 * @param {object} input
 * @param {string} input.content
 * @param {string} [input.provenance] one of background-review | model-tool |
 *   explicit-user-request | system-generated. Passed by the CALL SITE, never
 *   exposed as a tool parameter -- otherwise the model could simply claim the
 *   user asked for it (the same lesson as anchoredToUser).
 * @returns {{isProcessArtifact: boolean, patternNames: string[], reason: string}}
 */
export function classifyProcessArtifact({ content, provenance } = {}) {
  const text = String(content ?? '');
  const names = [];

  if (TRUSTED_PROVENANCE.has(provenance)) {
    return {
      isProcessArtifact: false,
      patternNames: [],
      reason: `provenance=${provenance} is trusted: if a human explicitly asked for this, `
        + 'it gets stored even when it looks like a process artifact',
    };
  }

  // (c) standalone: the version+rev shape essentially never occurs in a real lesson.
  if (VERSION_REV.test(text)) {
    names.push('version-rev');
    return {
      isProcessArtifact: true,
      patternNames: names,
      reason: 'contains a "vX.Y.Z revN" reference, which only appears in review correspondence',
    };
  }

  // (a) does it identify one of our own projects, or a version+rev pair?
  const lower = text.toLowerCase();
  const project = PROJECT_NAMES.find((p) => lower.includes(p));
  if (project) names.push(`project:${project}`);
  const versionPair = SEMVER.test(text) && REV_TOKEN.test(text);
  if (versionPair) names.push('semver+rev');

  // (b) does it talk about the review PROCESS?
  const processHits = PROCESS_WORDS.filter((w) => (
    /[a-z]/i.test(w) ? lower.includes(w.toLowerCase()) : text.includes(w)
  ));
  if (processHits.length) names.push(...processHits.map((w) => `process:${w}`));

  const identified = Boolean(project) || versionPair;
  if (identified && processHits.length > 0) {
    return {
      isProcessArtifact: true,
      patternNames: names,
      reason: 'names one of our own projects/versions AND describes the review process, '
        + 'so it is documentation about a specific revision rather than a durable lesson',
    };
  }

  return {
    isProcessArtifact: false,
    patternNames: names,
    reason: identified
      ? 'mentions one of our projects but says nothing about the review process -- '
        + 'a genuine project lesson is still a lesson'
      : processHits.length
        ? 'uses review vocabulary but names no specific project or revision, so it reads '
          + 'as a general lesson ("code review must cover concurrent paths")'
        : 'no process-artifact signal',
  };
}

/**
 * The one-line test for whether something belongs in memory at all.
 *
 * Handed to the reviewer prompt verbatim so the model applies the same rule the
 * filter does, instead of the filter silently cleaning up after it.
 */
export const MEMORY_VS_DOCUMENT_RULE =
  '一条教训应该在半年后换个项目仍然成立；如果它只对某个版本的某次评审有意义，'
  + '那属于项目文档，不属于跨会话记忆。';

/**
 * Scan existing records for suspects, for the one-off cleanup report.
 *
 * Report only. Disposal stays explicit: the user discards them through the
 * rejected channel, nothing is removed quietly.
 */
export function findProcessArtifactSuspects(records, { provenanceOf } = {}) {
  const out = [];
  for (const r of records ?? []) {
    const provenance = provenanceOf ? provenanceOf(r) : r?.provenance?.kind;
    const verdict = classifyProcessArtifact({ content: r?.content, provenance });
    if (!verdict.isProcessArtifact) continue;
    out.push({
      id: r.id,
      kind: r.kind,
      importance: r.importance,
      content: String(r.content ?? '').replace(/\n/g, ' ').slice(0, 100),
      patternNames: verdict.patternNames,
      reason: verdict.reason,
    });
  }
  return out;
}
