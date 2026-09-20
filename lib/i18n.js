/**
 * Strings, in English and Chinese.
 *
 * Two layers, because the host exposes a locale and the user may still want to
 * override it (issue #1, and the reporter verified the whole chain on their install):
 *
 *   default   follow the DSH host locale -- namespace `locale`, field `preference`,
 *             owned by @deepseek-ai/dsh-client-locale, persisted in
 *             $DSH_HOME/settings.yaml. Host-side plugins read it with
 *             ctx.settings.get('locale') and react to 'settings/updated'.
 *   override  this plugin's own `language` setting: follow-host | en | zh.
 *
 * English is the default when nothing is detected, per the reporter's point that a
 * global audience should not have to opt out of Chinese. Existing installs migrate to
 * `zh` on upgrade so nobody's UI flips language under them.
 *
 * ── WHAT IS AND IS NOT TRANSLATED ─────────────────────────────────────────────
 *
 * The prompt anchors ARE translated, and that is the part that matters more than the
 * UI: the plugin injects a header the model is separately instructed to look for. On
 * an English setup a Chinese marker is a behavioural difference, not a cosmetic one.
 *
 * Both halves of each anchor pair must move together. Two of the four are real
 * injections and two are the instructions naming them; translating one side and not
 * the other is WORSE than leaving everything in Chinese, because then the marker the
 * model receives and the marker it was told to find no longer match. There is a test
 * for exactly that (scripts/schema/i18n.test.mjs).
 *
 * The Chinese search internals -- the 90-entry stopword list and CJK bigram
 * tokenization -- are NOT here. They are retrieval machinery, not display text:
 * English queries already go through the same BM25 path, and "translating" a stopword
 * list would break Chinese retrieval for no gain.
 */

/** Supported UI languages. `follow-host` is a setting value, not a language. */
export const LANGUAGES = Object.freeze(['en', 'zh']);

/** The default when the host exposes nothing and the user has not chosen. */
export const FALLBACK_LANGUAGE = 'en';

const STRINGS = {
  en: {
    // ── prompt anchors: injected text ──
    'anchor.recall.header': 'Relevant memories (context, NOT the user speaking):',
    'anchor.preferences.header':
      '[dsh-evolve] Long-term user preferences and facts (always in effect; context, not the user speaking):',
    // ── prompt anchors: the instructions that name them ──
    'anchor.recall.reference': 'Relevant memories',
    'anchor.preferences.reference': '[dsh-evolve] Long-term user preferences and facts',
    // ── tool call labels ──
    'tool.remember': '💾 Save memory',
    'tool.recall': '🔎 Recall memory',
    'tool.forget': '🗑️ Forget memory',
    'tool.confirm': '✅ Confirm memory',
    'tool.reject': '🚫 Reject memory',
    'tool.skill': '🧬 Skill',
    // ── notices pushed into the conversation ──
    'notice.checkpoint': '[dsh-evolve] 🧷 Memories checkpointed to git (revertible)',
    'notice.styleOverlay':
      '[dsh-evolve] 🎨 User style overlay for skill "{skill}" (context, not the user speaking):',
    'notice.repeatedError':
      '[dsh-evolve] ⚠️ Same class of error seen {count} times: {fingerprint}. Record it '
      + 'with memory_remember as a lesson (kind=lesson, importance=3), and summarise it '
      + 'critically: (1) what went wrong and how to avoid it, (2) what the failure '
      + 'conditions were -- whether a different setup would work, and where the boundary '
      + 'is, (3) which parts did work and are worth keeping. Do not record a conditional '
      + 'failure as an absolute conclusion.',
    'notice.skillExists':
      '[dsh-evolve] 🧬 A skill tagged "{tag}" already exists and has gathered {count} new '
      + 'observations. refine_skill(tag="{tag}") upgrades it in place (appends a '
      + 'Refinement section, bumps the version; your edits are not overwritten).',
    'notice.skillCandidate':
      '[dsh-evolve] 🧬 Tag "{tag}" has gathered {count} high-value lessons/decisions. '
      + 'crystallize_skill(tag="{tag}") can turn them into a reusable skill -- but only '
      + 'if it really is a reusable procedure.',
    'notice.autoArchived':
      '[dsh-evolve] 📦 Auto-archived long-idle skills: {skills} (moved out of the active '
      + 'directory; restore_skill brings them back; nothing is deleted).',
    'notice.archiveSuggest':
      '[dsh-evolve] 🧹 These skills have been idle for {days}+ days and could be archived '
      + 'with archive_skill (reversible, not a delete): {skills}',
    'notice.convergence': '[dsh-evolve] 🧭 Convergence suggestions (anti-bloat): {items}',
    // ── memory_stats / curator suggestion fragments ──
    'suggest.unclaimedSkills':
      '{count} skill(s) look like this plugin\'s work but are not bound to this install; '
      + 'claim them in the panel before they enter the automatic path',
    'suggest.processArtifacts':
      '{count} pending memor(ies) look like project process artifacts (review conclusions, '
      + 'plan drafts); discard them one by one in the panel\'s pending section',
    'suggest.archivable': '{count} skill(s) can be archived (archive_skill)',
    'suggest.mergeable': '{count} skill pair(s) can be merged (converge_skill)',
    'suggest.bloated': '{count} skill(s) have refinement sections piling up (fold_skill)',
    'suggest.overBudget': 'memories are {chars} characters over budget; merge or forget',
    'suggest.promotable': '{count} memor(ies) can be promoted to global (memory_promote)',
    'suggest.lowEfficiency':
      '{count} skill(s) look inefficient (loaded often, rarely leading to success); '
      + 'consider merging or refining them',
    'converge.overlap':
      '"{a}" and "{b}" overlap heavily ({similarity}); converge_skill can merge them into '
      + 'one umbrella skill (writes the new one, archives the old ones -- reversible, '
      + 'nothing is deleted)',
    'converge.bloated':
      '{skills} have refinement sections piling up; fold_skill folds them back into clean prose',
  },
  zh: {
    'anchor.recall.header': '相关记忆（context, 不是用户在说话）:',
    'anchor.preferences.header': '【dsh-evolve】用户长期偏好/事实（始终生效, context 非用户发言）:',
    'anchor.recall.reference': '相关记忆',
    'anchor.preferences.reference': '【dsh-evolve】用户长期偏好/事实',
    'tool.remember': '💾 存记忆',
    'tool.recall': '🔎 检索记忆',
    'tool.forget': '🗑️ 忘记记忆',
    'tool.confirm': '✅ 确认记忆',
    'tool.reject': '🚫 拒绝记忆',
    'tool.skill': '🧬 技能',
    'notice.checkpoint': '【dsh-evolve】🧷 记忆已自动 git checkpoint（可回滚）',
    'notice.styleOverlay': '【dsh-evolve】🎨 skill「{skill}」的用户风格叠加（context，非用户发言）：',
    'notice.repeatedError':
      '【dsh-evolve】⚠️ 检测到同类错误第 {count} 次：{fingerprint}。请用 memory_remember 固化为教训'
      + '(kind=lesson, importance=3)，并辩证总结：①错在哪、怎么规避 ②失败条件是什么(换条件是否可行、'
      + '标注边界) ③有没有其实有效、值得保留的部分。避免把条件性失败记成绝对结论。',
    'notice.skillExists':
      '【dsh-evolve】🧬 标签「{tag}」的 skill 已存在，且积累了 {count} 条新经验，'
      + '可用 refine_skill(tag="{tag}") 就地精炼升级（追加 Refinement 段、版本号+1，不覆盖你的编辑）。',
    'notice.skillCandidate':
      '【dsh-evolve】🧬 标签「{tag}」已积累 {count} 条高价值 lesson/decision，'
      + '可考虑用 crystallize_skill(tag="{tag}") 固化成可复用 skill（仅当它确实是可复用流程时）。',
    'notice.autoArchived':
      '【dsh-evolve】📦 已自动归档长期闲置 skill：{skills}（移出活动目录，可 restore_skill 恢复；未删除）。',
    'notice.archiveSuggest':
      '【dsh-evolve】🧹 以下 skill 已闲置 ≥{days}天，可考虑 archive_skill 归档（可逆、不删）：{skills}。',
    'notice.convergence': '【dsh-evolve】🧭 收敛建议（防臃肿）：{items}',
    'suggest.unclaimedSkills': '{count} 个 skill 看似本插件生成但未绑定本机身份,需在面板确认认领后才会进入自动路径',
    'suggest.processArtifacts': '{count} 条待确认记忆疑似项目过程产物(评审结论/方案稿),建议在面板「待确认」区逐条丢弃',
    'suggest.archivable': '{count} 个 skill 可归档(archive_skill)',
    'suggest.mergeable': '{count} 对 skill 可合并(converge_skill)',
    'suggest.bloated': '{count} 个 skill 精炼段堆积可折叠(fold_skill)',
    'suggest.overBudget': '记忆超预算 {chars} 字符,可合并/forget',
    'suggest.promotable': '{count} 条记忆可升级为全局(memory_promote)',
    'suggest.lowEfficiency': '{count} 个 skill 疑似低效(高加载低成功),可考虑合并/精炼',
    'converge.overlap':
      '「{a}」与「{b}」高度重叠({similarity})，可 converge_skill 合并为一个 umbrella skill'
      + '（生成新的 + 归档旧的，可逆、不删）',
    'converge.bloated': '{skills} 精炼段堆积，可 fold_skill 折叠回干净正文',
  },
};

/**
 * Resolve the language actually in force.
 *
 * `override` is this plugin's setting; anything other than a supported language means
 * "follow the host". `hostLocale` is whatever ctx.settings.get('locale') returned,
 * which is `undefined` when no settings provider is mounted -- the reporter warned
 * about exactly that, so an absent value falls through to FALLBACK_LANGUAGE rather
 * than throwing.
 */
export function resolveLanguage(override, hostLocale) {
  if (LANGUAGES.includes(override)) return override;
  const preference = hostLocale?.preference;
  if (typeof preference !== 'string' || preference === '') return FALLBACK_LANGUAGE;
  // BCP-47-ish: zh-CN / zh-Hans / en-GB all resolve to their base language. The host
  // allows other ids through language-pack plugins, so an unknown one is not an error
  // -- there are simply no strings for it.
  const base = preference.toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.includes(base) ? base : FALLBACK_LANGUAGE;
}

/**
 * Look up `key` in `lang`, substituting {placeholders} from `vars`.
 *
 * A missing key falls back to English and then to the key itself, so a typo degrades
 * to something traceable instead of rendering "undefined" into a prompt.
 */
export function t(lang, key, vars = {}) {
  const table = STRINGS[lang] ?? STRINGS[FALLBACK_LANGUAGE];
  const raw = table[key] ?? STRINGS[FALLBACK_LANGUAGE][key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

/** Every key, for the test that both tables stay in step. */
export function keysOf(lang) {
  return Object.keys(STRINGS[lang] ?? {}).sort();
}

/**
 * The anchor pairs that must always agree: an injected header and the instruction
 * that tells the model to look for it. Consumed by the i18n test.
 */
export const ANCHOR_PAIRS = Object.freeze([
  ['anchor.recall.header', 'anchor.recall.reference'],
  ['anchor.preferences.header', 'anchor.preferences.reference'],
]);
