window.__ModuleLoader__.load({
	id: "dsh-evolve",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		Object.freeze(["en", "zh"]);
		const STRINGS = {
			en: {
				"anchor.recall.header": "Relevant memories (context, NOT the user speaking):",
				"anchor.preferences.header": "[dsh-evolve] Long-term user preferences and facts (always in effect; context, not the user speaking):",
				"anchor.recall.reference": "Relevant memories",
				"anchor.preferences.reference": "[dsh-evolve] Long-term user preferences and facts",
				"tool.remember": "💾 Save memory",
				"tool.recall": "🔎 Recall memory",
				"tool.forget": "🗑️ Forget memory",
				"tool.confirm": "✅ Confirm memory",
				"tool.reject": "🚫 Reject memory",
				"tool.skill": "🧬 Skill",
				"notice.checkpoint": "[dsh-evolve] 🧷 Memories checkpointed to git (revertible)",
				"notice.styleOverlay": "[dsh-evolve] 🎨 User style overlay for skill \"{skill}\" (context, not the user speaking):",
				"notice.repeatedError": "[dsh-evolve] ⚠️ Same class of error seen {count} times: {fingerprint}. Record it with memory_remember as a lesson (kind=lesson, importance=3), and summarise it critically: (1) what went wrong and how to avoid it, (2) what the failure conditions were -- whether a different setup would work, and where the boundary is, (3) which parts did work and are worth keeping. Do not record a conditional failure as an absolute conclusion.",
				"notice.skillExists": "[dsh-evolve] 🧬 A skill tagged \"{tag}\" already exists and has gathered {count} new observations. refine_skill(tag=\"{tag}\") upgrades it in place (appends a Refinement section, bumps the version; your edits are not overwritten).",
				"notice.skillCandidate": "[dsh-evolve] 🧬 Tag \"{tag}\" has gathered {count} high-value lessons/decisions. crystallize_skill(tag=\"{tag}\") can turn them into a reusable skill -- but only if it really is a reusable procedure.",
				"notice.autoArchived": "[dsh-evolve] 📦 Auto-archived long-idle skills: {skills} (moved out of the active directory; restore_skill brings them back; nothing is deleted).",
				"notice.archiveSuggest": "[dsh-evolve] 🧹 These skills have been idle for {days}+ days and could be archived with archive_skill (reversible, not a delete): {skills}",
				"notice.convergence": "[dsh-evolve] 🧭 Convergence suggestions (anti-bloat): {items}",
				"suggest.unclaimedSkills": "{count} skill(s) look like this plugin's work but are not bound to this install; claim them in the panel before they enter the automatic path",
				"suggest.processArtifacts": "{count} pending memor(ies) look like project process artifacts (review conclusions, plan drafts); discard them one by one in the panel's pending section",
				"suggest.archivable": "{count} skill(s) can be archived (archive_skill)",
				"suggest.mergeable": "{count} skill pair(s) can be merged (converge_skill)",
				"suggest.bloated": "{count} skill(s) have refinement sections piling up (fold_skill)",
				"suggest.overBudget": "memories are {chars} characters over budget; merge or forget",
				"suggest.promotable": "{count} memor(ies) can be promoted to global (memory_promote)",
				"suggest.lowEfficiency": "{count} skill(s) look inefficient (loaded often, rarely leading to success); consider merging or refining them",
				"converge.overlap": "\"{a}\" and \"{b}\" overlap heavily ({similarity}); converge_skill can merge them into one umbrella skill (writes the new one, archives the old ones -- reversible, nothing is deleted)",
				"converge.bloated": "{skills} have refinement sections piling up; fold_skill folds them back into clean prose",
				"ui.common.restore": "Restore",
				"ui.common.cancel": "Cancel",
				"ui.common.loading": "Loading…",
				"ui.page.subtitle": "Self-evolving memory + skill lifecycle. Every setting is saved to the plugin config immediately; data refreshes every 8 seconds.",
				"ui.llm.title": "LLM refinement of skill content",
				"ui.llm.enable": "Enable LLM refinement",
				"ui.llm.onLabel": "On",
				"ui.llm.onDesc": ": when crystallizing / refining a skill, call the model selected below once to distil scattered memories into a structured SKILL.md (deduplicated, split into sections, written up as steps/pitfalls). A single call, triggered only on crystallize/refine (possibly 0 times in a session), reusing the provider cache.",
				"ui.llm.offLabel": "Off",
				"ui.llm.offDesc1": ": falls back to deterministic concatenation (memory entries are listed into SKILL.md verbatim), ",
				"ui.llm.offZeroToken": "zero tokens",
				"ui.llm.offDesc2": ", no model is called at all. Fully functional, the content is just not distilled.",
				"ui.llm.modelLabel": "Model used for refinement:",
				"ui.llm.followMain": "(follow DSH's current main model — default)",
				"ui.llm.modelHint": "Leaving it unset = follow the main model (when the main model changes it follows automatically). Picking one pins refinement to that model.",
				"ui.ingest.title": "Memory ingestion autonomy",
				"ui.ingest.desc": "Decides how much of \"what the model / background review wants to remember\" takes effect automatically, and how much you look at first. Switching levels only affects new memories from then on; it does not bulk-release the pending items you already have.",
				"ui.ingest.manualLabel": "Manual",
				"ui.ingest.manualDesc": "Everything goes to pending first and takes effect only after you confirm it one by one. The most conservative.",
				"ui.ingest.balancedLabel": "Balanced (default)",
				"ui.ingest.balancedDesc": "The certain ones (anchored to your own words, or heavily duplicating something already confirmed) take effect automatically; the uncertain ones go to pending.",
				"ui.ingest.autonomousLabel": "Autonomous",
				"ui.ingest.autonomousDesc": "Anything reversible and non-conflicting takes effect automatically; important (imp3) / conflicting items are still forced into pending. The write volume has a separate cap protecting it.",
				"ui.ingest.autonomousWarn": "⚠️ At the autonomous level the background review writes more memories on its own. At most {perTurn} auto-confirmed per turn, and the pending queue is capped at {queueMax} — anything beyond that is refused, to prevent unbounded growth. Conflicts and important memories still need your confirmation.",
				"ui.skillApproval.title": "Skill write approval",
				"ui.skillApproval.desc": "Follows the ingestion level by default: the manual/balanced levels generate a proposal first, only the autonomous level may write directly. To get the old direct-write behaviour back, pick \"Autonomous\" explicitly.",
				"ui.skillApproval.inherit": "Follow the ingestion level (currently: {mode})",
				"ui.skillApproval.manual": "Manual: always a proposal",
				"ui.skillApproval.balanced": "Balanced: always a proposal",
				"ui.skillApproval.autonomous": "Autonomous: direct write once the safety gate passes",
				"ui.skillApproval.manualCharsPrefix": "Manual body limit ",
				"ui.skillApproval.manualCharsSuffix": " chars; ",
				"ui.skillApproval.autoCharsPrefix": "automatic path limit ",
				"ui.skillApproval.autoCharsSuffix": " chars.",
				"ui.skillApproval.promptToggle": " Ask once in the conversation when a direct memory is high-value pending",
				"ui.skillApproval.promptDescPrefix": "Covers only memory_remember in an open conversation; the background review cannot pop a dialog after the turn has ended, so it still goes to the panel for review. At most ",
				"ui.skillApproval.promptDescSuffix": " per turn.",
				"ui.frozenOps.title": "⚠️ Stuck operations ({count})",
				"ui.frozenOps.desc": "These operations were interrupted before they finished, and need you to decide what to do. The system will not guess on its own — it would rather stop and wait for a human. \"Roll forward\" = accept the part that already took effect and finish the bookkeeping; \"Roll back\" = only usable when you have confirmed it never took effect.",
				"ui.frozenOps.resolved": "handled ({decision})",
				"ui.op.rollForwardBtn": "Roll forward",
				"ui.op.rollBackBtn": "Roll back",
				"ui.proposals.title": "Skill proposal review ({count})",
				"ui.proposals.desc": "The model can only generate proposals, it cannot apply them itself. When the target has been changed by a human the proposal turns stale rather than overwriting the new content.",
				"ui.proposals.apply": "Apply",
				"ui.proposals.reject": "Reject",
				"ui.pending.title": "Pending memories (approval gate)",
				"ui.pending.desc": "Memories written by the model are pending by default and are not injected automatically; only after human confirmation are they \"always in effect\".",
				"ui.pending.source": "Source: ",
				"ui.pending.discardTitle": "Discard this one (recoverable, never physically deleted)",
				"ui.pending.discard": "Discard",
				"ui.pending.confirmAll": "Confirm all ({count})",
				"ui.pending.empty": "(no pending memories)",
				"ui.rejected.title": "Rejected ({count})",
				"ui.rejected.desc": "Discarded memories are no longer injected, do not take up the pending quota, and batch-confirm will not pull them back in; but they are not physically deleted and can be restored at any time.",
				"ui.rejected.restoreTitle": "Put it back in the pending queue",
				"ui.unclaimed.title": "Skills awaiting claim ({count})",
				"ui.unclaimed.desc": "These skills look like they were generated by an early version of this plugin, but they are not bound to this machine's identity. To avoid mistaking files you wrote by hand for plugin assets, the plugin does not claim them automatically: only after claiming do they enter the automatic rewrite path, and while unclaimed the manual tools work as usual.",
				"ui.unclaimed.claimTitle": "Confirm this is a plugin-generated skill",
				"ui.unclaimed.claim": "Claim",
				"ui.unclaimed.claimAll": "Claim all ({count})",
				"ui.retrieval.title": "Memory retrieval status",
				"ui.retrieval.fused": "● Fused retrieval (bigram + full-text index) — best recall",
				"ui.retrieval.bigramOnly": "▲ bigram retrieval only — the full-text index is unavailable, recall for long Chinese sentences / paraphrased queries will get worse",
				"ui.retrieval.degraded": "▲ The full-text index degraded at runtime — recall quality has dropped ({count} errors)",
				"ui.retrieval.unknown": "Status unknown (no retrieval has happened yet)",
				"ui.retrieval.ftsLabel": "Full-text index: ",
				"ui.retrieval.enabled": "enabled",
				"ui.retrieval.disabled": "disabled",
				"ui.retrieval.available": "available",
				"ui.retrieval.unavailable": "unavailable",
				"ui.retrieval.counts": " · fused {fused} times / degraded {degraded} times",
				"ui.disposal.title": "Memory disposal autonomy",
				"ui.disposal.desc": "Decides how the system handles cold memories. The manual/suggest levels do not change data; the tidy level only auto-\"soft-deletes\" low-value memories that match strict rules, and they can be restored from the forgotten section below. No level ever physically deletes automatically, and skill merging/archiving also stays manual.",
				"ui.disposal.manualLabel": "Manual",
				"ui.disposal.manualDesc": "The system does not propose anything on its own. You pick and handle things yourself in the controlled prune below.",
				"ui.disposal.suggestLabel": "Suggest",
				"ui.disposal.suggestDesc": "When idle, automatically recomputes the low-value memories that were \"never injected, never recalled, and past the cooldown period\" and lists them for you; it still only suggests, it never deletes automatically.",
				"ui.disposal.tidyLabel": "Tidy",
				"ui.disposal.tidyDesc": "When idle, automatically soft-deletes that same batch of suggested candidates; at most the configured number per run, recoverable, never a physical delete; top-importance, preference, decision, pending, rejected and pinned items are never handled automatically.",
				"ui.disposal.idleLabel": "Idle trigger time: ",
				"ui.disposal.minutes": " minutes",
				"ui.disposal.tidyMaxLabel": "Max auto soft-deletes per run: ",
				"ui.disposal.items": " items",
				"ui.disposal.cooldown": "Cooldown period: {days} days. Recomputed automatically when idle, ",
				"ui.disposal.lastComputed": "last computed at {time}",
				"ui.disposal.notYetComputed": "(not triggered yet, needs a stretch of idle time)",
				"ui.disposal.candMeta": "cold for {days} days · {reason}",
				"ui.disposal.noCandidates": "(no low-value candidates for now — the store is still small, or everything is in use)",
				"ui.disposal.pruneHint": "To actually clean up, go to \"Controlled prune\" below, tick the items and run it (two-stage preview → confirm, all reversible).",
				"ui.prune.title": "Controlled prune",
				"ui.prune.desc": "Detection is automatic, disposal is explicit. Cold / low-value memories and redundant skills are handled here by your tick, all reversible (soft delete / archive, restorable at any time).",
				"ui.prune.budget": "Character budget: {used} used / {max} limit",
				"ui.prune.overBudget": "(over the limit)",
				"ui.prune.memHeading": "Memories to clean up",
				"ui.prune.heat": "not actively accessed for a long time · heat {heat}",
				"ui.prune.injected": " · auto-injected {count} times",
				"ui.prune.noMemCandidates": "(no cleanup candidates)",
				"ui.prune.previewBtn": "Preview the memories that will be handled",
				"ui.prune.previewTitle": "Preview (soft delete, all recoverable):",
				"ui.prune.colAction": "Action",
				"ui.prune.colCount": "Count",
				"ui.prune.colResult": "Result",
				"ui.prune.colNote": "Note",
				"ui.prune.willRun": "will run",
				"ui.prune.skip": "skipped",
				"ui.prune.requires": " (needs {cap})",
				"ui.prune.executeBtn": "Confirm and run",
				"ui.prune.protectedTitle": "Protected records (need a dedicated review)",
				"ui.prune.protectedDesc": "Preference / decision memories cannot be disposed of directly in this version (so long-term preferences are not deleted by mistake). For review only.",
				"ui.prune.convergeTitle": "Skills to converge",
				"ui.prune.similarity": " | similarity {similarity}",
				"ui.prune.zeroLoad": " | zero loads {count}",
				"ui.prune.convergeHint": "For skill merging/archiving use converge_skill / archive_skill on the conversation side (the panel only does memory cleanup for now).",
				"ui.prune.forgottenTitle": "Forgotten (recoverable)",
				"ui.overview.title": "Memory / skill overview",
				"ui.overview.memoryLine": "Memories: {total} in total ({confirmed} confirmed / {pending} pending), limit {max}",
				"ui.overview.byKind": "By kind: ",
				"ui.overview.topInjected": "Most often injected (what actually influences decisions):",
				"ui.overview.triage": "Outcome triples: {turns} turns recorded, {successes} succeeded / {failures} failed",
				"ui.overview.triageOff": "Outcome triples: not enabled",
				"ui.archives.title": "Archived skills ({count})",
				"ui.archives.desc": "Archiving only moves a skill out of the active directory; the files are all still there and can be restored at any time. The same skill can have several archives, told apart by archive id — pick the one you want when restoring, they do not overwrite each other.",
				"ui.archives.proposeRollback": "Propose rollback",
				"ui.note.batchConfirmed": "✅ Batch-confirmed {count} pending memor(ies)",
				"ui.note.discarded": "🗑️ Discarded (restorable in the \"Rejected\" section below)",
				"ui.note.memoryNotFound": "That memory was not found",
				"ui.note.restoredToPending": "↩️ Restored to pending",
				"ui.note.claimed": "✅ Claimed {count} skill(s); from now on they can enter the automatic path",
				"ui.note.nothingToClaim": "There is no skill to claim",
				"ui.note.proposalDone": "✅ Proposal {status}",
				"ui.note.opRolledForward": "✅ Operation {opId} rolled forward",
				"ui.note.opRolledBack": "✅ Operation {opId} rolled back",
				"ui.note.skillRestored": "♻️ Restored skill \"{name}\"",
				"ui.note.rollbackProposalCreated": "⏮️ Rollback proposal {id} created; review it in the proposal list above, then apply it",
				"ui.note.noSelectableMemories": "No handleable memory selected",
				"ui.note.planExpired": "The plan has expired, please preview again",
				"ui.note.pruneDone": "✅ Done: {count} memor(ies) soft-deleted{skipped}",
				"ui.note.pruneSkippedSuffix": ", {count} skipped ({details})",
				"ui.note.restored": "✅ Restored"
			},
			zh: {
				"anchor.recall.header": "相关记忆（context, 不是用户在说话）:",
				"anchor.preferences.header": "【dsh-evolve】用户长期偏好/事实（始终生效, context 非用户发言）:",
				"anchor.recall.reference": "相关记忆",
				"anchor.preferences.reference": "【dsh-evolve】用户长期偏好/事实",
				"tool.remember": "💾 存记忆",
				"tool.recall": "🔎 检索记忆",
				"tool.forget": "🗑️ 忘记记忆",
				"tool.confirm": "✅ 确认记忆",
				"tool.reject": "🚫 拒绝记忆",
				"tool.skill": "🧬 技能",
				"notice.checkpoint": "【dsh-evolve】🧷 记忆已自动 git checkpoint（可回滚）",
				"notice.styleOverlay": "【dsh-evolve】🎨 skill「{skill}」的用户风格叠加（context，非用户发言）：",
				"notice.repeatedError": "【dsh-evolve】⚠️ 检测到同类错误第 {count} 次：{fingerprint}。请用 memory_remember 固化为教训(kind=lesson, importance=3)，并辩证总结：①错在哪、怎么规避 ②失败条件是什么(换条件是否可行、标注边界) ③有没有其实有效、值得保留的部分。避免把条件性失败记成绝对结论。",
				"notice.skillExists": "【dsh-evolve】🧬 标签「{tag}」的 skill 已存在，且积累了 {count} 条新经验，可用 refine_skill(tag=\"{tag}\") 就地精炼升级（追加 Refinement 段、版本号+1，不覆盖你的编辑）。",
				"notice.skillCandidate": "【dsh-evolve】🧬 标签「{tag}」已积累 {count} 条高价值 lesson/decision，可考虑用 crystallize_skill(tag=\"{tag}\") 固化成可复用 skill（仅当它确实是可复用流程时）。",
				"notice.autoArchived": "【dsh-evolve】📦 已自动归档长期闲置 skill：{skills}（移出活动目录，可 restore_skill 恢复；未删除）。",
				"notice.archiveSuggest": "【dsh-evolve】🧹 以下 skill 已闲置 ≥{days}天，可考虑 archive_skill 归档（可逆、不删）：{skills}。",
				"notice.convergence": "【dsh-evolve】🧭 收敛建议（防臃肿）：{items}",
				"suggest.unclaimedSkills": "{count} 个 skill 看似本插件生成但未绑定本机身份,需在面板确认认领后才会进入自动路径",
				"suggest.processArtifacts": "{count} 条待确认记忆疑似项目过程产物(评审结论/方案稿),建议在面板「待确认」区逐条丢弃",
				"suggest.archivable": "{count} 个 skill 可归档(archive_skill)",
				"suggest.mergeable": "{count} 对 skill 可合并(converge_skill)",
				"suggest.bloated": "{count} 个 skill 精炼段堆积可折叠(fold_skill)",
				"suggest.overBudget": "记忆超预算 {chars} 字符,可合并/forget",
				"suggest.promotable": "{count} 条记忆可升级为全局(memory_promote)",
				"suggest.lowEfficiency": "{count} 个 skill 疑似低效(高加载低成功),可考虑合并/精炼",
				"converge.overlap": "「{a}」与「{b}」高度重叠({similarity})，可 converge_skill 合并为一个 umbrella skill（生成新的 + 归档旧的，可逆、不删）",
				"converge.bloated": "{skills} 精炼段堆积，可 fold_skill 折叠回干净正文",
				"ui.common.restore": "恢复",
				"ui.common.cancel": "取消",
				"ui.common.loading": "加载中…",
				"ui.page.subtitle": "自进化记忆 + skill 生命周期。所有设置即时保存到插件配置；数据每 8 秒刷新。",
				"ui.llm.title": "LLM 精炼 skill 内容",
				"ui.llm.enable": "启用 LLM 精炼",
				"ui.llm.onLabel": "打开",
				"ui.llm.onDesc": "：结晶 / 精炼 skill 时，调用一次下方所选模型，把零散记忆提炼成结构化 SKILL.md（去重、分节、写成步骤/坑）。单次调用、仅在结晶/精炼时触发（一次会话可能 0 次），复用 provider 缓存。",
				"ui.llm.offLabel": "关闭",
				"ui.llm.offDesc1": "：改用确定性拼接（原样把记忆条目列进 SKILL.md），",
				"ui.llm.offZeroToken": "零 token",
				"ui.llm.offDesc2": "、不调用任何模型。功能完全可用，只是内容不经提炼。",
				"ui.llm.modelLabel": "精炼使用的模型：",
				"ui.llm.followMain": "（跟随 DSH 当前主模型 — 默认）",
				"ui.llm.modelHint": "不选 = 跟随主模型（主模型换了它自动跟随）。选了则固定用该模型精炼。",
				"ui.ingest.title": "记忆摄入自治程度",
				"ui.ingest.desc": "决定「模型/后台评审想记的东西」有多少能自动生效，多少要你先过目。切档只影响之后的新记忆，不会批量放行已有的待确认项。",
				"ui.ingest.manualLabel": "手动",
				"ui.ingest.manualDesc": "全部先进待确认，你逐条确认后才生效。最保守。",
				"ui.ingest.balancedLabel": "平衡（默认）",
				"ui.ingest.balancedDesc": "拿得准的（锚定你原话、或与已确认高度重复）自动生效；拿不准的进待确认。",
				"ui.ingest.autonomousLabel": "自治",
				"ui.ingest.autonomousDesc": "凡是可逆、不冲突的都自动生效；重要(imp3)/冲突项仍强制进待确认。写入量另有上限保护。",
				"ui.ingest.autonomousWarn": "⚠️ 自治档下后台评审会自动写入更多记忆。每轮最多自动确认 {perTurn} 条，待确认队列上限 {queueMax} 条——超出的会被拒收以防无界增长。冲突和重要记忆仍需你确认。",
				"ui.skillApproval.title": "Skill 写入审批",
				"ui.skillApproval.desc": "默认跟随摄入档：手动/平衡档先生成提案，只有自主档可直写。要恢复旧式直写可显式选“自主”。",
				"ui.skillApproval.inherit": "跟随摄入档（当前：{mode}）",
				"ui.skillApproval.manual": "手动：全部提案",
				"ui.skillApproval.balanced": "平衡：全部提案",
				"ui.skillApproval.autonomous": "自主：过安全闸后直写",
				"ui.skillApproval.manualCharsPrefix": "人工正文上限 ",
				"ui.skillApproval.manualCharsSuffix": " 字；",
				"ui.skillApproval.autoCharsPrefix": "自动路径上限 ",
				"ui.skillApproval.autoCharsSuffix": " 字。",
				"ui.skillApproval.promptToggle": " 对话内直接记忆为高价值 pending 时弹一次确认",
				"ui.skillApproval.promptDescPrefix": "仅覆盖开放对话中 memory_remember；后台 review 在 turn 结束后无法弹窗，仍到面板审核。每轮最多 ",
				"ui.skillApproval.promptDescSuffix": " 次。",
				"ui.frozenOps.title": "⚠️ 卡住的操作（{count}）",
				"ui.frozenOps.desc": "这些操作没做完就中断了，需要你决定怎么处理。系统不会自己猜——它宁可停下来等人。「前滚」= 认可已经生效的部分并把记账补完；「回滚」= 只在确认从未生效时才可用。",
				"ui.frozenOps.resolved": "已处理（{decision}）",
				"ui.op.rollForwardBtn": "前滚",
				"ui.op.rollBackBtn": "回滚",
				"ui.proposals.title": "Skill 提案审阅（{count}）",
				"ui.proposals.desc": "模型只能生成提案，不能自行应用。目标被人改过时会转 stale，不覆盖新内容。",
				"ui.proposals.apply": "应用",
				"ui.proposals.reject": "拒绝",
				"ui.pending.title": "待确认记忆（审批门）",
				"ui.pending.desc": "模型写入的记忆默认 pending，不会自动注入；人工确认后才「始终生效」。",
				"ui.pending.source": "来源：",
				"ui.pending.discardTitle": "丢弃这条（可恢复，不会物理删除）",
				"ui.pending.discard": "丢弃",
				"ui.pending.confirmAll": "批量确认全部（{count}）",
				"ui.pending.empty": "（无待确认记忆）",
				"ui.rejected.title": "已拒绝（{count}）",
				"ui.rejected.desc": "丢弃的记忆不再注入、不占待确认额度、批量确认也不会收回；但不会被物理删除，随时可恢复。",
				"ui.rejected.restoreTitle": "放回待确认队列",
				"ui.unclaimed.title": "待认领 skill（{count}）",
				"ui.unclaimed.desc": "这些 skill 看起来是本插件早期生成的，但没有绑定本机身份。为避免把你手写的文件误当成插件资产，插件不会自动认领：认领后才会进入自动改写路径，未认领时手动工具照常可用。",
				"ui.unclaimed.claimTitle": "确认这是插件生成的 skill",
				"ui.unclaimed.claim": "认领",
				"ui.unclaimed.claimAll": "全部认领（{count}）",
				"ui.retrieval.title": "记忆检索状态",
				"ui.retrieval.fused": "● 融合检索（bigram + 全文索引）— 召回最佳",
				"ui.retrieval.bigramOnly": "▲ 仅 bigram 检索 — 全文索引不可用，中文长句/转述查询召回会变差",
				"ui.retrieval.degraded": "▲ 全文索引运行时降级 — 召回质量已下降（错误 {count} 次）",
				"ui.retrieval.unknown": "状态未知（尚无检索发生）",
				"ui.retrieval.ftsLabel": "全文索引：",
				"ui.retrieval.enabled": "已启用",
				"ui.retrieval.disabled": "已关闭",
				"ui.retrieval.available": "可用",
				"ui.retrieval.unavailable": "不可用",
				"ui.retrieval.counts": " · 融合 {fused} 次 / 降级 {degraded} 次",
				"ui.disposal.title": "记忆处置自治程度",
				"ui.disposal.desc": "决定系统如何处理冷记忆。手动/建议档不改数据；整理档只会自动「软删」符合严格规则的低价值记忆，可在下方已忘记区恢复。任何档位都不会自动物理删除，技能合并/归档也仍为手动。",
				"ui.disposal.manualLabel": "手动",
				"ui.disposal.manualDesc": "系统不主动提议。你自己在下方受控剪枝里筛选处理。",
				"ui.disposal.suggestLabel": "建议",
				"ui.disposal.suggestDesc": "空闲时自动重算「从未注入、从未召回、且过了冷静期」的低价值记忆，列给你看；仍然只提议、不自动删。",
				"ui.disposal.tidyLabel": "整理",
				"ui.disposal.tidyDesc": "空闲时自动软删同一批建议候选；每轮最多处理设定数量，可恢复，绝不物理删除；最高重要度、偏好、决策、待审、已拒绝和锁定项永不自动处理。",
				"ui.disposal.idleLabel": "空闲触发时间：",
				"ui.disposal.minutes": " 分钟",
				"ui.disposal.tidyMaxLabel": "每轮最多自动软删：",
				"ui.disposal.items": " 条",
				"ui.disposal.cooldown": "冷静期：{days} 天。空闲时自动重算，",
				"ui.disposal.lastComputed": "上次算于 {time}",
				"ui.disposal.notYetComputed": "（还未触发，需空闲一段时间）",
				"ui.disposal.candMeta": "冷置 {days} 天 · {reason}",
				"ui.disposal.noCandidates": "（暂无低价值候选——库还小或都在用）",
				"ui.disposal.pruneHint": "要真正清理，请到下方「受控剪枝」勾选执行（两阶段预览→确认，全部可逆）。",
				"ui.prune.title": "受控剪枝",
				"ui.prune.desc": "检测自动、处置显式。冷/低价值记忆与冗余技能在这里由你勾选处理，全部可逆（软删/归档，随时恢复）。",
				"ui.prune.budget": "字符预算：已用 {used} / 上限 {max}",
				"ui.prune.overBudget": "（超限）",
				"ui.prune.memHeading": "待清理记忆",
				"ui.prune.heat": "久未主动访问 · heat {heat}",
				"ui.prune.injected": " · 自动注入 {count} 次",
				"ui.prune.noMemCandidates": "（无待清理候选）",
				"ui.prune.previewBtn": "预览将处理的记忆",
				"ui.prune.previewTitle": "预览（软删，全部可恢复）：",
				"ui.prune.colAction": "动作",
				"ui.prune.colCount": "数量",
				"ui.prune.colResult": "结果",
				"ui.prune.colNote": "说明",
				"ui.prune.willRun": "将执行",
				"ui.prune.skip": "跳过",
				"ui.prune.requires": "（需 {cap}）",
				"ui.prune.executeBtn": "确认执行",
				"ui.prune.protectedTitle": "保护记录（需专项审阅）",
				"ui.prune.protectedDesc": "偏好 / 决策类记忆本版本不支持直接处置（避免误删长期偏好）。仅供审阅。",
				"ui.prune.convergeTitle": "待收敛技能",
				"ui.prune.similarity": "｜相似度 {similarity}",
				"ui.prune.zeroLoad": "｜零加载 {count}",
				"ui.prune.convergeHint": "技能合并/归档请用对话侧 converge_skill / archive_skill（面板暂只做记忆清理）。",
				"ui.prune.forgottenTitle": "已忘记（可恢复）",
				"ui.overview.title": "记忆 / skill 概览",
				"ui.overview.memoryLine": "记忆：共 {total}（已确认 {confirmed} / 待确认 {pending}），上限 {max}",
				"ui.overview.byKind": "按类型：",
				"ui.overview.topInjected": "最常被注入（真正影响决策）：",
				"ui.overview.triage": "结果三元组：{turns} 轮记录，成功 {successes} / 失败 {failures}",
				"ui.overview.triageOff": "结果三元组：未启用",
				"ui.archives.title": "已归档的 skill（{count}）",
				"ui.archives.desc": "归档只是移出活动目录，文件都还在，可以随时恢复。同一个 skill 可以有多份归档，按归档编号区分——恢复时挑你要的那一份，不会互相覆盖。",
				"ui.archives.proposeRollback": "提议回滚",
				"ui.note.batchConfirmed": "✅ 已批量确认 {count} 条 pending 记忆",
				"ui.note.discarded": "🗑️ 已丢弃（可在下方「已拒绝」区恢复）",
				"ui.note.memoryNotFound": "未找到该记忆",
				"ui.note.restoredToPending": "↩️ 已恢复为待确认",
				"ui.note.claimed": "✅ 已认领 {count} 个 skill，此后可进入自动路径",
				"ui.note.nothingToClaim": "没有可认领的 skill",
				"ui.note.proposalDone": "✅ 提案 {status}",
				"ui.note.opRolledForward": "✅ 操作 {opId} 已前滚",
				"ui.note.opRolledBack": "✅ 操作 {opId} 已回滚",
				"ui.note.skillRestored": "♻️ 已恢复 skill「{name}」",
				"ui.note.rollbackProposalCreated": "⏮️ 已生成回滚提案 {id}，请在上方提案列表审阅后应用",
				"ui.note.noSelectableMemories": "未选择可处理的记忆",
				"ui.note.planExpired": "计划已过期，请重新预览",
				"ui.note.pruneDone": "✅ 处理完成：软删 {count} 条{skipped}",
				"ui.note.pruneSkippedSuffix": "，跳过 {count} 条（{details}）",
				"ui.note.restored": "✅ 已恢复"
			}
		};
		/**
		* Look up `key` in `lang`, substituting {placeholders} from `vars`.
		*
		* A missing key falls back to English and then to the key itself, so a typo degrades
		* to something traceable instead of rendering "undefined" into a prompt.
		*/
		function t(lang, key, vars = {}) {
			return ((STRINGS[lang] ?? STRINGS["en"])[key] ?? STRINGS["en"][key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
		}
		Object.freeze([["anchor.recall.header", "anchor.recall.reference"], ["anchor.preferences.header", "anchor.preferences.reference"]]);
		//#endregion
		//#region src/client/EvolveSettingsSection.tsx
		/**
		* "dsh-evolve" settings section — a complete settings page with three blocks:
		*
		*  1. LLM refinement: on/off toggle + model dropdown (configured models from the
		*     host via ctx.llm; empty selection = follow DSH's current main model). The
		*     open/close effect is spelled out next to the toggle.
		*  2. Approval queue: lists pending memories (importance-sorted) + a batch-confirm
		*     button — the human-approval convenience entry.
		*  3. Overview: memory stats (totals / by-kind / most-injected) + skill stats
		*     (active/stale/archived) + outcome-triage summary.
		*
		* All data comes from the host's same-origin /api/evolve/* routes (loopback
		* fenced). The component owns its own polling + POSTs.
		*/
		const API = "/api/evolve";
		async function apiGet(path) {
			const res = await fetch(path);
			if (!res.ok) throw new Error(`${path} -> ${res.status}`);
			return await res.json();
		}
		async function apiPost(path, body) {
			const res = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error(`${path} -> ${res.status}`);
			return await res.json();
		}
		const box = {
			border: "1px solid var(--dsh-border, #333)",
			borderRadius: 8,
			padding: 12,
			marginBottom: 12
		};
		const btn = {
			padding: "6px 12px",
			borderRadius: 6,
			border: "1px solid var(--dsh-border, #444)",
			cursor: "pointer",
			marginRight: 8
		};
		const btnPrimary = {
			...btn,
			background: "var(--dsh-accent, #2563eb)",
			color: "#fff",
			border: "none"
		};
		const mono = {
			fontFamily: "ui-monospace, monospace",
			fontSize: 12
		};
		const dim = {
			opacity: .7,
			fontSize: 13
		};
		const btnTiny = {
			...btn,
			padding: "2px 8px",
			fontSize: 11,
			marginRight: 0
		};
		function EvolveSettingsSection(_props) {
			const [state, setState] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
			const lang = state?.language ?? "en";
			const t$1 = (0, react.useCallback)((key, vars) => t(lang, key, vars), [lang]);
			const refresh = (0, react.useCallback)(async () => {
				try {
					setState(await apiGet(`${API}/state`));
				} catch (e) {
					setNote(String(e));
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
				const t = window.setInterval(() => {
					refresh();
				}, 8e3);
				return () => window.clearInterval(t);
			}, [refresh]);
			const setConfig = (0, react.useCallback)(async (patch) => {
				setSaving(true);
				setNote("");
				try {
					await apiPost(`${API}/action`, {
						action: "set-config",
						...patch
					});
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refresh]);
			const confirmBatch = (0, react.useCallback)(async () => {
				setSaving(true);
				setNote("");
				try {
					const r = await apiPost(`${API}/action`, { action: "confirm-batch" });
					setNote(t$1("ui.note.batchConfirmed", { count: r.confirmed }));
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refresh, t$1]);
			const rejectOne = (0, react.useCallback)(async (id) => {
				setSaving(true);
				setNote("");
				try {
					const cap = await apiPost(`${API}/capability/mint`, {
						purpose: "memory-discard",
						target: { ids: [id] }
					});
					const r = await apiPost(`${API}/memory/discard`, {
						ids: [id],
						capId: cap.capId,
						opId: `discard_${Date.now().toString(36)}`
					});
					setNote(r.rejected > 0 ? t$1("ui.note.discarded") : t$1("ui.note.memoryNotFound"));
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refresh, t$1]);
			const restoreOne = (0, react.useCallback)(async (id) => {
				setSaving(true);
				setNote("");
				try {
					const cap = await apiPost(`${API}/capability/mint`, {
						purpose: "memory-restore-rejected",
						target: { ids: [id] }
					});
					const r = await apiPost(`${API}/memory/restore-rejected`, {
						ids: [id],
						capId: cap.capId,
						opId: `restore_${Date.now().toString(36)}`
					});
					setNote(r.restored > 0 ? t$1("ui.note.restoredToPending") : t$1("ui.note.memoryNotFound"));
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refresh, t$1]);
			const claimSkills = (0, react.useCallback)(async (names) => {
				setSaving(true);
				setNote("");
				try {
					const r = await apiPost(`${API}/action`, {
						action: "claim-legacy-skills",
						names
					});
					setNote(r.claimed > 0 ? t$1("ui.note.claimed", { count: r.claimed }) : t$1("ui.note.nothingToClaim"));
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refresh, t$1]);
			const proposalAction = (0, react.useCallback)(async (id, action) => {
				setSaving(true);
				setNote("");
				try {
					const cap = await apiPost(`${API}/capability/mint`, {
						purpose: `proposal-${action}`,
						target: { proposalId: id }
					});
					const r = await apiPost(`${API}/proposals/${id}/${action}`, {
						opId: `${action}_${Date.now().toString(36)}`,
						capId: cap.capId
					});
					setNote(r.reason ? `${r.status}: ${r.reason}` : t$1("ui.note.proposalDone", { status: r.status }));
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refresh, t$1]);
			const [frozenOps, setFrozenOps] = (0, react.useState)([]);
			const [archives, setArchives] = (0, react.useState)([]);
			const loadOperations = (0, react.useCallback)(async () => {
				try {
					const r = await apiGet(`${API}/operations`);
					setFrozenOps(r.operations ?? []);
				} catch {}
			}, []);
			const loadArchives = (0, react.useCallback)(async () => {
				try {
					const r = await apiGet(`${API}/skills/archives`);
					setArchives(r.archives ?? []);
				} catch {}
			}, []);
			/**
			* Resolve a frozen operation.
			*
			* observedConflictHash is sent back exactly as it was rendered, so a decision
			* made against a conflict that has since changed is refused by the server
			* rather than applied to a different state.
			*/
			const resolveOp = (0, react.useCallback)(async (op, decision) => {
				setSaving(true);
				try {
					const cap = await apiPost(`${API}/capability/mint`, {
						purpose: "operation-resolve",
						target: {
							resolvesOpId: op.opId,
							resolvedKind: op.kind,
							observedConflictHash: op.observedConflictHash,
							decision
						}
					});
					const r = await apiPost(`${API}/operations/${op.opId}/resolve`, {
						decision,
						resolvedKind: op.kind,
						observedConflictHash: op.observedConflictHash,
						capId: cap.capId
					});
					setNote(r.reason ? `${r.status}: ${r.reason}` : t$1(decision === "ROLL_FORWARD" ? "ui.note.opRolledForward" : "ui.note.opRolledBack", { opId: op.opId }));
					await loadOperations();
				} catch (e) {
					setNote(`❌ ${e.message}`);
				} finally {
					setSaving(false);
				}
			}, [loadOperations, t$1]);
			const restoreArchive = (0, react.useCallback)(async (a) => {
				setSaving(true);
				try {
					const cap = await apiPost(`${API}/capability/mint`, {
						purpose: "skill-restore",
						target: {
							archiveId: a.archiveId,
							logicalSkillName: a.logicalSkillName
						}
					});
					const r = await apiPost(`${API}/skills/restore`, {
						archiveId: a.archiveId,
						logicalSkillName: a.logicalSkillName,
						capId: cap.capId,
						opId: `restore_${Date.now().toString(36)}`
					});
					setNote(r.reason ? `${r.status}: ${r.reason}` : t$1("ui.note.skillRestored", { name: r.name ?? a.logicalSkillName }));
					await loadArchives();
				} catch (e) {
					setNote(`❌ ${e.message}`);
				} finally {
					setSaving(false);
				}
			}, [loadArchives, t$1]);
			const proposeRollback = (0, react.useCallback)(async (name) => {
				setSaving(true);
				try {
					const cap = await apiPost(`${API}/capability/mint`, {
						purpose: "rollback-proposal-create",
						target: { logicalSkillName: name }
					});
					const r = await apiPost(`${API}/skills/rollback-proposal`, {
						name,
						capId: cap.capId,
						opId: `rbp_${Date.now().toString(36)}`
					});
					setNote(r.reason ? `${r.status}: ${r.reason}` : t$1("ui.note.rollbackProposalCreated", { id: r.proposalId }));
					await refresh();
				} catch (e) {
					setNote(`❌ ${e.message}`);
				} finally {
					setSaving(false);
				}
			}, [refresh, t$1]);
			const [prune, setPrune] = (0, react.useState)(null);
			const [selMem, setSelMem] = (0, react.useState)({});
			const [preview, setPreview] = (0, react.useState)(null);
			const refreshPrune = (0, react.useCallback)(async () => {
				try {
					setPrune(await apiGet(`${API}/prune`));
				} catch (e) {}
			}, []);
			(0, react.useEffect)(() => {
				refreshPrune();
				const t = window.setInterval(() => {
					refreshPrune();
				}, 8e3);
				return () => window.clearInterval(t);
			}, [refreshPrune]);
			(0, react.useEffect)(() => {
				loadOperations();
				loadArchives();
				const t = window.setInterval(() => {
					loadOperations();
				}, 8e3);
				return () => window.clearInterval(t);
			}, [loadOperations, loadArchives]);
			const toggleMem = (0, react.useCallback)((id) => {
				setSelMem((m) => ({
					...m,
					[id]: !m[id]
				}));
			}, []);
			const doPreview = (0, react.useCallback)(async () => {
				if (!prune) return;
				const ids = prune.memoryCandidates.filter((c) => selMem[c.id] && c.allowedActions.includes("memory-forget")).map((c) => c.id);
				if (ids.length === 0) {
					setNote(t$1("ui.note.noSelectableMemories"));
					return;
				}
				setSaving(true);
				setNote("");
				try {
					const r = await apiPost(`${API}/prune/preview`, { selection: { decisions: [{
						action: "memory-forget",
						entityType: "memory",
						memoryIds: ids,
						reason: "panel prune"
					}] } });
					setPreview(r);
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [
				prune,
				selMem,
				t$1
			]);
			const doExecute = (0, react.useCallback)(async () => {
				if (!preview?.planDigest) return;
				setSaving(true);
				setNote("");
				try {
					const r = await apiPost(`${API}/prune/execute`, { planDigest: preview.planDigest });
					if (r.status === "plan-expired") setNote(t$1("ui.note.planExpired"));
					else {
						const skipped = (r.skipped?.length ?? 0) > 0 ? t$1("ui.note.pruneSkippedSuffix", {
							count: r.skipped.length,
							details: r.skipped.map((s) => `${s.target}:${s.reason}`).join("; ")
						}) : "";
						setNote(t$1("ui.note.pruneDone", {
							count: r.applied?.length ?? 0,
							skipped
						}));
					}
					setPreview(null);
					setSelMem({});
					await refreshPrune();
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [
				preview,
				refreshPrune,
				refresh,
				t$1
			]);
			const doRestore = (0, react.useCallback)(async (id) => {
				setSaving(true);
				setNote("");
				try {
					const r = await apiPost(`${API}/prune/preview`, { selection: { decisions: [{
						action: "memory-restore",
						entityType: "memory",
						memoryIds: [id],
						reason: "restore"
					}] } });
					if (r?.planDigest) await apiPost(`${API}/prune/execute`, { planDigest: r.planDigest });
					setNote(t$1("ui.note.restored"));
					await refreshPrune();
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [
				refreshPrune,
				refresh,
				t$1
			]);
			const s = state;
			const cfg = s?.config;
			const triage = s?.skillStats?.triage;
			const triageOn = triage && !("disabled" in triage);
			const currentModelKey = cfg && cfg.refineProvider && cfg.refineModel ? `${cfg.refineProvider}\u0000${cfg.refineModel}` : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					style: { marginTop: 0 },
					children: "dsh-evolve"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: dim,
					children: t$1("ui.page.subtitle")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t$1("ui.llm.title") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { marginTop: 8 },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: { cursor: "pointer" },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: cfg?.refineLLM ?? false,
										disabled: saving || !cfg,
										onChange: (e) => void setConfig({ refineLLM: e.target.checked })
									}),
									" ",
									t$1("ui.llm.enable")
								]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...dim,
								marginTop: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t$1("ui.llm.onLabel") }), t$1("ui.llm.onDesc")] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 4 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t$1("ui.llm.offLabel") }),
									t$1("ui.llm.offDesc1"),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t$1("ui.llm.offZeroToken") }),
									t$1("ui.llm.offDesc2")
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 10 },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: dim,
									children: t$1("ui.llm.modelLabel")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									style: {
										marginTop: 4,
										minWidth: 320,
										padding: 4
									},
									value: currentModelKey,
									disabled: saving || !cfg,
									onChange: (e) => {
										const v = e.target.value;
										if (v === "") setConfig({
											refineProvider: "",
											refineModel: ""
										});
										else {
											const [provider, model] = v.split("\0");
											setConfig({
												refineProvider: provider,
												refineModel: model
											});
										}
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t$1("ui.llm.followMain")
									}), (s?.models ?? []).map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: `${m.provider}\u0000${m.model}`,
										children: [
											m.provider,
											" / ",
											m.model
										]
									}, `${m.provider}\u0000${m.model}`))]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										...dim,
										marginTop: 4
									},
									children: t$1("ui.llm.modelHint")
								})
							]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t$1("ui.ingest.title") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: t$1("ui.ingest.desc")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								marginTop: 10,
								display: "flex",
								gap: 8,
								flexWrap: "wrap"
							},
							children: [
								[
									"manual",
									t$1("ui.ingest.manualLabel"),
									t$1("ui.ingest.manualDesc")
								],
								[
									"balanced",
									t$1("ui.ingest.balancedLabel"),
									t$1("ui.ingest.balancedDesc")
								],
								[
									"autonomous",
									t$1("ui.ingest.autonomousLabel"),
									t$1("ui.ingest.autonomousDesc")
								]
							].map(([mode, label, desc]) => {
								const active = (cfg?.approvalMode ?? "balanced") === mode;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									style: {
										...active ? btnPrimary : btn,
										marginRight: 0,
										flex: "1 1 200px",
										textAlign: "left",
										padding: 10,
										opacity: saving ? .6 : 1
									},
									disabled: saving || !cfg,
									onClick: () => void setConfig({ approvalMode: mode }),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontWeight: 600,
											marginBottom: 4
										},
										children: [active ? "● " : "○ ", label]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											opacity: .85,
											fontWeight: 400
										},
										children: desc
									})]
								}, mode);
							})
						}),
						cfg?.approvalMode === "autonomous" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...dim,
								marginTop: 8,
								color: "var(--dsh-warn, #b45309)"
							},
							children: [
								"⚠️ 自治档下后台评审会自动写入更多记忆。每轮最多自动确认 ",
								cfg?.reviewMaxAutoPerTurn ?? 5,
								" 条，待确认队列上限 ",
								cfg?.maxPendingQueue ?? 50,
								" 条——超出的会被拒收以防无界增长。冲突和重要记忆仍需你确认。"
							]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Skill 写入审批" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "默认跟随摄入档：手动/平衡档先生成提案，只有自主档可直写。要恢复旧式直写可显式选“自主”。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							value: cfg?.skillProposalMode ?? "inherit",
							disabled: saving || !cfg,
							onChange: (e) => void setConfig({ skillProposalMode: e.target.value }),
							style: {
								marginTop: 8,
								padding: 6
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: "inherit",
									children: [
										"跟随摄入档（当前：",
										cfg?.approvalMode ?? "balanced",
										"）"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "manual",
									children: "手动：全部提案"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "balanced",
									children: "平衡：全部提案"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "autonomous",
									children: "自主：过安全闸后直写"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: 8,
								fontSize: 12
							},
							children: [
								"人工正文上限 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 1e3,
									max: 5e5,
									value: cfg?.skillMaxChars ?? 4e4,
									disabled: saving,
									onChange: (e) => void setConfig({ skillMaxChars: Number(e.target.value) }),
									style: { width: 90 }
								}),
								" 字； 自动路径上限 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 1e3,
									max: 2e5,
									value: cfg?.skillAutoMaxChars ?? 1e4,
									disabled: saving,
									onChange: (e) => void setConfig({ skillAutoMaxChars: Number(e.target.value) }),
									style: { width: 90 }
								}),
								" 字。"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "block",
								marginTop: 10
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: cfg?.approvalPromptEnabled ?? false,
								disabled: saving,
								onChange: (e) => void setConfig({ approvalPromptEnabled: e.target.checked })
							}), " 对话内直接记忆为高价值 pending 时弹一次确认"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: dim,
							children: [
								"仅覆盖开放对话中 memory_remember；后台 review 在 turn 结束后无法弹窗，仍到面板审核。每轮最多 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 0,
									max: 10,
									value: cfg?.approvalPromptMaxPerTurn ?? 1,
									disabled: saving,
									onChange: (e) => void setConfig({ approvalPromptMaxPerTurn: Number(e.target.value) }),
									style: { width: 48 }
								}),
								" 次。"
							]
						})
					]
				}),
				frozenOps.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...box,
						borderColor: "#b45309"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", { children: [
							"⚠️ 卡住的操作（",
							frozenOps.length,
							"）"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "这些操作没做完就中断了，需要你决定怎么处理。系统不会自己猜——它宁可停下来等人。 「前滚」= 认可已经生效的部分并把记账补完；「回滚」= 只在确认从未生效时才可用。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							style: {
								width: "100%",
								marginTop: 8,
								...mono
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: frozenOps.map((op) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: { verticalAlign: "top" },
									children: op.kind
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: { verticalAlign: "top" },
									children: op.targetName ?? "—"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
									style: { verticalAlign: "top" },
									children: [op.phase, op.conflict?.message ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											...dim,
											marginTop: 2
										},
										children: op.conflict.message
									}) : null]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: {
										textAlign: "right",
										whiteSpace: "nowrap",
										verticalAlign: "top"
									},
									children: op.resolution?.status === "RESOLVED" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: dim,
										children: [
											"已处理（",
											op.resolution.decision,
											"）"
										]
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void resolveOp(op, "ROLL_FORWARD"),
											children: "前滚"
										}),
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void resolveOp(op, "ROLL_BACK"),
											children: "回滚"
										})
									] })
								})
							] }, op.opId)) })
						})
					]
				}) : null,
				s?.proposals && s.proposals.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", { children: [
							"Skill 提案审阅（",
							s.proposals.length,
							"）"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "模型只能生成提案，不能自行应用。目标被人改过时会转 stale，不覆盖新内容。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							style: {
								width: "100%",
								marginTop: 8,
								...mono
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: s.proposals.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: p.action }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: p.targetSkill }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: p.state }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: {
										textAlign: "right",
										whiteSpace: "nowrap"
									},
									children: p.state === "pending" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void proposalAction(p.id, "apply"),
											children: "应用"
										}),
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void proposalAction(p.id, "reject"),
											children: "拒绝"
										})
									] }) : null
								})
							] }, p.id)) })
						})
					]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "待确认记忆（审批门）" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "模型写入的记忆默认 pending，不会自动注入；人工确认后才「始终生效」。"
						}),
						s && s.memoryStats.pendingQueue.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							style: {
								width: "100%",
								marginTop: 8,
								...mono
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: s.memoryStats.pendingQueue.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
								style: { verticalAlign: "top" },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										style: {
											opacity: .6,
											whiteSpace: "nowrap"
										},
										children: [
											"[",
											r.kind,
											"/imp",
											r.importance,
											"]"
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										style: { paddingLeft: 8 },
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: r.content }), r.sourceContext ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												...dim,
												fontSize: 11,
												marginTop: 2,
												borderLeft: "2px solid var(--dsh-border, #444)",
												paddingLeft: 6
											},
											children: ["来源：", r.sourceContext]
										}) : null]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: {
											whiteSpace: "nowrap",
											textAlign: "right"
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void rejectOne(r.id),
											title: "丢弃这条（可恢复，不会物理删除）",
											children: "丢弃"
										})
									})
								]
							}, r.id)) })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							style: {
								...btnPrimary,
								marginTop: 10
							},
							disabled: saving,
							onClick: () => void confirmBatch(),
							children: [
								"批量确认全部（",
								s.memoryStats.pendingQueue.length,
								"）"
							]
						})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...dim,
								marginTop: 8
							},
							children: "（无待确认记忆）"
						})
					]
				}),
				s?.rejectedQueue && s.rejectedQueue.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", { children: [
							"已拒绝（",
							s.rejectedQueue.length,
							"）"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "丢弃的记忆不再注入、不占待确认额度、批量确认也不会收回；但不会被物理删除，随时可恢复。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							style: {
								width: "100%",
								marginTop: 8,
								...mono
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: s.rejectedQueue.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
								style: { verticalAlign: "top" },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										style: {
											opacity: .6,
											whiteSpace: "nowrap"
										},
										children: [
											"[",
											r.kind,
											"/imp",
											r.importance,
											"]"
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: { paddingLeft: 8 },
										children: r.content
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: {
											whiteSpace: "nowrap",
											textAlign: "right"
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void restoreOne(r.id),
											title: "放回待确认队列",
											children: "恢复"
										})
									})
								]
							}, r.id)) })
						})
					]
				}) : null,
				s?.unclaimedSkills && s.unclaimedSkills.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", { children: [
							"待认领 skill（",
							s.unclaimedSkills.length,
							"）"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "这些 skill 看起来是本插件早期生成的，但没有绑定本机身份。为避免把你手写的文件 误当成插件资产，插件不会自动认领：认领后才会进入自动改写路径，未认领时手动工具照常可用。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							style: {
								width: "100%",
								marginTop: 8,
								...mono
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: s.unclaimedSkills.map((k) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
								style: { verticalAlign: "top" },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: { whiteSpace: "nowrap" },
										children: k.name
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										style: {
											paddingLeft: 8,
											opacity: .6
										},
										children: [k.tag ? `tag: ${k.tag}` : "", k.version ? ` · v${k.version}` : ""]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										style: {
											whiteSpace: "nowrap",
											textAlign: "right"
										},
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void claimSkills([k.name]),
											title: "确认这是插件生成的 skill",
											children: "认领"
										})
									})
								]
							}, k.name)) })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							style: {
								...btn,
								marginTop: 10
							},
							disabled: saving,
							onClick: () => void claimSkills((s.unclaimedSkills ?? []).map((k) => k.name)),
							children: [
								"全部认领（",
								s.unclaimedSkills.length,
								"）"
							]
						})
					]
				}) : null,
				s?.retrieval ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "记忆检索状态" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...mono,
								marginTop: 8
							},
							children: s.retrieval.mode === "fused" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "#16a34a" },
								children: "● 融合检索（bigram + 全文索引）— 召回最佳"
							}) : s.retrieval.mode === "bigram-only" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "var(--dsh-warn, #b45309)" },
								children: "▲ 仅 bigram 检索 — 全文索引不可用，中文长句/转述查询召回会变差"
							}) : s.retrieval.mode === "fts-degraded" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { color: "#dc2626" },
								children: [
									"▲ 全文索引运行时降级 — 召回质量已下降（错误 ",
									s.retrieval.ftsErrorCount ?? 0,
									" 次）"
								]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: dim,
								children: "状态未知（尚无检索发生）"
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...dim,
								fontSize: 12,
								marginTop: 4
							},
							children: [
								"全文索引：",
								s.retrieval.ftsEnabled ? "已启用" : "已关闭",
								" · ",
								s.retrieval.ftsAvailable ? "可用" : "不可用",
								typeof s.retrieval.fusedCount === "number" ? ` · 融合 ${s.retrieval.fusedCount} 次 / 降级 ${s.retrieval.bigramOnlyCount ?? 0} 次` : ""
							]
						})
					]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "记忆处置自治程度" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "决定系统如何处理冷记忆。手动/建议档不改数据；整理档只会自动「软删」符合严格规则的低价值记忆，可在下方已忘记区恢复。任何档位都不会自动物理删除，技能合并/归档也仍为手动。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								marginTop: 10,
								display: "flex",
								gap: 8,
								flexWrap: "wrap"
							},
							children: [
								[
									"manual",
									"手动",
									"系统不主动提议。你自己在下方受控剪枝里筛选处理。"
								],
								[
									"suggest",
									"建议",
									"空闲时自动重算「从未注入、从未召回、且过了冷静期」的低价值记忆，列给你看；仍然只提议、不自动删。"
								],
								[
									"tidy",
									"整理",
									"空闲时自动软删同一批建议候选；每轮最多处理设定数量，可恢复，绝不物理删除；最高重要度、偏好、决策、待审、已拒绝和锁定项永不自动处理。"
								]
							].map(([mode, label, desc]) => {
								const active = (cfg?.disposalMode ?? "manual") === mode;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									style: {
										...active ? btnPrimary : btn,
										marginRight: 0,
										flex: "1 1 220px",
										textAlign: "left",
										padding: 10,
										opacity: saving ? .6 : 1
									},
									disabled: saving || !cfg,
									onClick: () => void setConfig({ disposalMode: mode }),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontWeight: 600,
											marginBottom: 4
										},
										children: [active ? "● " : "○ ", label]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											opacity: .85,
											fontWeight: 400
										},
										children: desc
									})]
								}, mode);
							})
						}),
						cfg?.disposalMode === "suggest" || cfg?.disposalMode === "tidy" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "block",
								marginTop: 10
							},
							children: [
								"空闲触发时间：",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 1,
									max: 1440,
									style: {
										width: 80,
										marginLeft: 8,
										padding: "4px 6px",
										borderRadius: 4,
										border: "1px solid var(--dsh-border, #444)"
									},
									value: cfg.idleMinutes ?? 5,
									disabled: saving,
									onChange: (e) => void setConfig({ idleMinutes: Number(e.target.value) })
								}),
								" 分钟"
							]
						}) : null,
						cfg?.disposalMode === "tidy" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "block",
								marginTop: 10
							},
							children: [
								"每轮最多自动软删：",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 1,
									max: 100,
									style: {
										width: 80,
										marginLeft: 8,
										padding: "4px 6px",
										borderRadius: 4,
										border: "1px solid var(--dsh-border, #444)"
									},
									value: cfg.tidyMaxPerRun ?? 5,
									disabled: saving,
									onChange: (e) => void setConfig({ tidyMaxPerRun: Number(e.target.value) })
								}),
								" 条"
							]
						}) : null,
						(cfg?.disposalMode === "suggest" || cfg?.disposalMode === "tidy") && s?.disposalSuggest ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 10 },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: dim,
									children: [
										"冷静期：",
										cfg?.disposalMinIdleDays ?? 30,
										" 天。空闲时自动重算，",
										s.disposalSuggest.computedAt ? `上次算于 ${new Date(s.disposalSuggest.computedAt).toLocaleString()}` : "（还未触发，需空闲一段时间）"
									]
								}),
								s.disposalSuggest.candidates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
									style: {
										width: "100%",
										marginTop: 6,
										...mono
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: s.disposalSuggest.candidates.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: { verticalAlign: "top" },
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											style: {
												opacity: .6,
												whiteSpace: "nowrap"
											},
											children: [
												"[",
												c.kind,
												"/imp",
												c.importance,
												"]"
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											style: { paddingLeft: 8 },
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: c.content }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: {
													...dim,
													fontSize: 11
												},
												children: [
													"冷置 ",
													c.ageDays,
													" 天 · ",
													c.reason
												]
											})]
										})]
									}, c.id)) })
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										...dim,
										marginTop: 6
									},
									children: "（暂无低价值候选——库还小或都在用）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										...dim,
										fontSize: 12,
										marginTop: 6
									},
									children: "要真正清理，请到下方「受控剪枝」勾选执行（两阶段预览→确认，全部可逆）。"
								})
							]
						}) : null
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "受控剪枝" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "检测自动、处置显式。冷/低价值记忆与冗余技能在这里由你勾选处理，全部可逆（软删/归档，随时恢复）。"
						}),
						prune?.budget?.enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...mono,
								marginTop: 8,
								color: prune.budget.overBudget ? "#dc2626" : void 0
							},
							children: [
								"字符预算：已用 ",
								prune.budget.used,
								" / 上限 ",
								prune.budget.max,
								prune.budget.overBudget ? "（超限）" : ""
							]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { marginTop: 10 },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
								style: { fontSize: 13 },
								children: "待清理记忆"
							})
						}),
						prune && prune.memoryCandidates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							style: {
								width: "100%",
								marginTop: 6,
								...mono
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: prune.memoryCandidates.map((c) => {
								const canForget = c.allowedActions.includes("memory-forget");
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: {
										width: 24,
										verticalAlign: "top"
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: !!selMem[c.id],
										disabled: !canForget || saving,
										onChange: () => toggleMem(c.id)
									})
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: c.content }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										...dim,
										fontSize: 11
									},
									children: [
										c.pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { color: "#f59e0b" },
											children: "PINNED "
										}) : null,
										c.kind ? `[${c.kind}/imp${c.importance}] ` : "",
										typeof c.heat === "number" ? `久未主动访问 · heat ${c.heat}` : "",
										typeof c.injectionCount === "number" ? ` · 自动注入 ${c.injectionCount} 次` : ""
									]
								})] })] }, c.id);
							}) })
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...dim,
								marginTop: 6
							},
							children: "（无待清理候选）"
						}),
						prune && prune.memoryCandidates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { marginTop: 10 },
							children: !preview ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: btn,
								disabled: saving,
								onClick: () => void doPreview(),
								children: "预览将处理的记忆"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									border: "1px dashed var(--dsh-border,#555)",
									borderRadius: 6,
									padding: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											marginBottom: 6,
											fontWeight: 600
										},
										children: "预览（软删，全部可恢复）："
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
										style: {
											width: "100%",
											...mono,
											borderCollapse: "collapse"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											style: {
												...dim,
												textAlign: "left",
												borderBottom: "1px solid var(--dsh-border,#444)"
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "2px 6px" },
													children: "动作"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "2px 6px" },
													children: "数量"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "2px 6px" },
													children: "结果"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "2px 6px" },
													children: "说明"
												})
											]
										}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: preview.preview.map((p, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											style: { borderBottom: "1px solid var(--dsh-border,#2a2a2a)" },
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: { padding: "2px 6px" },
													children: p.action
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														padding: "2px 6px",
														textAlign: "right"
													},
													children: p.count
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														padding: "2px 6px",
														color: p.allowed ? "#16a34a" : "#b45309"
													},
													children: p.allowed ? "将执行" : "跳过"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
													style: {
														padding: "2px 6px",
														...dim
													},
													children: [p.allowed ? "" : p.reason, p.requires ? `（需 ${p.requires}）` : ""]
												})
											]
										}, i)) })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: { marginTop: 8 },
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnPrimary,
											disabled: saving,
											onClick: () => void doExecute(),
											children: "确认执行"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btn,
											disabled: saving,
											onClick: () => setPreview(null),
											children: "取消"
										})]
									})
								]
							})
						}) : null,
						prune && prune.protectedReview.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 12 },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
									style: { fontSize: 13 },
									children: "保护记录（需专项审阅）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: dim,
									children: "偏好 / 决策类记忆本版本不支持直接处置（避免误删长期偏好）。仅供审阅。"
								}),
								prune.protectedReview.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										...mono,
										paddingLeft: 12,
										opacity: .8
									},
									children: [
										"· [",
										r.kind,
										"] ",
										r.content
									]
								}, r.id))
							]
						}) : null,
						prune && prune.skillCandidates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 12 },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
									style: { fontSize: 13 },
									children: "待收敛技能"
								}),
								prune.skillCandidates.map((sc, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										...mono,
										paddingLeft: 12,
										opacity: .85
									},
									children: [
										"· ",
										sc.names.join(" ↔ "),
										"｜相似度 ",
										sc.similarity,
										typeof sc.zeroLoadCount === "number" ? `｜零加载 ${sc.zeroLoadCount}` : ""
									]
								}, i)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										...dim,
										fontSize: 11,
										marginTop: 4
									},
									children: "技能合并/归档请用对话侧 converge_skill / archive_skill（面板暂只做记忆清理）。"
								})
							]
						}) : null,
						prune && prune.forgotten.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 12 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
								style: { fontSize: 13 },
								children: "已忘记（可恢复）"
							}), prune.forgotten.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									...mono,
									paddingLeft: 12
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { opacity: .7 },
									children: [
										"· [",
										r.kind,
										"] ",
										r.content
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: {
										...btn,
										marginLeft: 8,
										padding: "2px 8px"
									},
									disabled: saving,
									onClick: () => void doRestore(r.id),
									children: "恢复"
								})]
							}, r.id))]
						}) : null
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "记忆 / skill 概览" }), s ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: 8,
							...mono
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								"记忆：共 ",
								s.memoryStats.total,
								"（已确认 ",
								s.memoryStats.confirmed,
								" / 待确认 ",
								s.memoryStats.pending,
								"），上限 ",
								s.memoryStats.maxRecords
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 4 },
								children: ["按类型：", Object.entries(s.memoryStats.byKind).map(([k, v]) => `${k}:${v}`).join("  ") || "—"]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { marginTop: 4 },
								children: "最常被注入（真正影响决策）："
							}),
							s.memoryStats.topByInjection.length > 0 ? s.memoryStats.topByInjection.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									paddingLeft: 12,
									opacity: .85
								},
								children: [
									"· (",
									r.injectionCount,
									"×) ",
									r.content
								]
							}, r.id)) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									paddingLeft: 12,
									opacity: .6
								},
								children: "—"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 8 },
								children: [
									"skill：active ",
									s.skillStats.counts.active,
									" / stale ",
									s.skillStats.counts.stale,
									" / archived ",
									s.skillStats.counts.archived
								]
							}),
							triageOn ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 4 },
								children: [
									"结果三元组：",
									triage.totalTurns,
									" 轮记录，成功 ",
									triage.successes,
									" / 失败 ",
									triage.failures
								]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: 4,
									opacity: .6
								},
								children: "结果三元组：未启用"
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...dim,
							marginTop: 8
						},
						children: "加载中…"
					})]
				}),
				note ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: box,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: mono,
						children: note
					})
				}) : null,
				archives.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", { children: [
							"已归档的 skill（",
							archives.length,
							"）"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "归档只是移出活动目录，文件都还在，可以随时恢复。同一个 skill 可以有多份归档， 按归档编号区分——恢复时挑你要的那一份，不会互相覆盖。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("table", {
							style: {
								width: "100%",
								marginTop: 8,
								...mono
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: archives.map((a) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: a.logicalSkillName }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: dim,
									children: a.archiveId
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
									style: {
										textAlign: "right",
										whiteSpace: "nowrap"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void restoreArchive(a),
											children: "恢复"
										}),
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											style: btnTiny,
											disabled: saving,
											onClick: () => void proposeRollback(a.logicalSkillName),
											children: "提议回滚"
										})
									]
								})
							] }, a.archiveId)) })
						})
					]
				}) : null
			] });
		}
		//#endregion
		//#region src/client/index.ts
		/** Required client services. */
		const inject = ["slots"];
		/**
		* Client plugin body: register the settings section. The section component owns
		* its own polling + action calls to /api/evolve/*.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => {
				const unregister = ctx.slots.register({
					name: "settings.section",
					id: "dsh-evolve",
					order: 150,
					label: () => "dsh-evolve"
				}, EvolveSettingsSection);
				return () => unregister();
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
