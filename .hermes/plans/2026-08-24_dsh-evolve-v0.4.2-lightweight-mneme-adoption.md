# dsh-evolve v0.4.2 实现方案 rev9 —— 受控剪枝人工界面 + 轻量吸收 dsh-mneme

**修订日期:** 2026-08-24（rev9，取代同日 rev1 / rev2 / rev3 / rev4 / rev5 / rev6 / rev7 / rev8）
**Goal:** 在不新增运行时依赖、不动存储架构的前提下，补上「受控剪枝没有人工操作界面」这个真实断层，
并轻量吸收 dsh-mneme 的纯逻辑机制（heat 冷度 / 决策留痕 / 空闲触发）。

**Architecture:** 全部嫁接到已有模块强化，不新建支柱。后端：真软删 + 三层保护 + heat 只读冷度 +
剪枝授权裁决器 + JSONL 审计。前端：A2 同页（审批门在上、剪枝候选在下，两类对象分组 + preview→execute）。

---

## rev1 → rev2 变更摘要（全部经源码核实，非措辞调整）

| # | rev1 的错误 | rev2 修正 |
|---|---|---|
| 1 | 写「forget 可逆软删」，实际 `store.js` L325-334 是 `table.delete()` 物理删除，无软删无恢复 | 实现**真软删**（`forgottenAt` 墓碑 + 恢复入口）；排除池补上**结晶证据池** |
| 2 | 依赖不存在的 `pinned`；且把「λ=0 永不变冷」误当「禁止剪枝」 | 落地**三层保护模型**；`pinned` 本轮真加。推翻 rev1「kind 永久免疫」——那本身是另一种膨胀 |
| 3 | 「heat 追加第三键」——实测现有排序已是三键，heat 会落在 `updatedAt` 后成**哑功能** | heat 插在**时间戳之前**；并明确 heat = 时间冷度 ≠ 使用价值 |
| 4 | 对 skill 调同一个 `heatOf(record)`——skill 数据无 kind/accessedAt/createdAt | 拆 `memoryHeat` / `skillHeat` 两函数，后者走 `.evolve-usage.json` |
| 5 | 保留 `FIELD_ALIASES`/`ACTION_SYNONYMS` 字段漂移归一化 | **本轮无生产者**（converge/fold 都是强类型调用）→ 删除，推迟到接 autoDream 时 |
| 6 | 剪枝复用 `adjudicate()` 判可逆性 | 语义错配 → 独立 `authorizePruneAction()`。写入审批与剪枝授权是两个裁决器 |
| 7 | `{action, ids[]}` 会混用 memory ID 与 skill name | 强类型 discriminated union（`memoryIds[]` / `skillNames[]`）+ 候选带 `allowedActions` |

### rev2 → rev3 变更摘要（第二轮外部复核，全部经源码核实）

| # | rev2 的遗漏 | rev3 修正 |
|---|---|---|
| 8 | **未改 `_evict()`** —— 它按 `table.size`(物理行数) 判超限并物理删除，软删记录仍计数 → 软删一批会导致**活记录被自动物理删**；且 `importance===3` 只排后面不免删；完全不看 pinned/forgottenAt | **停用自动物理删除**（改为只 warn 报告），容量治理统一交给字符预算 + 面板显式处置。rev2 最大遗漏 |
| 9 | preview→execute 未闭合：没说 `planDigest` 对应的完整 plan 存哪；且靠 fail-open 的 audit 做幂等自相矛盾 | **内存 plan/receipt registry**（TTL 15min / 上限 100 / consumed 标记 / 重启后 `plan-expired`）负责闭环与幂等；JSONL audit 只管留痕 |
| 10 | `sourceRevision` 用全局「记录数+最大 updatedAt」，反映不了 injectionCount lazy flush / skill sidecar / 他会话改动 | 改**逐目标 etag**，单目标 stale 只跳过该目标并回原因，不整单失败 |
| 11 | protected kind 进候选但本轮无处置出口 → 「看得见处理不了」 | protected kind **不进普通候选**，单独「保护记录（需专项审阅）」区 + 明确文案。`memory-supersede` 留下一版 |
| 12 | 软删的两个边界未定义：constructor 的 `fts.backfill(this.all())` 重启后把 forgotten 塞回索引；`_renderMirror()` 让软删记录无标记混入 MEMORY.md | backfill 过滤 forgotten；镜像主列表排除 + 另起 `## Forgotten (recoverable)` 区 |

### rev3 → rev4 变更摘要（第三轮外部复核，全部经源码核实）

| # | rev3 的遗漏 | rev4 修正 |
|---|---|---|
| 13 | ⭐**记忆黑洞（本轮最隐蔽、最重要）**：`remember()` 的近重复强化循环只判 `scope/kind`，**不判 `forgottenAt`** —— 软删过 X 后用户再说类似 X，会命中墓碑被"强化"（observationCount+1、可能升 importance、刷 updatedAt），但记录仍带墓碑永不出现在任何读路径 → **新表述被墓碑静默吞掉、不产生新记录、用户在任何界面都看不到**。比"复活"更糟：话题被永久静默封禁 | 强化循环**跳过墓碑**（`if (rec.forgottenAt) continue`）；语义定为 **(a)** 墓碑保留历史、近重复新表述**独立成新记录**（"忘记"是对那一条的处置，不是对话题的永久封禁） |
| 14 | `stats()` 的 `total`/`byKind`/`byScope` 未明确排除墓碑（rev3 只改了镜像，漏了统计口径） | `total`/`byKind`/`byScope` 只统计非墓碑，`forgotten` 单独计数 |

> **通用教训（rev4 记下）**：加软删时我只想到"读路径排除墓碑"（confirmed/recall/tier1/结晶/evidence 五处），
> 漏了**写路径的近重复合并**也会 touch 到墓碑。排除池不是"五处读"，而是**所有会读到或写到记录的地方**。
> 这是"新机制被旧机制绕过"的第三个实例（前两个：`_evict()` 物理删除、本条 `remember()` 强化合并）。

### rev4 → rev5 变更摘要（第四轮外部复核，源码核实）

| # | rev4 的错误 | rev5 修正 |
|---|---|---|
| 15 | **路径事实错误**：Task 7 + Files 清单写 `src/web-routes.js`，但该文件**不存在**——host 侧路由是手写 plain ESM，真源在 `lib/web-routes.js`（文件头自称 "Plain ESM (no build)"），`tsdown` entry 只有 `src/client/index.ts`，`src/` 下只有 client 的 .ts/.tsx。照 `src/` 找会扑空 | 全部改为 `lib/web-routes.js` 并标注"不经构建" |

### rev5 → rev6 变更摘要（第五轮外部复核，源码核实）

| # | rev5 的缺陷 | rev6 修正 |
|---|---|---|
| 16 | ⭐**第 7 处墓碑泄漏 + 方法论缺陷**：`assessWrite()`（g4 写前质量门，背景评审用）传 `this.all()`（含墓碑，L477）而非 `confirmed()`，内部只判 scope/kind → 软删过 X 后评审想记类似 X 会被判 `near-duplicate` 挡在门外（第二个"记忆黑洞"，入口从 remember 换成 assessWrite）。**根因是"逐处记六处清单"的方法本身会漏**——实测 budgetStatus/promotionCandidates 走 confirmed() 但 assessWrite 走 all()，"活跃记录"概念不统一 | **消灭清单，收敛到单一闸门**：`confirmed()` 加墓碑过滤成为唯一"活跃记录"闸门；assessWrite/budgetStatus/promotionCandidates/profileView/adjudicate 全部走它 → 新消费者自动免疫，不再逐处记清单 |

> **方法论修正（rev6，比 bug 本身更重要）**：rev4 立了"排除池是所有读写记录的地方"的元教训，却仍用"逐处列举"落地——这自相矛盾，必然漏（第 7 处就从缝里漏出）。
> 正解不是把清单从 6 改到 7，是**把过滤下沉到 `confirmed()` 单点**，让"活跃记录"只有一个定义。防御性列举 → 收敛到单一真源，才是根治。

### rev6 → rev7 变更摘要（第六轮外部复核，源码核实）

| # | rev6 的缺陷 | rev7 修正 |
|---|---|---|
| 17 | ⭐**pinned 记录被强化循环静默改写（六轮首个 pinned 相关新 bug）**：`remember()` 强化循环（L184-186）只判 scope/kind、**不判 pinned** → 用户 pin 的"别动这条"记忆，被一条近重复写入把 content/importance/observationCount/updatedAt 全刷掉，pin 形同虚设。与 Task 3"pinned 任何动作 reject"矛盾——我只在剪枝授权里 reject 了，漏了"写路径强化"这个动作。它和 forgottenAt 是**同一循环的对称守卫**，rev6 只加了一个 | 强化循环守卫从"跳墓碑"扩为"跳墓碑 + 跳 pinned"：`if (rec.forgottenAt) continue; if (rec.pinned) continue;`。命中 pinned 时同软删语义 (a) **新建记录**，不改写被锁定的那条 |
| 18 | 两处措辞：①`crystallizationEvidence`/`evidenceByTag` rev6 写"改为基于 confirmed() 派生"，实测**本来就走 confirmed()**（L509/L537），是把"已对的"写成"需改"；②Task 2b 没说 L230 的 `await this._evict()` 调用点保不保留 | ①改为"已走 confirmed() ✓，下沉后自动免疫，无需改"（与 budgetStatus 表述一致）；②Task 2b 明确"保留 L230 调用点，函数体改只报告" |

### rev7 → rev8 变更摘要（第七轮外部复核，源码核实）

| # | rev7 的缺陷 | rev8 修正 |
|---|---|---|
| 19 | ⭐**pinned 保护只挡面板，对话侧 `memory_forget` 可直接物理删 pinned（pinned 保护的第三个面）**：`memory_forget` 工具（index.js L393）直接 `store.forget(args.id, args.confirm)`，**不经 `authorizePruneAction`**；而 `store.forget`（L325-334）只检查 `importance===3`、**不看 pinned** → 用户 pin 的 importance<3 记忆被对话侧一删就没，pin 形同虚设。这是 pinned 保护继面板✅/强化✅之后**漏掉的第三条路**，且根因同 rev6 单闸门：**保护分散在上层入口逐个实现，没下沉到 store 数据层这个公共底座** | 把 pinned + 墓碑保护**下沉到 `store.forget`/`softForget` 数据层单点兜底**：`forget` 对 pinned 记录需 `confirm===true` 才删（返回 `skippedPinned`）。对话侧/面板/未来任何入口全部自动免疫 |

> **方法论强化（rev8）**：这是"防御性列举"反模式的**第三次复现**（前两次：墓碑读路径、pinned 强化循环）。rev6 提炼了"下沉到单点"的教训，但只用在了**读过滤**（confirmed()），没推广到**写保护**。
> 通用结论：**保护/过滤逻辑一律沉到数据层最窄的必经之路**（读→`confirmed()`，删→`store.forget/softForget`），上层入口只做策略差异（如面板 reject vs 对话侧要 confirm），不重复实现兜底。

### rev8 → rev9 变更摘要（第八轮外部复核，文档一致性）

| # | rev8 的不一致 | rev9 修正 |
|---|---|---|
| 20 | **承诺与细节不一致**：#19 的 changelog + 方法论注声称下沉覆盖"`store.forget`/`softForget`"，但正文只给 `forget()` 写了 pinned 守卫代码，`softForget` 规范（Task 2a）仍只写"设 forgottenAt"、没有 pinned 检查，只含糊说"遵循同一兜底"。与 rev5（src/web-routes）、rev6（crystallizationEvidence 措辞）**同型**：changelog 说改两个方法，正文只兑现一个 | 在 `softForget` 规范里**显式写出** pinned 守卫代码（`confirmSoft !== true → skippedPinned`）+ 加断言⑮。影响本就极小（软删可恢复、面板不给 pinned 软删入口），但不留"说了没做"的裂缝 |

> **自我提醒（rev9）**：连续三轮（rev5/6/8→本条）被抓"changelog 承诺 vs 正文细节不一致"。教训：**改 changelog 里列的每一个符号/方法/路径，落笔后回正文逐一核对它们都有对应的具体改动**，别让摘要跑在正文前面。

> **自我提醒（rev5）**：这条戳破了本文档"全部经源码核实"的自称——恰恰是没核实的那一处（想当然"client 在 src/，路由大概也在 src/"）出的错。
> 教训：**凡在文档里写具体文件路径，落笔前必须 `ls` 一次**，尤其是"由已知路径类推的"路径最危险。host 路由（plain ESM）与 client（tsdown 构建）分属 `lib/` 与 `src/`，二者不同源。

**明确不做（本轮排除）:** 本地向量 embedding、cross-encoder reranker、向量聚类、知识图谱、
`@huggingface/transformers`、LLM 字段漂移归一化、第 23 个工具、`memory-supersede`/`supersededBy`（留下一版）。
语义召回本轮放弃（不用 LLM embedding 凑，不做同义词词典）。

---

## Current context / 已核实现状（读源码得出）

- **工具 22 个**，本轮**保持 22 不新增**。
- **UI 断层（已确认）**：`src/client/EvolveSettingsSection.tsx` 只有「待确认记忆（审批门）」+ 批量确认 +
  只读统计。**无任何剪枝候选区、无勾选处置入口** → 受控剪枝的"人工"目前只能靠对话让 agent 调工具。
- **`store.js` L325-334 `forget()` 是物理删除**：`await this.table.delete(id)`，仅 `importance===3` 需
  `confirmDelete`。全库 grep `forgottenAt|tombstone|softDelete|pinned|isPinned` **零命中**。
- **`budgetStatus()` 现有排序键（实测原文）**：
  `(a.importance-b.importance) || (observationCount) || String(a.updatedAt).localeCompare(...)` —— 三键。
- **`readEvolveSkills()` 返回**：`{name, tag, body, refinementCount}` —— **无 kind/accessedAt/createdAt**。
  skill 活动数据在 `.evolve-usage.json`：`{createdAt, lastActivityAt, events:[{at,event}]}`（`skills.js` L243-260）。
- **`findMergeCandidates()` 已有 zeroLoad 信号**：`zeroLoadCount` + 排序 `zeroLoad desc → similarity desc`。
- **`adjudicate(candidate, confirmedRecords, config)`** 输入 content/kind/scope/importance/anchoredToUser，
  语义是「记忆写入该不该自动确认」，不理解 archive/fold/converge/promote。
- **`triage.js` 已有 JSONL sidecar 范式**：`.evolve-triage.jsonl` + `readAll()` 容错解析 + `summary()` 聚合
  → 审计直接同构，无需新 storageDomain 域。
- 记录字段已有：`accessedAt/accessCount/injectionCount/observationCount/reinforcedAt/updatedAt/createdAt`。
- **`_evict()` 是第二条自动物理删除路径（rev3 新核实，最关键）**：
  `const excess = this.table.size - this.config.maxRecords` —— **按物理行数**判超限；
  `victims = [...nonCritical, ...critical].slice(0, excess)` —— **importance===3 只排后面、不免删**；
  排序只看 `importance` + `accessedAt||updatedAt`，**完全不看 pinned/forgottenAt**。
  → 软删记录仍计入 `table.size`，面板软删一批后它会**物理删掉活着的记录**，绕过软删/pinned/protected/可逆四条。
- **constructor L70-72**：`if (this.fts?.available) this.fts.backfill(this.all())` —— 重启后会把
  forgotten 记录**重新塞回 FTS 索引**。
- **`_renderMirror()`**：`const recs = this.all().sort(...)`，flags 只有 `imp/scope/PENDING` ——
  软删记录会**无标记混入 MEMORY.md**，看起来和活跃记忆一样。
- `spec.js` L70-79 `withParse()` 桥接：schemastery 无 `.parse()`，storage-domain open 时逐条
  `valueSchema.parse(raw)` → **加记录字段必须带 `.default()`**，否则存量库 open 抛 DomainError → apply 早退 → 静默 brick。

## 铁律约束

1. **度量/处置解耦**：heat 只读，**绝不驱动任何自动改写或归档**。
2. **所有处置可逆**：软删而非物理删；skill 只归档不删；动作前备份。
3. **零/低 token**：heat、候选、授权全部确定性零 LLM。
4. **edge 插件不挂常驻轮询**：默认纯事件驱动；unref-setTimeout 为 opt-in 默认关。
5. **kind 不进写入裁决**（adjudicator 既有铁律，本轮不破）。
6. **审计 fail-open**：审计失败绝不阻断主功能。

---

## Task 1: schema 一次性变更 —— `forgottenAt` + `pinned`

**Objective:** 一次 schema 变更 + 一次存量库验证，同时具备软删与显式保护能力（分两轮改风险更高）。

**Files:** Modify `lib/spec.js`

```js
// MemoryRecordSchema 追加（两者都必须带 default，否则存量库 open() 静默 brick）
forgottenAt: z.string().default(''),   // 软删墓碑：非空 = 已忘记（可恢复）
pinned: z.boolean().default(false),    // 用户显式保护：永不进入剪枝候选
```

`MEMORY_DEFAULTS` 追加（config 项，走 `{...MEMORY_DEFAULTS, ...config}` 合并，**不经 storageDomain parse，无 brick 风险**）：

```js
heatEnabled: true,          // 只读度量，开启无风险
heatGlobalAlpha: 1.2,
heatKindDecay: { preference: 0.0004, decision: 0.0006, fact: 0.0008, lesson: 0.001, note: 0.006, todo: 0.01 },
heatSkillDecay: 0.002,      // skill 独立衰减率（不复用 memory 的 per-kind λ）
idleRefreshEnabled: false,  // opt-in 空闲触发器，默认关
idleMinutes: 5,
auditMaxRuns: 500,          // 审计 ring-trim 上限
```

> ⚠️ 注意 protected kind 的衰减率**不设为 0**：rev1 用 λ=0 让 preference/decision 永不变冷，
> 但"永不可剪"本身是另一种膨胀源（偏好会变、旧决策会过时、被替代的冲突偏好永远清不掉）。
> 保护通过 Task 3 的三层模型实现（禁止直接 forget），而非通过冻结 heat。

**验证**：加完字段后**必须拿真实存量库跑一次 `open()`**（复制生产 `evolve_memory.json` 到隔离 DSH_HOME，
用宿主真实 cordis+storage 实例驱动 `apply()`，确认域正常打开、无 DomainError、工具全注册）。
commit `feat(spec): add forgottenAt tombstone + pinned protection fields`。

## Task 2: store 真软删 + 恢复 + 停用 `_evict()` + **堵住强化黑洞**（铁律 2 的地基）

**Objective:** 让"忘记"真正可逆，并堵住会绕过它的旧容量机制。

**Files:** Modify `lib/store.js`

### 2a 软删 / 恢复

- `async softForget(id, confirmSoft)`：设 `forgottenAt = nowIso()`，**不删除**；同步 `fts.remove(id)`。
  **pinned 兜底同 `forget`**（rev9：与 changelog 承诺的"下沉到 forget/softForget"对齐，不只改一个）：
  ```js
  async softForget(id, confirmSoft) {
    const rec = this.table.get(id);
    if (!rec) return { softDeleted: 0 };
    if (rec.pinned && confirmSoft !== true) return { softDeleted: 0, skippedPinned: 1 };  // ← rev9
    // set forgottenAt, fts.remove, ...
  }
  ```
- `async restoreForgotten(id)`：清空 `forgottenAt`，重新入 fts 索引。
- **⭐ pinned 兜底下沉到 `store.forget` 数据层（rev8，堵住对话侧绕过）**：`store.forget` 是所有删除的公共必经之路
  （对话侧 `memory_forget` 工具 index.js L393 直接调它、不经 `authorizePruneAction`；面板、未来入口同理）。
  保护放这里，所有入口自动免疫：
  ```js
  async forget(id, confirmDelete) {
    const rec = this.table.get(id);
    if (!rec) return { deleted: 0 };
    if (rec.pinned && confirmDelete !== true) return { deleted: 0, skippedPinned: 1 };   // ← rev8 新增
    if (rec.importance === 3 && confirmDelete !== true) return { deleted: 0, skippedImportant: 1 };
    ...
  }
  ```
  分层职责：**面板路径**走 `authorizePruneAction` 对 pinned 直接 `reject`（UI 层就不给删按钮）；
  **对话侧 `memory_forget`** 靠 store 层兜底（pinned 需显式 `confirm=true`，且工具 description 要写明）；
  两层都挡，数据层是最后防线。`softForget` 同理：面板对 pinned 不给软删入口，但若被调到也遵循同一兜底。
  > `memory_forget` 工具的 description（index.js L387）要同步补一句"pinned 记录需 confirm=true"——
  > schema/description/数据层三处一致（否则模型不知道要传 confirm，pinned 记录变成"删不掉也不报为什么"）。
- **⭐ 排除策略：收敛到单一闸门 `confirmed()`，不再逐处记清单（rev6 架构修正）**：

  rev1→rev5 用"逐处列举要过滤 forgottenAt 的地方"，从五处补到六处仍漏了第七处（`assessWrite`）——
  **列举法必然漏**。rev6 改为把墓碑过滤下沉到 `confirmed()`，让"活跃记录"只有一个定义：

  ```js
  confirmed() {
    // 唯一"活跃记录"闸门：非 pending 且非墓碑。所有活跃记录消费者都走这里，
    // 新增消费者自动免疫，无需再逐处记清单。
    return this.all().filter((r) => !r.tags.includes(PENDING_TAG) && !r.forgottenAt);
  }
  ```

  然后**把所有"活跃记录"消费者统一改走 `confirmed()`**：
  - `assessWrite()`：`assessWriteQuality(candidate, this.all(), …)` → **`this.confirmed()`**
    （实测 L477 现传 `all()`，是第七处泄漏点）。
  - `memoryBudgetStatus()` / `promotionCandidates()`：实测已走 `confirmed()` ✓（无需改）。
  - `profileView()` / `adjudicate()` 的 confirmedRecords 入参：确认走 `confirmed()`。
  - `recall()` / `tier1Snapshot()`：这两个不基于 confirmed()（recall 有自己的候选池、tier1 是快照），
    **仍需各自显式过滤 `!r.forgottenAt`**（它们本就不该注入/召回墓碑）。
  - `crystallizationEvidence()` / `evidenceByTag()`：**实测已走 `confirmed()`**（L509/L537）✓ —— 
    墓碑过滤下沉进 `confirmed()` 后**自动免疫，无需改**（与 budgetStatus/promotionCandidates 同）。
    > 结晶证据尤其不能漏——否则已忘记的记忆仍会被结晶成 skill；靠单闸门天然堵住。

- **⭐ 写路径强化循环单独堵，需要两个并列守卫（`confirmed()` 兜不住它，因为它遍历 `table.entries()` 原始表）**：
  `remember()` 的**近重复强化循环**必须显式跳过墓碑**和 pinned**：
  ```js
  for (const [key, rec] of [...this.table.entries()]) {
    if (rec.forgottenAt) continue;   // 守卫1：墓碑不参与强化合并，否则"记忆黑洞"
    if (rec.pinned) continue;        // 守卫2：pinned 记录不被强化改写，尊重"别动它"
    if (rec.scope !== scope || rec.kind !== kind) continue;
    ...
  ```
  **两个后果各对应一个守卫**（实测 `store.js` L184-186 两个判断都没有）：
  - 缺守卫1（墓碑）：软删过 X 后再说类似 X → 命中墓碑被"强化"但仍带墓碑、永不出现在读路径 →
    **新表述被静默吞掉**，比"复活"更糟的**记忆黑洞**。`assessWrite`（第二入口）走 `confirmed()` 后同样被堵。
  - 缺守卫2（pinned）：用户 pin 的"别动这条"记忆，被一条近重复写入把 content/importance/
    observationCount/updatedAt **全刷掉**，pin 形同虚设。Task 3 说 pinned"任何动作 reject"——
    强化改写就是一个没被 reject 的写路径动作，必须在此并列挡住。
  - **两者命中时都同软删语义 (a)：新建一条记录**，不改写被保护/锁定的那条。
  - **语义决策（明确定为 (a)）**：软删过 X、之后又说近重复的 X →
    **产生一条全新记录**，墓碑保留历史、不被强化、不被复活。理由："忘记"是对**那一条**的处置，
    不是对**这个话题**的永久封禁。（否决 (b) 自动复活——违反用户显式软删的意图；
    否决 (c) 拒绝写入——等于话题封禁。）
- `list({forgotten:true})` 可查看已忘记记录（供恢复用）。
- 原 `forget(id, confirmDelete)` **保留为物理删除**，但仅对话侧显式 `confirmDelete=true` 可达；
  **面板只调 `softForget`**。
- `stats()` 增 `forgotten` 计数。

### 2b ⭐ 停用 `_evict()` 的自动物理删除（rev3 新增，本轮最关键的一处）

**为什么必须改**：`_evict()` 按 `this.table.size`（**物理行数**）判超限，软删记录仍计数 →
面板软删一批后 size 不降 → 下次写入 `_evict()` 判仍超限 → **物理删掉活着的记录**；
且 `importance===3` 只是排在 victims 末尾、**excess 足够大时照样被删**；排序完全不看 `pinned`/`forgottenAt`。
不改它，Task 1/2a/3 的软删、pinned、protected、"所有处置可逆"**四条全被绕过**。

改法（**推荐方案：容量治理只报告、不自动删**）：

```js
async _evict() {
  // v0.4.2: automatic PHYSICAL deletion is retired. Capacity governance is
  // "detect automatically, dispose explicitly": the char budget
  // (memoryBudgetStatus) + the prune panel own disposal, with soft-delete and
  // pinned/protected honored. Silently deleting live records here would bypass
  // all of it. Report only.
  const status = this.memoryBudgetStatus();
  if (status.overBudget) {
    this.logger.warn(`[dsh-evolve] memory over budget (${status.used}/${status.max} chars) — review trim candidates via memory_budget or the prune panel`);
  }
}
```

- `maxRecords` 行数硬上限是 v0.1 遗留，与后来的 g3 字符预算（`memoryMaxChars`）职责重复；
  保留 config 项但**不再驱动删除**（仅在 stats 里作参考展示）。
- 如将来确需硬上限，**次选**方案是：只物理清理"超过保留期的 `forgottenAt` 墓碑"，
  不足时仅报告；`pinned`/protected/活跃记录**绝不自动删**。本轮不实现。
- **保留 L230 的 `await this._evict()` 调用点**（remember 尾部）：只把 `_evict()` 函数体改成"只报告不删"，
  **调用点不删** —— 否则连 over-budget 的 warn 都不会触发。实现时勿"顺手删调用"。

### 2c 软删的两个边界（rev3 新增）

- **FTS backfill**：constructor 的 `this.fts.backfill(this.all())` 会在重启后把 forgotten 记录
  重新塞回索引（虽然 recall 的 allowed pool 通常能过滤掉，但会增加索引噪音、浪费内存、
  且让正确性依赖"后续过滤不出错"）。改为：
  ```js
  this.fts.backfill(this.all().filter((r) => !r.forgottenAt));
  ```
- **Markdown 镜像**：`_renderMirror()` 用 `this.all()`，软删记录会无标记混进 MEMORY.md。改为
  主列表 `filter(r => !r.forgottenAt)`，并在文件末尾另起 `## Forgotten (recoverable)` 区列出，
  每行标 `FORGOTTEN`。**不能让用户在镜像里看到软删记录仍像正常活跃记忆。**
- **`stats()` 统计口径（rev4 补明）**：`total` / `byKind` / `byScope` **只统计非墓碑**记录，
  `forgotten` 单独计数。否则软删后总数/分布仍含墓碑，与用户"已忘记"的认知不符。

**验证断言**：①softForget 后记录仍在 `all()` 但不在 confirmed/recall/tier1/结晶证据里
②restore 后完全恢复可召回 ③softForget 不改 importance/observationCount（只加墓碑）
④物理 `forget()` 行为与 v0.4.1 逐字节一致（未回归）
⑤**构造 maxRecords 超限 + 一批软删记录，断言 `_evict()` 后活跃记录数为零删除**（钉死不绕过）
⑥**pinned / importance=3 记录在任何超限情形下都不被 `_evict()` 物理删除**
⑦重启（重建 store）后 forgotten 记录不在 FTS 索引里
⑧MEMORY.md 主列表无 forgotten 记录，Forgotten 区有且标 FORGOTTEN
⑨**（记忆黑洞防线·入口1 强化循环）软删 X 后再次 remember 近重复的 X → 产生新记录；墓碑 observationCount 不变、
importance 不变、updatedAt 不变、forgottenAt 仍在（不被强化、不被复活）**
⑩`stats().total`/`byKind`/`byScope` 排除墓碑，`forgotten` 计数正确
⑪**（记忆黑洞防线·入口2 质量门）`assessWrite` 对"与已软删记录近重复"的新写入返回 `ok`（不判 near-duplicate），确保墓碑不挡新写入**
⑫**（单闸门回归）构造一条墓碑，断言它不出现在 `confirmed()` / `assessWrite` 的 existing / `budgetStatus` / `promotionCandidates` / `profileView` / `crystallizationEvidence` 任一处**
⑬**（pinned 写保护·强化）pin 一条记录后 remember 近重复的它 → 产生新记录；pinned 记录的 content/importance/observationCount/updatedAt 全部不变（不被强化改写）**
⑭**（pinned 删保护·数据层兜底）对 pinned 记录直接调 `store.forget(id)`（不带 confirm）→ 被拒（`skippedPinned`）、不物理删除；带 `confirm=true` 才删**。这一条不经面板授权、直接打数据层，证明对话侧 `memory_forget` 也挡得住。
⑮**（pinned 软删兜底）对 pinned 记录调 `store.softForget(id)`（不带 confirmSoft）→ 被拒（`skippedPinned`）、forgottenAt 不被设置；带 `confirmSoft=true` 才软删**。与 forget 对齐，兑现"下沉到 forget/softForget 两个方法"。

## Task 3: 三层保护模型 + `lib/prune-authz.js` 剪枝授权裁决器

**Objective:** 剪枝授权独立于写入审批，且保护分层而非二元。

**Files:** Create `lib/prune-authz.js`；Modify `lib/index.js`

三层保护：

| 层 | 判据 | 剪枝行为 |
|---|---|---|
| pinned | `record.pinned === true` | **永不进入候选**，任何动作 reject |
| protected kind | `kind ∈ {preference, decision}` | **不进普通剪枝候选**；单独「保护记录（需专项审阅）」区只读展示，**不可直接 forget** |
| 普通 | `fact/lesson/note/todo` | 按预算+强化+使用+heat 排序，正常可处置 |

> **rev3 修正**：rev2 让 protected kind 进候选但标 `allowedActions` 不含 forget —— 结果是用户看到
> 「旧偏好 · 保护类型 · 不可忘记」却**没有任何处置出口**，即"看得见处理不了"。rev3 改为**不进普通候选**，
> 只在独立区域只读展示 + 明确文案「本版本暂不支持直接处置」。
> 正确的语义出口是 `memory-supersede`（新偏好取代旧偏好、旧的退出 Tier1/recall 但保留历史链，
> 靠 `supersededBy` 字段）—— 比对 preference/decision 做 softForget 更贴合"偏好变更"，
> 但那是独立特性且要加第三个 schema 字段，**留下一版**，本轮不做。

`authorizePruneAction(action, target, cfg)` → `{allowed, reason, requires?}`：

```
pinned                          → reject('pinned by user')
protected kind + memory-forget  → reject('protected kind — use conflict/staleness review')
importance===3 + memory-forget  → allowed, requires:'explicit-confirm'
skill-fold                      → allowed, requires:'backup'
skill-converge                  → 需 >=2 个 evolve-owned skill，否则 reject
skill-archive                   → 仅 evolve-owned（EVOLVE_MARKER），否则 reject
memory-promote                  → 仅 scope==='project'，否则 reject
```

> **绝不复用 `adjudicate()`**：它的输入是 content/kind/scope/importance/anchoredToUser，
> 语义为"记忆写入是否自动确认"，不理解 archive/fold/converge/promote/软删 —— 硬套是语义错配。

**验证断言**：①pinned 记录对所有 action 均 reject ②protected kind 可被 promote/审阅但 forget 被拒
③非 evolve-owned skill 的 archive 被拒 ④`authorizePruneAction` 与 `adjudicate` 互不调用（模块独立）。

## Task 4: `lib/heat.js` —— 只读时间冷度（memory / skill 双函数）

**Objective:** 提供只读冷度信号，供候选排序与 UI 展示。

**Files:** Create `lib/heat.js`

公式（借 dsh-mneme，MIT，纯数学）：`H = 1 / (1 + λ·Δt)^α`

```js
memoryHeat(record, cfg, now)   // Δt 天数取 accessedAt || createdAt，λ 按 kind 查 heatKindDecay
skillHeat(skillUsage, cfg, now) // Δt 取 lastActivityAt || createdAt || SKILL.md mtime，λ = heatSkillDecay
annotateHeat(items, kindOfFn, cfg, now) // 返回带 _heat 的浅拷贝，不落盘不改原对象
```

两点必须写进模块顶部注释当护栏：

```
READ-ONLY SIGNAL — MUST NOT drive any mutation, archive, or deletion.
HEAT IS TIME-COLDNESS, NOT USAGE VALUE. accessedAt only advances on explicit
recall; auto-injection bumps injectionCount ONLY (by design, v0.2.1, to avoid
the inject→rank→inject Matthew effect). A frequently auto-injected memory can
therefore look "cold". injectionCount / observationCount MUST stay as
independent sort keys ORDERED BEFORE heat — never let heat alone represent value.
```

- **绝不用 `updatedAt` 作时间基准**（合并/精炼会刷 updatedAt，那不是"被访问"——dsh-mneme v0.7.0 修过的语义 bug，直接吸收正确版）。
- skill 不复用 MEMORY_KINDS 的 per-kind λ（skill 无 kind 概念）。

**验证断言**：①同 kind 越旧 heat 越低 ②heat 计算只读——调用前后原对象逐字节不变
③`accessedAt` 缺失回落 `createdAt`（**不是 updatedAt**）④`skillHeat` 用 lastActivityAt 且不读 kind
⑤`heatEnabled:false` 时不参与任何排序。

## Task 5: heat 接进候选排序（位置正确，否则是哑功能）

**Objective:** 让"该先剪谁"更平滑，但不改变"谁有权剪"。

**Files:** Modify `lib/memory-convergence.js`、`lib/converge.js`

`budgetStatus(records, maxChars, cfg)` 新排序（heat 在**时间戳之前**）：

```js
importance ASC
  → observationCount ASC
  → injectionCount ASC
  → heat ASC            // ← 必须在此位置；放 updatedAt 之后几乎永不生效（rev1 的错）
  → createdAt ASC       // 稳定 tie-break
```

- **pinned 整条排除出候选**；**protected kind（preference/decision）也整条排除出普通候选**
  （rev3：改为只在「保护记录（需专项审阅）」区展示，见 Task 3）。
- 已 `forgottenAt` 的记录不进候选（已经忘记了）。
- `findMergeCandidates`：现有 `zeroLoadCount desc → similarity desc` 之后**追加** `skillHeat asc`
  作末位信号（不改前两键权重）。

**验证断言**：①**候选集合成员不因 heat 改变，只改顺序**（钉死"heat 不扩大处置范围"）
②pinned 永不出现在候选 ③`heatEnabled:false` 时排序与 v0.4.1 逐字节一致（可回退）
④构造两条仅 heat 不同、其余键全等的记录，断言顺序确实由 heat 决定（证明真的生效，防哑功能回归）。

## Task 6: `lib/prune-plan.js` —— 计划/校验/receipt/审计（收缩版）

**Objective:** 处置留痕可回放，但不做无生产者的过度工程。

**Files:** Create `lib/prune-plan.js`；Modify `lib/index.js`

**本轮只做**（rev1 的 `FIELD_ALIASES`/`ACTION_SYNONYMS`/`<think>` 剥离**全部删除** ——
`converge_skill({names,into})` / `fold_skill({name})` 都是强类型调用，本轮**没有任何自由格式 LLM
decision JSON 流入**，做别名归一化是孤立基础设施。推迟到真正接 autoDream 时再做）：

- 统一内部结构 `PruneDecision`：`{action, entityType:'memory'|'skill', targets[], reason}`
- `buildPlan(candidates, selection)` → `{planDigest, createdAt, decisions[], targetEtags{}}`
  - `planDigest` = sha256(规范化 decisions)（`node:crypto`）

### ⭐ 逐目标 etag（rev3 取代 rev2 的全局 `sourceRevision`）

rev2 用全局「记录数 + 最大 updatedAt hash」，但它**反映不了**：`injectionCount` lazy flush
（我们刻意不刷 updatedAt）、skill usage sidecar 变化、别的会话归档/refine 了某个 skill、
候选排序依赖的 usage/heat 变化。改为逐目标 etag：

```js
memoryEtag(r) = sha256({ id, updatedAt, importance, observationCount,
                         injectionCount, pinned, forgottenAt, scope })
skillEtag(s)  = sha256({ name, version, lastActivityAt, status, refinementCount })
```

execute 时**逐目标校验**：某目标 etag 已变 → **只跳过该目标并回原因 `stale-target`，
不整单失败**（其余目标照常应用）。

### ⭐ 内存 plan/receipt registry（rev3 新增，闭合 preview→execute）

rev2 没说 `planDigest` 对应的完整 plan 存哪，且**用 fail-open 的 audit 做幂等是自相矛盾的**
（审计写失败或进程重启后就没有原 receipt 了，而 `skill-converge` **不天然幂等** ——
重复执行会再造一个 umbrella skill）。所以幂等必须靠内存 registry，**不能靠 audit**：

```js
// 进程内：Map<planDigest, { plan, createdAt, expiresAt, consumed, receipt }>
TTL 15 分钟 / 上限 100 条（LRU 淘汰）
```

- `POST /preview` → `buildPlan()` 存入 registry，返回 `{planDigest, preview}`。**不写 JSONL**
  （preview 是只读操作，不该产生持久审计记录）。
- `POST /execute` → 按 `planDigest` 从 registry 取回完整 plan：
  - 命中且 `consumed` → **返回原 receipt，不重复执行**（真幂等）
  - 命中未 consumed → 逐目标校验 etag → 应用 → 标 `consumed` + 存 receipt
  - **未命中（进程重启 / TTL 过期 / 被 LRU 淘汰）→ `plan-expired`，要求重新 preview**
    （绝不凭客户端回传的数据盲执行）
- 客户端**不回传完整 plan**（payload 小、防篡改）；服务端只认自己 registry 里的那份。
- `applyPlan()`：**每条 decision 独立应用 + 独立 receipt，不做跨条事务**（因此"部分应用"是天然语义，
  无需实现回滚）。返回：
  ```json
  { "status":"ok|degraded", "applied":[{...,"receipt":"..."}],
    "skipped":[{"target":"...","reason":"pinned"},{"target":"...","reason":"not-found"}] }
  ```
  **逐条留 skipped 原因**，不只给一个 degraded 状态。
- 审计走 **JSONL sidecar**（与 `triage.js` 同构，**不新建 storageDomain 域**）：
  `evolve-workspace/.evolve-audit.jsonl`，`appendRun()` / `readRuns()` / ring-trim 保留最近
  `auditMaxRuns`(500) 条。**读写全 best-effort try/catch → fail-open**：审计失败只记 warn，
  绝不阻断剪枝主功能（避免成为 v0.3.0 同型的新静默 brick 点）。

**验证断言**：①同 digest 二次 execute 返回原 receipt 且**不重复执行**（用 skill-converge 验：umbrella 只被创建一次）
②目标 etag 变化 → 该目标 `stale-target` 跳过、**其余目标照常应用**（非整单失败）
③registry 未命中（模拟重启/TTL 过期）→ `plan-expired`，且**不执行任何动作**
④preview 调用前后 store 逐字节不变、**不产生 JSONL 记录**
⑤skipped 逐条带原因 ⑥sidecar 超 `auditMaxRuns` 被 ring-trim
⑦**故意让 sidecar 路径不可写，剪枝主功能仍成功**（fail-open）
⑧registry 超 100 条时 LRU 淘汰最旧、不影响未 consumed 的新 plan。

## Task 7: web 路由 —— 强类型 union（读候选 / preview / execute）

**Objective:** 给面板供数据收动作，类型安全不混用 ID。

**Files:** Modify `lib/web-routes.js`（host 侧手写 plain ESM，**不经构建**——文件头自称 "Plain ESM (no build)"；`src/` 下只有 client 的 .ts/.tsx，无 web-routes）、`lib/index.js`

- `GET /api/evolve/prune` → 两类**分开**返回：
  ```json
  { "budget": {"used":0,"max":20000,"overBudget":false},
    "memoryCandidates":[{"entityType":"memory","id":"mem_1","summary":"...","kind":"note",
      "importance":1,"heat":0.03,"injectionCount":0,"observationCount":1,
      "pinned":false,"protectedKind":false,"reason":"low importance + cold",
      "allowedActions":["memory-forget","memory-promote"]}],
    "skillCandidates":[{"entityType":"skill","name":"skill-a","similarity":0.82,
      "zeroLoadCount":2,"heat":0.11,"refinementCount":6,
      "allowedActions":["skill-archive","skill-fold","skill-converge"]}] }
  ```
- `POST /api/evolve/prune/preview` → 入参同 execute，**只返回将发生什么**，不改任何状态。
- `POST /api/evolve/prune/execute` → **discriminated union**，绝不用通用 `ids[]`：
  ```json
  {"action":"memory-forget","memoryIds":["mem_1"],"planDigest":"..."}
  {"action":"memory-promote","memoryIds":["mem_2"],"planDigest":"..."}
  {"action":"skill-archive","skillNames":["skill-a"],"planDigest":"..."}
  {"action":"skill-fold","skillNames":["skill-b"],"planDigest":"..."}
  {"action":"skill-converge","skillNames":["a","b"],"into":"umbrella","planDigest":"..."}
  ```
- 复用现有 `isTrustedLocalRequest()` loopback 同源栅栏，不新写安全层。
- **每个 handler 每数据源独立 try/catch**（v0.3.0 教训：handler 内 throw → 裸 400 → 前端所有控件卡
  disabled，看似"按钮点不了"实为一个根因）。

**验证**：裸 curl → **403**（栅栏在）；带同源头（`Origin`/`Host`/`sec-fetch-site: same-origin`）→ **200**（链通）。
两面都验。preview 调用前后 store 逐字节不变。

## Task 8: A2 面板 —— 同页两区 + 分组 + preview→execute

**Objective:** 补上"人工在哪操作剪枝"的断层。

**Files:** Modify `src/client/EvolveSettingsSection.tsx`
（`scripts/wrap-client.mjs` 的 `MODULE_ID` 保持裸名 `dsh-evolve` —— **四处 name 一致铁律，别碰**）

版面（A2 同页上下两区）：

- **上半（现有，不动）**：待确认记忆（审批门）+ 批量确认。
- **下半（新增）**：受控剪枝，**memory 与 skill 分组显示，不混在一张多选列表**：
  - 预算条：`已用 X / 上限 Y 字符`，超限标红。
  - **待清理记忆**：每行 = 摘要 + 徽标 + 入选原因 + 勾选框。徽标文案**不用"冷"这种易误读的词**
    （rev3：避免用户把"冷"理解成"没用" —— heat 只是时间冷度，见 Task 4 护栏）：
    ```
    久未主动访问 · heat 0.03
    自动注入 12 次
    ```
    `pinned` 行**不可勾选**（灰显 + tooltip 原因）。
  - **保护记录（需专项审阅）**：protected kind（preference/decision）**只读**列出，
    文案明确「本版本暂不支持直接处置」（rev3：不进普通候选、不给假的勾选框，避免"看得见处理不了"）。
  - **待收敛技能**：每行 = 名称 + 相似度 + `零加载` + `refinement×6` + 勾选框。
  - 动作按钮按 `allowedActions` 交集启用：`忘记(可恢复)` / `合并` / `折叠` / `归档技能` / `提升为全局`。
  - **preview → execute 两阶段**（不用通用二次弹窗）：点动作先出预览
    ```
    预览：
    - 将软删 3 条记忆（可恢复）
    - 将归档 1 个 skill（已备份，可 restore）
    - 2 条被跳过（pinned）
    ```
    确认后才带 `planDigest` 执行；返回逐条 receipt 与 skipped 原因。
  - 已忘记记录的**恢复入口**：折叠区"已忘记（可恢复）"列表 + 恢复按钮。
- 空态：`（无待清理候选）`，与上半区风格一致。

**验证（WSL 无 GUI 的正道）**：不开浏览器，直接 POST 复现前端请求 —— 带同源头 curl
`/api/evolve/prune` 得 200 + 分组候选 JSON；`/preview` 得预览且 store 不变；裸 curl 得 403。
再 `curl -s localhost:3080/ | grep dsh-evolve/client.js` 确认加载的是新 client.js（rev hash 变），
并 curl 该 client.js 头部确认是 `window.__ModuleLoader__.load` 壳。

## Task 9: opt-in 空闲触发器（默认关）

**Objective:** 让候选在真正空闲时自动新鲜化；默认不启用，不碰红线。

**Files:** Create `lib/idle-trigger.js`；Modify `lib/index.js`

- 默认（`idleRefreshEnabled:false`）：候选**仅**在 `turn/end` + 打开面板时惰性计算。**零 timer**。
- opt-in：`noteWrite()` 每次记忆写入 → clearTimeout 旧的 → 重新武装**单次 `setTimeout` + `.unref()`**，
  在空闲窗口（`idleMinutes` 默认 5）耗尽时回调，只做**纯确定性只读候选重算**（零 LLM），结果缓存给面板。
  用户一写入即取消。
- **绝不 setInterval、绝不轮询、回调内绝不做任何处置**（只算候选、只写缓存）。
- `dispose()` 必须 clearTimeout（卸载不留悬挂 timer）。

**验证断言**：①默认关时不创建任何 timer（注入 fake setTimeout 计数为 0）②开启后写入重新武装、
再写入取消前一个（fake timer 断言 clear 次数）③回调只调只读函数（记录型 mock 断言无写方法被调用）
④dispose 后无残留 timer。

---

## Files likely to change

新增：`lib/heat.js`、`lib/prune-authz.js`、`lib/prune-plan.js`（含内存 plan/receipt registry）、`lib/idle-trigger.js`
修改：`lib/spec.js`、`lib/store.js`、`lib/memory-convergence.js`、`lib/converge.js`、`lib/index.js`、
`lib/web-routes.js`（host 路由，plain ESM 不经构建）、`src/client/EvolveSettingsSection.tsx`、`smoke.mjs`、`HERMES_USAGE.md`

**工具数保持 22**（不新增第 23 个 —— 22 个工具的选择负担上一轮已认定是真问题，
且新工具与面板后端高度重叠；剪枝走面板，对话侧用已有 `evolve_maintain` / `memory_budget` /
`memory_forget` / `memory_promote` / `converge_skill` / `fold_skill`）。
软删恢复不新增工具：挂进已有 `memory_auto_review` 的 action 面（与其"撤销/恢复"语义同类）。
→ `apply-probe.mjs` 的 expectTools **保持 22 不改**。

## Tests / validation

1. `PATH="$HOME/.local/node22/bin:$PATH" pnpm run test`
   —— **命令主体单独跑**，用 `workdir` 设目录；不要 `cd &&`/`corepack`/`&& echo` 包裹
   （否则 verification hook 抓不到，会误报 unverified）。
2. typecheck + `pnpm run build` 三绿。
3. `apply-probe.mjs`：22 工具 / 1 section / hook 数不变。
4. **schema 变更专项**：拷贝生产 `evolve_memory.json` 到隔离 DSH_HOME，用宿主真实 cordis+storage 实例
   驱动 `apply()`，确认域打开无 DomainError、工具全注册（防 `withParse` 同型 brick）。
5. 部署：`dsh-plugin-apply check`
   —— **预期 `dsh-better-sidebar` 双重加载 fatal 又回来**（UI/dshmarket 反复追加进顶层 bundles），
   按惯例 python JSON-safe 删顶层那份再 apply。若在 pnpm 树（`~/.dsh-versions/*`）报核心包
   not loadable = **假 FATAL**，改手动重启 + 运行态硬核验（active + 200 + 同 PID 稳定 5s+ + err 尾无崩溃栈）。
6. 运行态：带同源头 curl `/api/evolve/prune` 200、`/preview` 不改状态、裸 curl 403、首页引用新 client.js。

## Risks / tradeoffs / open questions

- **schema 加字段（最高风险）**：`forgottenAt`/`pinned` 是**真实新增的记录字段**，必须带 `.default()`；
  否则存量库 open 时 `valueSchema.parse` 抛 DomainError → apply 早退 → **整插件静默罢工**（服务仍 200 健康，极难查）。
  → 必须过验证 4。注意 config 项（heat*/idle*/audit*）走 defaults 合并，**不经 parse，无此风险**（rev1 把这层写反了）。
- **heat 被误用为价值**：若哪天有人拿 heat 单独代表使用价值，或接进自动归档，即破铁律 1。
  → 模块顶注释 + smoke 的"heat 不扩大候选集合"断言当双护栏。
- **protected kind 的过期问题（本轮已诚实收口，不留假出口）**：preference/decision 会过时，
  但本轮**没有**处置流。rev3 的做法是不进普通候选、只在独立区只读展示 + 明确文案，
  **宁可"暂不支持"也不给一个点不动的勾选框**。下一版做 `memory-supersede` + `supersededBy`
  （新偏好取代旧的，旧的退出 Tier1/recall 但保留历史链）—— 这才是"偏好变更"的正确语义。
- **`_evict()` 停用后的容量兜底**：行数硬上限不再驱动删除，理论上记录数可无限增长。
  实际由字符预算（`memoryMaxChars`）+ 面板显式处置兜底，且 `stats()` 会报 `total/maxRecords` 供观察。
  若实测出现失控增长，再按 Task 2b 的"次选方案"只清理过期墓碑（仍不碰活跃/pinned/protected）。
- **放弃语义召回的代价**：跨语言/近义（「苹果手机」↔「iPhone」）仍召不回。本轮明确接受；
  若将来记忆库规模真到词法不够，再单独评估**可选外部 embeddings API**（而非本地模型）。
- **已定案（rev2 的 open question 已解决）**：`sourceRevision` 全局粒度不够 → 改**逐目标 etag**
  （见 Task 6），单目标 stale 只跳过该目标。
- **Open question（rev3 新）**：registry TTL 15min / 上限 100 是拍的初值。若实测用户常在预览后
  隔很久才确认（导致频繁 `plan-expired` 需重新预览），把 TTL 调长即可，不影响正确性。
