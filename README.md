# dsh-evolve

Self-evolving memory and skill lifecycle for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh).

Your agent forgets everything between sessions. This plugin gives it durable memory, turns
repeated procedures into reusable skills, and — crucially — keeps that knowledge **from
growing into a noise pile**. Real evolution is mutation *plus* selection *plus* pruning; most
memory plugins only do the first.

The plugin ships **blank**. It has no preloaded opinions about you or your work: only
mechanisms and rules. Everything it learns is local to your install and never leaves it.

---

## Requirements

| Requirement | Why |
|---|---|
| **Node.js >= 22.5.0** | Uses the built-in `node:sqlite` module for FTS5 full-text search. Node 20 will not work. |
| **DeepSeek Harness** `0.1.0-rc.7`+ | Host platform. Provides tools, storage, LLM, and (optionally) the web server. |
| `git` on PATH *(optional)* | Enables automatic memory checkpoints you can roll back. Without it, checkpoints are skipped. |
| `tar` on PATH *(optional)* | Enables pre-operation skill backups and `skill_rollback`. Without it, backups are skipped. |
| Linux / macOS | Developed and tested here. Windows is untested — path handling is platform-neutral, but `git`/`tar` availability differs. |

Degradation is graceful by design: if SQLite/FTS5 is unavailable the plugin falls back to
pure bigram recall, and any optional dependency that's missing disables only its own feature.
It never blocks the harness from booting.

---

## Install

Straight from this repository — no npm package needed:

```bash
dsh plugin --profile web add github:chenzheshushi-commits/dsh-evolve
```

Pin a specific release instead of tracking `main`:

```bash
dsh plugin --profile web add "https://github.com/chenzheshushi-commits/dsh-evolve/releases/download/v0.4.2/dsh-evolve-0.4.2.tgz"
```

Then restart the harness — tools are discovered at startup, not hot-reloaded.

Or clone for development:

```bash
git clone https://github.com/chenzheshushi-commits/dsh-evolve.git
cd dsh-evolve
pnpm install
pnpm run build      # builds the web-settings client bundle
pnpm run test       # smoke + registration probe + web-route e2e
```

---

## What it does

### Cross-session memory
Structured records (`fact` / `preference` / `decision` / `lesson` / `todo` / `note`) with scope
(`user` = everywhere, `project` = here) and importance 1–3. Storage is JSON as the source of
truth plus a Markdown mirror you can read and hand-edit.

Recall is **zero-token and deterministic**: bigram-Jaccard similarity fused with SQLite FTS5
BM25 through Reciprocal Rank Fusion. No embedding API, no per-turn model call. CJK text is
tokenized correctly (searching 苹果 does not match 水果).

Relevant memories inject automatically each step based on the current message, and durable
user preferences/facts inject as an always-on snapshot at the start of every turn.

### Tiered approval, not "confirm everything"
Model-written memories pass through a deterministic gate that decides **auto-confirm vs. hold
for review**, judged only on properties a model cannot flatter:

- reversibility (importance level)
- conflict with something you already confirmed
- overlap with existing memory
- whether the write traces back to something you actually said

Obvious, reversible, user-anchored writes land automatically. Risky or uncertain ones queue for
review. The gate deliberately ignores the model-supplied `kind` field — letting a self-reported
label decide its own exemption would be no gate at all. Auto-confirmed entries stay visible and
revocable, and one config flag returns you to review-everything behavior.

### Reinforcement: what you repeat gets stronger
Re-observing the same understanding doesn't duplicate it — it reinforces it. The observation
count rises, importance climbs at a configurable threshold, and the **better-quality phrasing is
kept** rather than blindly overwritten. Confidence is surfaced (`low` / `medium` / `high`) so the
agent can weight established knowledge over one-off remarks.

### Skills that improve instead of accumulating
High-value lessons sharing a tag crystallize into a `SKILL.md`. New evidence **refines the
existing skill in place** — versioned, with your hand edits preserved — instead of spawning a
near-duplicate.

Curation runs a real lifecycle: `active` → `stale` (idle N days) → `archived`. Archiving moves a
skill out of the active catalog and is fully reversible. **Nothing is ever deleted.** A backup is
taken before every mutating operation, so a bad refine or a hasty archive can be rolled back.

### Anti-bloat convergence
The half most memory systems skip.

**Skills:** detects near-duplicate skills by content similarity and flags refinement-bloated
files. Merging generates an umbrella skill and archives the originals (reversible). Folding
compacts stacked refinement sections back into clean prose. Candidates that were never actually
loaded rank first — duplicated *and* unused is the strongest case for merging.

**Memory:** a hard character budget that never silently drops anything (over-budget returns trim
candidates for you to decide on), a gate against reworded near-duplicates and thin low-signal
writes, and promotion of well-reinforced project memories to global scope.

Detection is always on and costs zero tokens. Every mutating action is opt-in.

### Background review
At the end of a turn (throttled), an **isolated** LLM pass replays that turn's conversation
snapshot and asks what's worth remembering. Suggestions route through the same approval gate —
the reviewer proposes, it never writes directly.

It runs as a standalone call, so your main conversation and prompt cache are never touched, and
because it's a plain text completion with no tools attached it is structurally incapable of
side effects. It can be pointed at a different (cheaper or stronger) model than your main one.

Weak models degrade safely: a malformed review is skipped, so the worst outcome is "nothing
learned this turn" — never "something wrong learned."

### Knows you, and shapes tools to you
Confirmed user-scope preferences and facts accumulate into an auto-grown profile you can inspect,
ordered by how consistently you've shown each one.

Skills can also carry a **user-style overlay**: a small instruction layer applied when the skill
is used, derived from your profile. The underlying `SKILL.md` is never rewritten, so the overlay
is fully reversible — clear it and the skill is vanilla again.

### Maintenance sweep
A single tool aggregates every read-only check — archivable skills, merge candidates, bloated
files, memory budget, promotion candidates, and whether enough outcome data has accumulated to
be worth scoring — into one report. Safe to run on a schedule from an external cron; the plugin
never installs an internal timer.

---

## Tools

**Memory:** `memory_remember` `memory_recall` `memory_index` `memory_confirm`
`memory_confirm_batch` `memory_auto_review` `memory_profile` `memory_budget` `memory_promote`
`memory_forget`

**Skills:** `crystallize_skill` `refine_skill` `skill_curator` `archive_skill` `restore_skill`
`skill_rollback` `converge_skill` `fold_skill` `skill_style`

**Ops:** `evolve_maintain` `memory_stats` `skill_stats`

---

## Configuration

Everything is configurable through the plugin's settings page (web profile) or your DSH config.
Notable switches:

| Key | Default | Effect |
|---|---|---|
| `autoConfirmEnabled` | `true` | `false` = every model write waits for review |
| `reviewEnabled` | `true` | Background per-turn review |
| `reviewEveryTurns` | `5` | Review throttle |
| `reviewModel` | *(main model)* | Route review to a different model |
| `refineLLM` | `false` | Use an LLM pass when crystallizing/refining skills |
| `reinforceEvery` | `3` | Observations per importance step |
| `memoryMaxChars` | `20000` | Memory character budget (`0` disables) |
| `convergeSuggest` | `true` | Surface merge/fold suggestions |
| `curatorStaleDays` / `curatorArchiveDays` | `30` / `60` | Skill lifecycle thresholds |
| `ftsEnabled` | `true` | `false` = pure bigram recall, no SQLite |

The LLM is only ever used for optional auxiliary passes — skill refinement, background review,
and skill merging. All of them are single-shot, skippable, and fall back to deterministic
behavior on failure. Nothing runs in your main loop.

---

## Design rules

- **Never break the harness.** Every failure path degrades quietly; the plugin cannot prevent a boot.
- **Never delete user assets.** Archive, back up, roll back — but never destroy.
- **No internal timers.** In-session work hangs off events; offline work is an external cron calling a tool.
- **Ship blank.** No preloaded personal data. What it learns stays on your machine and is never packaged.
- **Mechanisms over model smarts.** Safety comes from deterministic rules, so swapping models changes quality, never safety.

---

---

## What's new in v0.4.2

**The missing half of "self-evolving": the human-facing pruning page.**

v0.4.0/v0.4.1 gave you the evolution loop (tiered approval, reinforcement, anti-bloat convergence, background review). v0.4.2 closes the loop on the *human* side — there was previously no UI to act on prune candidates, only back-end tools. You can now prune from the settings page:

- **Soft-delete (reversible).** Forgotten memories get a `forgottenAt` tombstone and disappear from recall / injection / crystallization, but stay in the store until you restore them. The MEMORY.md mirror gets a separate "## Forgotten (recoverable)" section so they never silently mix with active memories.
- **`pinned` — three-tier protection.** Pin a memory and it is locked from every code path: never enters prune candidates, never overwritten by near-duplicate reinforcement, never deleted without an explicit `confirm=true`. The protection lives in the data layer (one of the two places every delete goes through), so it holds regardless of whether the delete came from the panel, a tool call, or a future code path.
- **Protected-kind review area.** `preference` and `decision` memories are *not* direct-deleteable — the panel shows them in a read-only "Protected records (special review needed)" section rather than giving a button that does nothing.
- **Heat is a read-only ordering signal.** Each memory gets a power-law coldness score `H = 1 / (1 + λ·Δt)^α`. Time basis is `accessedAt || createdAt` — **never `updatedAt`** (a dsh-mneme upstream bug we explicitly avoid). Heat only orders prune candidates; it never archives anything automatically.
- **Two-stage panel: preview → execute.** Stage 1 (`POST /prune/preview`) builds an in-memory plan and returns a `planDigest`. Stage 2 (`POST /prune/execute`) consumes it. The plan registry uses **atomic claim** (synchronous consumed-flag flip *before* the applyPlan `await`) so double-click / retry / resend cannot re-execute — without it, `skill-converge` would create duplicate umbrella skills under load.
- **Per-target ETag staleness check.** Each target carries the etag it had at preview time. If something else mutates it before execute, that target is skipped (not-found / stale) with a reason; the rest of the plan still applies. No whole-plan failure.
- **JSONL audit, fail-open + amortized ring-trim.** Every run is appended to `.evolve-audit.jsonl` (500-row cap). The audit write is *fail-open* — a disk error warns, never blocks the prune.

A2 layout in the settings page: **approval queue** (existing) at top, then the new **controlled-prune** block (candidates + preview/execute + protected area + forgotten list), then **overview** below. Pinned rows render their checkbox disabled.

Excluded by design: local vector models, semantic search, knowledge graphs. Heat pruning of this plugin is a re-read of dsh-mneme (MIT, attribution in source). All four pure-logic mechanisms adopted — heat, JSONL audit, two-stage preview→execute with registry, idle refresh — were cherry-picked because they add **zero new dependencies** and respect the "detect automatically, dispose explicitly" principle. The community is `chenzheshushi-commits/dsh-evolve` on GitHub; issue reports welcome.

---

---

## License

MIT
