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

    // ── settings page: shared bits ──
    'ui.common.restore': 'Restore',
    'ui.common.cancel': 'Cancel',
    'ui.common.loading': 'Loading…',
    // ── settings page: header ──
    'ui.page.subtitle':
      'Self-evolving memory + skill lifecycle. Every setting is saved to the plugin '
      + 'config immediately; data refreshes every 8 seconds.',
    // ── settings page: LLM refinement ──
    'ui.llm.title': 'LLM refinement of skill content',
    'ui.llm.enable': 'Enable LLM refinement',
    'ui.llm.onLabel': 'On',
    'ui.llm.onDesc':
      ': when crystallizing / refining a skill, call the model selected below once to '
      + 'distil scattered memories into a structured SKILL.md (deduplicated, split into '
      + 'sections, written up as steps/pitfalls). A single call, triggered only on '
      + 'crystallize/refine (possibly 0 times in a session), reusing the provider cache.',
    'ui.llm.offLabel': 'Off',
    'ui.llm.offDesc1':
      ': falls back to deterministic concatenation (memory entries are listed into '
      + 'SKILL.md verbatim), ',
    'ui.llm.offZeroToken': 'zero tokens',
    'ui.llm.offDesc2':
      ', no model is called at all. Fully functional, the content is just not distilled.',
    'ui.llm.modelLabel': 'Model used for refinement:',
    'ui.llm.followMain': '(follow DSH\'s current main model — default)',
    'ui.llm.modelHint':
      'Leaving it unset = follow the main model (when the main model changes it follows '
      + 'automatically). Picking one pins refinement to that model.',
    // ── settings page: memory ingestion autonomy ──
    'ui.ingest.title': 'Memory ingestion autonomy',
    'ui.ingest.desc':
      'Decides how much of "what the model / background review wants to remember" takes '
      + 'effect automatically, and how much you look at first. Switching levels only '
      + 'affects new memories from then on; it does not bulk-release the pending items '
      + 'you already have.',
    'ui.ingest.manualLabel': 'Manual',
    'ui.ingest.manualDesc':
      'Everything goes to pending first and takes effect only after you confirm it one '
      + 'by one. The most conservative.',
    'ui.ingest.balancedLabel': 'Balanced (default)',
    'ui.ingest.balancedDesc':
      'The certain ones (anchored to your own words, or heavily duplicating something '
      + 'already confirmed) take effect automatically; the uncertain ones go to pending.',
    'ui.ingest.autonomousLabel': 'Autonomous',
    'ui.ingest.autonomousDesc':
      'Anything reversible and non-conflicting takes effect automatically; important '
      + '(imp3) / conflicting items are still forced into pending. The write volume has a '
      + 'separate cap protecting it.',
    'ui.ingest.autonomousWarn':
      '⚠️ At the autonomous level the background review writes more memories on its own. '
      + 'At most {perTurn} auto-confirmed per turn, and the pending queue is capped at '
      + '{queueMax} — anything beyond that is refused, to prevent unbounded growth. '
      + 'Conflicts and important memories still need your confirmation.',
    // ── settings page: skill write approval ──
    'ui.skillApproval.title': 'Skill write approval',
    'ui.skillApproval.desc':
      'Follows the ingestion level by default: the manual/balanced levels generate a '
      + 'proposal first, only the autonomous level may write directly. To get the old '
      + 'direct-write behaviour back, pick "Autonomous" explicitly.',
    'ui.skillApproval.inherit': 'Follow the ingestion level (currently: {mode})',
    'ui.skillApproval.manual': 'Manual: always a proposal',
    'ui.skillApproval.balanced': 'Balanced: always a proposal',
    'ui.skillApproval.autonomous': 'Autonomous: direct write once the safety gate passes',
    'ui.skillApproval.manualCharsPrefix': 'Manual body limit ',
    'ui.skillApproval.manualCharsSuffix': ' chars; ',
    'ui.skillApproval.autoCharsPrefix': 'automatic path limit ',
    'ui.skillApproval.autoCharsSuffix': ' chars.',
    'ui.skillApproval.promptToggle':
      ' Ask once in the conversation when a direct memory is high-value pending',
    'ui.skillApproval.promptDescPrefix':
      'Covers only memory_remember in an open conversation; the background review cannot '
      + 'pop a dialog after the turn has ended, so it still goes to the panel for review. '
      + 'At most ',
    'ui.skillApproval.promptDescSuffix': ' per turn.',
    // ── settings page: frozen operations ──
    'ui.frozenOps.title': '⚠️ Stuck operations ({count})',
    'ui.frozenOps.desc':
      'These operations were interrupted before they finished, and need you to decide what '
      + 'to do. The system will not guess on its own — it would rather stop and wait for a '
      + 'human. "Roll forward" = accept the part that already took effect and finish the '
      + 'bookkeeping; "Roll back" = only usable when you have confirmed it never took effect.',
    'ui.frozenOps.resolved': 'handled ({decision})',
    'ui.op.rollForwardBtn': 'Roll forward',
    'ui.op.rollBackBtn': 'Roll back',
    // ── settings page: skill proposals ──
    'ui.proposals.title': 'Skill proposal review ({count})',
    'ui.proposals.desc':
      'The model can only generate proposals, it cannot apply them itself. When the target '
      + 'has been changed by a human the proposal turns stale rather than overwriting the '
      + 'new content.',
    'ui.proposals.apply': 'Apply',
    'ui.proposals.reject': 'Reject',
    // ── settings page: pending queue ──
    'ui.pending.title': 'Pending memories (approval gate)',
    'ui.pending.desc':
      'Memories written by the model are pending by default and are not injected '
      + 'automatically; only after human confirmation are they "always in effect".',
    'ui.pending.source': 'Source: ',
    'ui.pending.discardTitle': 'Discard this one (recoverable, never physically deleted)',
    'ui.pending.discard': 'Discard',
    'ui.pending.confirmAll': 'Confirm all ({count})',
    'ui.pending.empty': '(no pending memories)',
    // ── settings page: rejected queue ──
    'ui.rejected.title': 'Rejected ({count})',
    'ui.rejected.desc':
      'Discarded memories are no longer injected, do not take up the pending quota, and '
      + 'batch-confirm will not pull them back in; but they are not physically deleted and '
      + 'can be restored at any time.',
    'ui.rejected.restoreTitle': 'Put it back in the pending queue',
    // ── settings page: unclaimed skills ──
    'ui.unclaimed.title': 'Skills awaiting claim ({count})',
    'ui.unclaimed.desc':
      'These skills look like they were generated by an early version of this plugin, but '
      + 'they are not bound to this machine\'s identity. To avoid mistaking files you wrote '
      + 'by hand for plugin assets, the plugin does not claim them automatically: only after '
      + 'claiming do they enter the automatic rewrite path, and while unclaimed the manual '
      + 'tools work as usual.',
    'ui.unclaimed.claimTitle': 'Confirm this is a plugin-generated skill',
    'ui.unclaimed.claim': 'Claim',
    'ui.unclaimed.claimAll': 'Claim all ({count})',
    // ── settings page: retrieval health ──
    'ui.retrieval.title': 'Memory retrieval status',
    'ui.retrieval.fused': '● Fused retrieval (bigram + full-text index) — best recall',
    'ui.retrieval.bigramOnly':
      '▲ bigram retrieval only — the full-text index is unavailable, recall for long '
      + 'Chinese sentences / paraphrased queries will get worse',
    'ui.retrieval.degraded':
      '▲ The full-text index degraded at runtime — recall quality has dropped '
      + '({count} errors)',
    'ui.retrieval.unknown': 'Status unknown (no retrieval has happened yet)',
    'ui.retrieval.ftsLabel': 'Full-text index: ',
    'ui.retrieval.enabled': 'enabled',
    'ui.retrieval.disabled': 'disabled',
    'ui.retrieval.available': 'available',
    'ui.retrieval.unavailable': 'unavailable',
    'ui.retrieval.counts': ' · fused {fused} times / degraded {degraded} times',
    // ── settings page: memory disposal autonomy ──
    'ui.disposal.title': 'Memory disposal autonomy',
    'ui.disposal.desc':
      'Decides how the system handles cold memories. The manual/suggest levels do not '
      + 'change data; the tidy level only auto-"soft-deletes" low-value memories that match '
      + 'strict rules, and they can be restored from the forgotten section below. No level '
      + 'ever physically deletes automatically, and skill merging/archiving also stays manual.',
    'ui.disposal.manualLabel': 'Manual',
    'ui.disposal.manualDesc':
      'The system does not propose anything on its own. You pick and handle things '
      + 'yourself in the controlled prune below.',
    'ui.disposal.suggestLabel': 'Suggest',
    'ui.disposal.suggestDesc':
      'When idle, automatically recomputes the low-value memories that were "never '
      + 'injected, never recalled, and past the cooldown period" and lists them for you; it '
      + 'still only suggests, it never deletes automatically.',
    'ui.disposal.tidyLabel': 'Tidy',
    'ui.disposal.tidyDesc':
      'When idle, automatically soft-deletes that same batch of suggested candidates; at '
      + 'most the configured number per run, recoverable, never a physical delete; '
      + 'top-importance, preference, decision, pending, rejected and pinned items are never '
      + 'handled automatically.',
    'ui.disposal.idleLabel': 'Idle trigger time: ',
    'ui.disposal.minutes': ' minutes',
    'ui.disposal.tidyMaxLabel': 'Max auto soft-deletes per run: ',
    'ui.disposal.items': ' items',
    'ui.disposal.cooldown':
      'Cooldown period: {days} days. Recomputed automatically when idle, ',
    'ui.disposal.lastComputed': 'last computed at {time}',
    'ui.disposal.notYetComputed': '(not triggered yet, needs a stretch of idle time)',
    'ui.disposal.candMeta': 'cold for {days} days · {reason}',
    'ui.disposal.noCandidates':
      '(no low-value candidates for now — the store is still small, or everything is in use)',
    'ui.disposal.pruneHint':
      'To actually clean up, go to "Controlled prune" below, tick the items and run it '
      + '(two-stage preview → confirm, all reversible).',
    // ── settings page: controlled prune ──
    'ui.prune.title': 'Controlled prune',
    'ui.prune.desc':
      'Detection is automatic, disposal is explicit. Cold / low-value memories and '
      + 'redundant skills are handled here by your tick, all reversible (soft delete / '
      + 'archive, restorable at any time).',
    'ui.prune.budget': 'Character budget: {used} used / {max} limit',
    'ui.prune.overBudget': '(over the limit)',
    'ui.prune.memHeading': 'Memories to clean up',
    'ui.prune.heat': 'not actively accessed for a long time · heat {heat}',
    'ui.prune.injected': ' · auto-injected {count} times',
    'ui.prune.noMemCandidates': '(no cleanup candidates)',
    'ui.prune.previewBtn': 'Preview the memories that will be handled',
    'ui.prune.previewTitle': 'Preview (soft delete, all recoverable):',
    'ui.prune.colAction': 'Action',
    'ui.prune.colCount': 'Count',
    'ui.prune.colResult': 'Result',
    'ui.prune.colNote': 'Note',
    'ui.prune.willRun': 'will run',
    'ui.prune.skip': 'skipped',
    'ui.prune.requires': ' (needs {cap})',
    'ui.prune.executeBtn': 'Confirm and run',
    'ui.prune.protectedTitle': 'Protected records (need a dedicated review)',
    'ui.prune.protectedDesc':
      'Preference / decision memories cannot be disposed of directly in this version (so '
      + 'long-term preferences are not deleted by mistake). For review only.',
    'ui.prune.convergeTitle': 'Skills to converge',
    'ui.prune.similarity': ' | similarity {similarity}',
    'ui.prune.zeroLoad': ' | zero loads {count}',
    'ui.prune.convergeHint':
      'For skill merging/archiving use converge_skill / archive_skill on the conversation '
      + 'side (the panel only does memory cleanup for now).',
    'ui.prune.forgottenTitle': 'Forgotten (recoverable)',
    // ── settings page: overview ──
    'ui.overview.title': 'Memory / skill overview',
    'ui.overview.memoryLine':
      'Memories: {total} in total ({confirmed} confirmed / {pending} pending), '
      + 'limit {max}',
    'ui.overview.byKind': 'By kind: ',
    'ui.overview.topInjected': 'Most often injected (what actually influences decisions):',
    'ui.overview.triage':
      'Outcome triples: {turns} turns recorded, {successes} succeeded / {failures} failed',
    'ui.overview.triageOff': 'Outcome triples: not enabled',
    // ── settings page: skill archives ──
    'ui.archives.title': 'Archived skills ({count})',
    'ui.archives.desc':
      'Archiving only moves a skill out of the active directory; the files are all still '
      + 'there and can be restored at any time. The same skill can have several archives, '
      + 'told apart by archive id — pick the one you want when restoring, they do not '
      + 'overwrite each other.',
    'ui.archives.proposeRollback': 'Propose rollback',
    // ── settings page: transient notes ──
    'ui.note.batchConfirmed': '✅ Batch-confirmed {count} pending memor(ies)',
    'ui.note.discarded': '🗑️ Discarded (restorable in the "Rejected" section below)',
    'ui.note.memoryNotFound': 'That memory was not found',
    'ui.note.restoredToPending': '↩️ Restored to pending',
    'ui.note.claimed':
      '✅ Claimed {count} skill(s); from now on they can enter the automatic path',
    'ui.note.nothingToClaim': 'There is no skill to claim',
    'ui.note.proposalDone': '✅ Proposal {status}',
    'ui.note.opRolledForward': '✅ Operation {opId} rolled forward',
    'ui.note.opRolledBack': '✅ Operation {opId} rolled back',
    'ui.note.skillRestored': '♻️ Restored skill "{name}"',
    'ui.note.rollbackProposalCreated':
      '⏮️ Rollback proposal {id} created; review it in the proposal list above, then apply it',
    'ui.note.noSelectableMemories': 'No handleable memory selected',
    'ui.note.planExpired': 'The plan has expired, please preview again',
    'ui.note.pruneDone': '✅ Done: {count} memor(ies) soft-deleted{skipped}',
    'ui.note.pruneSkippedSuffix': ', {count} skipped ({details})',
    'ui.note.restored': '✅ Restored',
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

    // ── 设置页：通用 ──
    'ui.common.restore': '恢复',
    'ui.common.cancel': '取消',
    'ui.common.loading': '加载中…',
    // ── 设置页：页头 ──
    'ui.page.subtitle': '自进化记忆 + skill 生命周期。所有设置即时保存到插件配置；数据每 8 秒刷新。',
    // ── 设置页：LLM 精炼 ──
    'ui.llm.title': 'LLM 精炼 skill 内容',
    'ui.llm.enable': '启用 LLM 精炼',
    'ui.llm.onLabel': '打开',
    'ui.llm.onDesc':
      '：结晶 / 精炼 skill 时，调用一次下方所选模型，把零散记忆提炼成结构化 SKILL.md'
      + '（去重、分节、写成步骤/坑）。单次调用、仅在结晶/精炼时触发（一次会话可能 0 次），复用 provider 缓存。',
    'ui.llm.offLabel': '关闭',
    'ui.llm.offDesc1': '：改用确定性拼接（原样把记忆条目列进 SKILL.md），',
    'ui.llm.offZeroToken': '零 token',
    'ui.llm.offDesc2': '、不调用任何模型。功能完全可用，只是内容不经提炼。',
    'ui.llm.modelLabel': '精炼使用的模型：',
    'ui.llm.followMain': '（跟随 DSH 当前主模型 — 默认）',
    'ui.llm.modelHint': '不选 = 跟随主模型（主模型换了它自动跟随）。选了则固定用该模型精炼。',
    // ── 设置页：记忆摄入自治程度 ──
    'ui.ingest.title': '记忆摄入自治程度',
    'ui.ingest.desc':
      '决定「模型/后台评审想记的东西」有多少能自动生效，多少要你先过目。'
      + '切档只影响之后的新记忆，不会批量放行已有的待确认项。',
    'ui.ingest.manualLabel': '手动',
    'ui.ingest.manualDesc': '全部先进待确认，你逐条确认后才生效。最保守。',
    'ui.ingest.balancedLabel': '平衡（默认）',
    'ui.ingest.balancedDesc': '拿得准的（锚定你原话、或与已确认高度重复）自动生效；拿不准的进待确认。',
    'ui.ingest.autonomousLabel': '自治',
    'ui.ingest.autonomousDesc':
      '凡是可逆、不冲突的都自动生效；重要(imp3)/冲突项仍强制进待确认。写入量另有上限保护。',
    'ui.ingest.autonomousWarn':
      '⚠️ 自治档下后台评审会自动写入更多记忆。每轮最多自动确认 {perTurn} 条，'
      + '待确认队列上限 {queueMax} 条——超出的会被拒收以防无界增长。冲突和重要记忆仍需你确认。',
    // ── 设置页：Skill 写入审批 ──
    'ui.skillApproval.title': 'Skill 写入审批',
    'ui.skillApproval.desc':
      '默认跟随摄入档：手动/平衡档先生成提案，只有自主档可直写。要恢复旧式直写可显式选“自主”。',
    'ui.skillApproval.inherit': '跟随摄入档（当前：{mode}）',
    'ui.skillApproval.manual': '手动：全部提案',
    'ui.skillApproval.balanced': '平衡：全部提案',
    'ui.skillApproval.autonomous': '自主：过安全闸后直写',
    'ui.skillApproval.manualCharsPrefix': '人工正文上限 ',
    'ui.skillApproval.manualCharsSuffix': ' 字；',
    'ui.skillApproval.autoCharsPrefix': '自动路径上限 ',
    'ui.skillApproval.autoCharsSuffix': ' 字。',
    'ui.skillApproval.promptToggle': ' 对话内直接记忆为高价值 pending 时弹一次确认',
    'ui.skillApproval.promptDescPrefix':
      '仅覆盖开放对话中 memory_remember；后台 review 在 turn 结束后无法弹窗，仍到面板审核。每轮最多 ',
    'ui.skillApproval.promptDescSuffix': ' 次。',
    // ── 设置页：卡住的操作 ──
    'ui.frozenOps.title': '⚠️ 卡住的操作（{count}）',
    'ui.frozenOps.desc':
      '这些操作没做完就中断了，需要你决定怎么处理。系统不会自己猜——它宁可停下来等人。'
      + '「前滚」= 认可已经生效的部分并把记账补完；「回滚」= 只在确认从未生效时才可用。',
    'ui.frozenOps.resolved': '已处理（{decision}）',
    'ui.op.rollForwardBtn': '前滚',
    'ui.op.rollBackBtn': '回滚',
    // ── 设置页：Skill 提案 ──
    'ui.proposals.title': 'Skill 提案审阅（{count}）',
    'ui.proposals.desc': '模型只能生成提案，不能自行应用。目标被人改过时会转 stale，不覆盖新内容。',
    'ui.proposals.apply': '应用',
    'ui.proposals.reject': '拒绝',
    // ── 设置页：待确认记忆 ──
    'ui.pending.title': '待确认记忆（审批门）',
    'ui.pending.desc': '模型写入的记忆默认 pending，不会自动注入；人工确认后才「始终生效」。',
    'ui.pending.source': '来源：',
    'ui.pending.discardTitle': '丢弃这条（可恢复，不会物理删除）',
    'ui.pending.discard': '丢弃',
    'ui.pending.confirmAll': '批量确认全部（{count}）',
    'ui.pending.empty': '（无待确认记忆）',
    // ── 设置页：已拒绝 ──
    'ui.rejected.title': '已拒绝（{count}）',
    'ui.rejected.desc':
      '丢弃的记忆不再注入、不占待确认额度、批量确认也不会收回；但不会被物理删除，随时可恢复。',
    'ui.rejected.restoreTitle': '放回待确认队列',
    // ── 设置页：待认领 skill ──
    'ui.unclaimed.title': '待认领 skill（{count}）',
    'ui.unclaimed.desc':
      '这些 skill 看起来是本插件早期生成的，但没有绑定本机身份。为避免把你手写的文件'
      + '误当成插件资产，插件不会自动认领：认领后才会进入自动改写路径，未认领时手动工具照常可用。',
    'ui.unclaimed.claimTitle': '确认这是插件生成的 skill',
    'ui.unclaimed.claim': '认领',
    'ui.unclaimed.claimAll': '全部认领（{count}）',
    // ── 设置页：检索健康度 ──
    'ui.retrieval.title': '记忆检索状态',
    'ui.retrieval.fused': '● 融合检索（bigram + 全文索引）— 召回最佳',
    'ui.retrieval.bigramOnly': '▲ 仅 bigram 检索 — 全文索引不可用，中文长句/转述查询召回会变差',
    'ui.retrieval.degraded': '▲ 全文索引运行时降级 — 召回质量已下降（错误 {count} 次）',
    'ui.retrieval.unknown': '状态未知（尚无检索发生）',
    'ui.retrieval.ftsLabel': '全文索引：',
    'ui.retrieval.enabled': '已启用',
    'ui.retrieval.disabled': '已关闭',
    'ui.retrieval.available': '可用',
    'ui.retrieval.unavailable': '不可用',
    'ui.retrieval.counts': ' · 融合 {fused} 次 / 降级 {degraded} 次',
    // ── 设置页：记忆处置自治程度 ──
    'ui.disposal.title': '记忆处置自治程度',
    'ui.disposal.desc':
      '决定系统如何处理冷记忆。手动/建议档不改数据；整理档只会自动「软删」符合严格规则的低价值记忆，'
      + '可在下方已忘记区恢复。任何档位都不会自动物理删除，技能合并/归档也仍为手动。',
    'ui.disposal.manualLabel': '手动',
    'ui.disposal.manualDesc': '系统不主动提议。你自己在下方受控剪枝里筛选处理。',
    'ui.disposal.suggestLabel': '建议',
    'ui.disposal.suggestDesc':
      '空闲时自动重算「从未注入、从未召回、且过了冷静期」的低价值记忆，列给你看；仍然只提议、不自动删。',
    'ui.disposal.tidyLabel': '整理',
    'ui.disposal.tidyDesc':
      '空闲时自动软删同一批建议候选；每轮最多处理设定数量，可恢复，绝不物理删除；'
      + '最高重要度、偏好、决策、待审、已拒绝和锁定项永不自动处理。',
    'ui.disposal.idleLabel': '空闲触发时间：',
    'ui.disposal.minutes': ' 分钟',
    'ui.disposal.tidyMaxLabel': '每轮最多自动软删：',
    'ui.disposal.items': ' 条',
    'ui.disposal.cooldown': '冷静期：{days} 天。空闲时自动重算，',
    'ui.disposal.lastComputed': '上次算于 {time}',
    'ui.disposal.notYetComputed': '（还未触发，需空闲一段时间）',
    'ui.disposal.candMeta': '冷置 {days} 天 · {reason}',
    'ui.disposal.noCandidates': '（暂无低价值候选——库还小或都在用）',
    'ui.disposal.pruneHint': '要真正清理，请到下方「受控剪枝」勾选执行（两阶段预览→确认，全部可逆）。',
    // ── 设置页：受控剪枝 ──
    'ui.prune.title': '受控剪枝',
    'ui.prune.desc':
      '检测自动、处置显式。冷/低价值记忆与冗余技能在这里由你勾选处理，全部可逆（软删/归档，随时恢复）。',
    'ui.prune.budget': '字符预算：已用 {used} / 上限 {max}',
    'ui.prune.overBudget': '（超限）',
    'ui.prune.memHeading': '待清理记忆',
    'ui.prune.heat': '久未主动访问 · heat {heat}',
    'ui.prune.injected': ' · 自动注入 {count} 次',
    'ui.prune.noMemCandidates': '（无待清理候选）',
    'ui.prune.previewBtn': '预览将处理的记忆',
    'ui.prune.previewTitle': '预览（软删，全部可恢复）：',
    'ui.prune.colAction': '动作',
    'ui.prune.colCount': '数量',
    'ui.prune.colResult': '结果',
    'ui.prune.colNote': '说明',
    'ui.prune.willRun': '将执行',
    'ui.prune.skip': '跳过',
    'ui.prune.requires': '（需 {cap}）',
    'ui.prune.executeBtn': '确认执行',
    'ui.prune.protectedTitle': '保护记录（需专项审阅）',
    'ui.prune.protectedDesc': '偏好 / 决策类记忆本版本不支持直接处置（避免误删长期偏好）。仅供审阅。',
    'ui.prune.convergeTitle': '待收敛技能',
    'ui.prune.similarity': '｜相似度 {similarity}',
    'ui.prune.zeroLoad': '｜零加载 {count}',
    'ui.prune.convergeHint': '技能合并/归档请用对话侧 converge_skill / archive_skill（面板暂只做记忆清理）。',
    'ui.prune.forgottenTitle': '已忘记（可恢复）',
    // ── 设置页：概览 ──
    'ui.overview.title': '记忆 / skill 概览',
    'ui.overview.memoryLine': '记忆：共 {total}（已确认 {confirmed} / 待确认 {pending}），上限 {max}',
    'ui.overview.byKind': '按类型：',
    'ui.overview.topInjected': '最常被注入（真正影响决策）：',
    'ui.overview.triage': '结果三元组：{turns} 轮记录，成功 {successes} / 失败 {failures}',
    'ui.overview.triageOff': '结果三元组：未启用',
    // ── 设置页：已归档 skill ──
    'ui.archives.title': '已归档的 skill（{count}）',
    'ui.archives.desc':
      '归档只是移出活动目录，文件都还在，可以随时恢复。同一个 skill 可以有多份归档，'
      + '按归档编号区分——恢复时挑你要的那一份，不会互相覆盖。',
    'ui.archives.proposeRollback': '提议回滚',
    // ── 设置页：瞬时提示 ──
    'ui.note.batchConfirmed': '✅ 已批量确认 {count} 条 pending 记忆',
    'ui.note.discarded': '🗑️ 已丢弃（可在下方「已拒绝」区恢复）',
    'ui.note.memoryNotFound': '未找到该记忆',
    'ui.note.restoredToPending': '↩️ 已恢复为待确认',
    'ui.note.claimed': '✅ 已认领 {count} 个 skill，此后可进入自动路径',
    'ui.note.nothingToClaim': '没有可认领的 skill',
    'ui.note.proposalDone': '✅ 提案 {status}',
    'ui.note.opRolledForward': '✅ 操作 {opId} 已前滚',
    'ui.note.opRolledBack': '✅ 操作 {opId} 已回滚',
    'ui.note.skillRestored': '♻️ 已恢复 skill「{name}」',
    'ui.note.rollbackProposalCreated': '⏮️ 已生成回滚提案 {id}，请在上方提案列表审阅后应用',
    'ui.note.noSelectableMemories': '未选择可处理的记忆',
    'ui.note.planExpired': '计划已过期，请重新预览',
    'ui.note.pruneDone': '✅ 处理完成：软删 {count} 条{skipped}',
    'ui.note.pruneSkippedSuffix': '，跳过 {count} 条（{details}）',
    'ui.note.restored': '✅ 已恢复',
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
