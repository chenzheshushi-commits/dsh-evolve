window.__ModuleLoader__.load({
	id: "dsh-evolve",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		function EvolveSettingsSection(_props) {
			const [state, setState] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)("");
			const [saving, setSaving] = (0, react.useState)(false);
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
					setNote(`✅ 已批量确认 ${r.confirmed} 条 pending 记忆`);
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refresh]);
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
					setNote("未选择可处理的记忆");
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
			}, [prune, selMem]);
			const doExecute = (0, react.useCallback)(async () => {
				if (!preview?.planDigest) return;
				setSaving(true);
				setNote("");
				try {
					const r = await apiPost(`${API}/prune/execute`, { planDigest: preview.planDigest });
					if (r.status === "plan-expired") setNote("计划已过期，请重新预览");
					else setNote(`✅ 处理完成：软删 ${r.applied?.length ?? 0} 条${(r.skipped?.length ?? 0) > 0 ? `，跳过 ${r.skipped.length} 条（${r.skipped.map((s) => `${s.target}:${s.reason}`).join("; ")}）` : ""}`);
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
				refresh
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
					setNote("✅ 已恢复");
					await refreshPrune();
					await refresh();
				} catch (e) {
					setNote(String(e));
				} finally {
					setSaving(false);
				}
			}, [refreshPrune, refresh]);
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
					children: "自进化记忆 + skill 生命周期。所有设置即时保存到插件配置；数据每 8 秒刷新。"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "LLM 精炼 skill 内容" }),
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
									"启用 LLM 精炼"
								]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...dim,
								marginTop: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "打开" }), "：结晶 / 精炼 skill 时，调用一次下方所选模型，把零散记忆提炼成结构化 SKILL.md（去重、分节、写成步骤/坑）。单次调用、仅在结晶/精炼时触发（一次会话可能 0 次），复用 provider 缓存。"] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 4 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "关闭" }),
									"：改用确定性拼接（原样把记忆条目列进 SKILL.md），",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "零 token" }),
									"、不调用任何模型。功能完全可用，只是内容不经提炼。"
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 10 },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: dim,
									children: "精炼使用的模型："
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
										children: "（跟随 DSH 当前主模型 — 默认）"
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
									children: "不选 = 跟随主模型（主模型换了它自动跟随）。选了则固定用该模型精炼。"
								})
							]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: box,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "记忆摄入自治程度" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: dim,
							children: "决定「模型/后台评审想记的东西」有多少能自动生效，多少要你先过目。切档只影响之后的新记忆，不会批量放行已有的待确认项。"
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
									"全部先进待确认，你逐条确认后才生效。最保守。"
								],
								[
									"balanced",
									"平衡（默认）",
									"拿得准的（锚定你原话、或与已确认高度重复）自动生效；拿不准的进待确认。"
								],
								[
									"autonomous",
									"自治",
									"凡是可逆、不冲突的都自动生效；重要(imp3)/冲突项仍强制进待确认。写入量另有上限保护。"
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
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
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
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
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
								})]
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
							children: "决定「系统要不要主动提议清理冷记忆」。注意：处置永远只到「提议」——任何档位都不会自动删除，删不删由你在下方受控剪枝里勾选。（技能的合并/归档永远手动，不进自动提议。）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								marginTop: 10,
								display: "flex",
								gap: 8,
								flexWrap: "wrap"
							},
							children: [[
								"manual",
								"手动",
								"系统不主动提议。你自己在下方受控剪枝里筛选处理。"
							], [
								"suggest",
								"建议",
								"空闲时自动重算「从未注入、从未召回、且过了冷静期」的低价值记忆，列给你看；仍然只提议、不自动删。"
							]].map(([mode, label, desc]) => {
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
						cfg?.disposalMode === "suggest" && s?.disposalSuggest ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
