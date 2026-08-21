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
		const btnPrimary = {
			padding: "6px 12px",
			borderRadius: 6,
			border: "1px solid var(--dsh-border, #444)",
			cursor: "pointer",
			marginRight: 8,
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
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: s.memoryStats.pendingQueue.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
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
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								style: { paddingLeft: 8 },
								children: r.content
							})] }, r.id)) })
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
