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
| `tar` on PATH | Required for skill rewrites that need a rollback snapshot. A failed backup aborts refine/fold instead of risking an unrecoverable overwrite. |
| Linux / macOS / Windows | Developed on Linux; CI runs the full suite on Linux **and** Windows. Windows needs `git`/`tar` on PATH for the optional checkpoint and rollback features — the plugin skips them rather than failing when they are absent. (v0.6.0 and earlier threw `EPERM` on Windows the moment a skill proposal was written; fixed in v0.6.1.) |

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
dsh plugin --profile web add "https://github.com/chenzheshushi-commits/dsh-evolve/releases/download/v0.6.5/dsh-evolve-0.6.5.tgz"
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

Curation runs a real lifecycle: `active` → `stale` → `archived`. Archiving moves a skill out of
the active catalog and is reversible. Content rewrites require a successful backup first; archive
and restore are reversible directory moves. The plugin never automatically physically deletes assets.

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

## What's new in v0.6.5 — The config guard now asks the store, not the route

v0.6.5 is a patch release with **no production code changes**. It fixes one test that
claimed more than it checked.

A review of v0.6.4 reproduced every claim that release made (32 mutations, 27/27 red
where expected; 8 quoted numbers plus 3 floors all recomputed) and then showed that
the guard v0.6.4 was proudest of does not catch the defect it exists for:

```
lib/index.js:279   config: cfg  ->  config: { ...cfg }
                   (the store gets a snapshot; the settings page silently stops working)

  config-liveness.test.mjs   4/4 pass      <- missed it
  all 326 contract tests     0 fail        <- missed it
  all four e2e suites        pass          <- missed it
```

Both `/state` and the `set-config` reply render from `readConfigView(getConfig())` —
the same object `setConfig` writes. Asserting on either only proves the route echoes
its own patch. The mechanism test v0.6.4 deleted did catch this shape, so on that one
axis v0.6.4 was a regression, and the release notes said the opposite.

The store now answers for itself: the test tightens `maxPendingQueue` to 1 through the
real route, then calls the registered `memory_remember` tool twice. `store.remember()`
enforces that cap by reading `this.config.maxPendingQueue` (`store.js:399`) and
returns null once the queue is full, so the second write must be refused. A store
holding a construction-time copy still believes the cap is 50 and accepts it.

Measured: the snapshot defect goes red, assigning onto a copy goes red, reverting the
store to a constructor snapshot fails three assertions, and the equivalent refactor
(per-key assignment instead of `Object.assign`) stays green.

All four of those debts are paid in v0.7.0: `reconcile()` forwards `durability` and
`unflushed` into its report, `fsyncTree` reports the outcome of every directory flush,
no gate in `scripts/schema/` judges adjacency by character count any more, and the
`publish-protocols.js` comment now describes what the code does.

---

## What's new in v0.6.4 — Guards judged by behaviour, everywhere

v0.6.4 is a patch release, acting on a review of v0.6.3 that reproduced every claim
that release made (15/15 mutations red, 8/8 quoted numbers recomputed) and then found
where the new guards stopped short.

- **`EROFS` was a dead branch that inverted its own intent.** It was listed in
  `NOT_WRITABLE` but not in `FSYNC_SOFT_FAIL`, and the rethrow guard runs first — so
  the one code most literally meaning "this object is read-only" was the one code that
  threw, aborting all three publish protocols. Exactly backwards from the v0.6.3 fix.
  Reachable on read-only mounts and `--read-only` containers. `EROFS` now soft-fails,
  and the subset invariant is enforced **at module load**, not by a test: a member that
  cannot be classified is a contradiction inside the file. Putting `ENOSPC` in
  `NOT_WRITABLE` — marking a real failure as a permissions quirk — now refuses to load.
- **The config guard failed correct refactors.** It matched
  `/Object\.assign\(\s*(\w+)\s*,/` against `index.js` and compared identifiers, so
  rewriting one line as `for (const [k,v] of Object.entries(patch)) cfg[k] = v` —
  byte-for-byte identical behaviour — went red, while the real defect was caught only
  as a side effect of a `>= 2` count. A guard that fails correct work teaches people to
  ignore red. It now POSTs the actual `set-config` action to the actual route and reads
  the actual store; measured: the equivalent refactor passes, assigning onto a copy
  fails.
- **Four blind spots in the fsync scan, all measured.** Double-quoted `openSync(p, "r")`
  was invisible (quote style is not semantics); a computed mode was treated as
  compliant rather than unjudgeable; the flush had to appear within 400 characters,
  while this repo already has single-line modules wider than that; and discovery only
  read the top level of `lib/`, so any future `lib/ops/` would be uncovered. Now:
  quotes normalised, computed modes reported, scope-based lookahead, recursive scan.
- **The one runtime proof could be switched off silently.** Making the read-only probe
  return `false` turned the only non-source-text evidence into a permanent skip, and a
  skip is not a failure. A skip now has to be justified by the environment.
- **`fsyncTree` no longer returns an always-true `ok`** — a field named `ok` invites
  `if (!ok) abort` that never fires — and the `durability` note stamped on a marker now
  reaches the reconcile verdict instead of having no reader at all.
- `budgetStatus`'s effective-count contract, previously only a comment, is asserted;
  the `search.js` floor comment said 0.5 where the implementation says 0.6.

Retrieval precision is unchanged and still tracked as issue #2.

---

## What's new in v0.6.3 — Finishing what v0.6.2 claimed, and undoing one regression

v0.6.3 is a patch release. It acts on a review of v0.6.2 that found the previous
release had **shipped a claim that was not true**, and had introduced one regression.

- **The last path-level fsync is gone, and the gate can now see it.** v0.6.2 said
  `lib/fsync.js` was "the only place a path is opened in order to be flushed, and a
  test refuses any other module doing it". `lib/skills.js` still had one, on the
  skill-writing path. The gate's regex used `[^)]*?`, which cannot cross a nested
  call, so `openSync(dirname(file), 'r')` read as compliant — hoisting that argument
  into a local variable, changing nothing else, made the same gate go red. Argument
  splitting is now bracket-balanced, and a test feeds it four spellings including
  two levels of nesting. That line was also the only fsync in the tree that
  swallowed every error, including a real ENOSPC.
- **A read-only file no longer fails a publish.** v0.6.2 refused to publish whenever
  any file declined to flush, so one `0444` file inside a skill tree broke
  crystallize / refine / rollback outright. That conflated two different events: a
  platform that does not support this kind of fsync, and a file that is read-only.
  Neither means the bytes are missing — the data is written and closed before the
  flush is attempted, and the marker's load-bearing property is that it is written
  *last*, not that every fsync succeeded. `fsyncFile` now reports *which* kind of
  refusal happened, and a degraded publish is recorded on the marker
  (`durability: 'partial'` plus the file list) and logged, instead of aborting.
- **The runtime proof runs on Windows now.** The one assertion that proves `'r+'`
  without reading source text was skipped on win32 with the comment "Windows ignores
  chmod on the write bit". That is false — measured on Windows 11 / node 22.22.3,
  `chmod 0o444` maps to `FILE_ATTRIBUTE_READONLY` and `openSync('r+')` fails with
  EPERM. It now probes whether the filesystem enforces the bit and skips only when it
  genuinely does not (root, FAT/exFAT).
- **The retrieval measurements were the wrong quantity.** The floor is compared
  against `base` (search.js:236); the numbers quoted in v0.6.1/v0.6.2 (1.41, 1.47,
  3.07) were *return* scores, after three multipliers. Re-derived as `base`: the real
  hit is **0.8393**, the near-tie false positive **0.8065** (so that pair *is*
  separable, contrary to the old claim), and the unrelated record **1.7541** — more
  than double the real hit. That last one is why no floor can fix this, and it is now
  what the ratchet asserts. Previously the ratchet went red on "the real hit was
  killed", which a floor change triggers while leaving the hole wide open.
- **Config wiring is asserted, not just its mechanism.** The store holding a live
  object was tested; that the host hands it the same object every write path mutates
  was only confirmed by reading three lines of `index.js`. Now asserted.
- **`injectionCount` has one definition again.** The budget tie-break read the
  persisted field while the rest of the store used the effective count.

Retrieval precision itself is unchanged and still tracked as issue #2.

---

## What's new in v0.6.2 — The guards get judged by behaviour, not by wording

v0.6.2 is a patch release: no new features, no retrieval behaviour change. It acts
on an external review of v0.6.1 that attacked the *guards* added in that release and
got past two of them.

- **All fsync logic now lives in one module.** Four copies existed, and two of them
  were missing `ENOTSUP` from the soft-fail list, so the same unsyncable filesystem
  made the transaction layer throw while the proposal layer shrugged. `lib/fsync.js`
  is now the only place a path is opened in order to be flushed, and a test refuses
  any other module doing it — discovered by scanning `lib/`, never a hand-written
  list, because a hand-written list left a brand-new module with the identical bug
  completely unread. (v0.6.2 shipped this claim while `lib/skills.js` still held one
  such fsync that the gate's regex could not see; fixed in v0.6.3.)
- **The guard no longer trusts variable names.** It used to decide "is this a file
  or a directory?" by regex-matching the identifier, so renaming a parameter to
  `dir` while reverting `'r+'` to `'r'` restored the original Windows bug with every
  test still green. The rule is now checked at the call site, and separately proved
  at runtime: on a read-only file `'r+'` cannot be opened at all, so a helper that
  had slipped back to `'r'` reports success where the real one reports refusal.
- **A failed flush can no longer be published as a success.** `fsyncTree` returns
  which files refused, and all three publish protocols check it before writing the
  commit marker. The marker's entire meaning is "these bytes are on disk"; writing
  it after a refused flush is a lie that recovery later trusts. On Windows this is
  observable rather than silent for the first time.
- **Governance limits are adjustable while running.** `store.js` copied the config
  object at construction, so lowering `maxPendingQueue` from 50 to 10 in the
  settings page returned 200, `/state` showed 10, and the flood defence kept
  admitting 50 until the process restarted. The store now holds the host's own
  object. Reported by two consecutive reviews before it was fixed.
- **A misleading comment and two flattering assertions are corrected.**
  `lib/search.js` claimed unrelated records "score exactly 0 — a wide safety gap".
  They score 1.41. The two `smoke.mjs` precision assertions that appeared to guard
  that gap pass only because their fixture happens to omit the shared 2-gram, and
  now say so and point at the failing `test.todo` that records the real state.
- **The gates' Python dependencies are declared in the repository.** They existed
  only inside the CI workflow, so `test:contracts` on a fresh clone died with
  `ModuleNotFoundError` — and the reason `rfc3339-validator` is load-bearing rather
  than optional was knowledge trapped in a yml file. Now
  `scripts/schema/requirements.txt`, which CI installs from, so the pins cannot
  drift apart.
- **`files` no longer declares a directory that does not exist** (`assets`).

Six mutations were run against the rewritten guards, including the two the review
used to defeat them; every one turns a guard red.

---

## What's new in v0.6.1 — Windows platform fix and cross-OS CI

v0.6.1 is a patch release: no new configuration, no behaviour change on Linux or macOS.
It fixes one platform bug and closes the verification gap that let it ship.

- **Skill proposals no longer throw on Windows.** `ProposalStore.create()` fsynced
  its files through an `O_RDONLY` handle and fsynced directories with no guard.
  Windows `FlushFileBuffers` requires write access, so it raised `EPERM` — and since
  `create()` is the single entry point of the proposal pipeline, `skill_rollback` and
  every crystallize/refine/fold/converge in the **default** `manual`/`balanced` modes
  threw instead of returning `{proposed:false, reason}`. Files now open `r+`; directory
  fsync failures soft-fail through the same code list the transaction layer already
  used (`EINVAL`/`EACCES`/`EPERM`/`EISDIR`/`ENOTSUP`).
- **`fsyncTree` actually flushes files again.** It synced regular files through the
  directory helper, whose soft-fail list swallowed the resulting `EPERM`. On Windows
  the files were therefore never flushed — silently, which is worse than the throw,
  because protocol C/D recovery treats a written marker as proof the tree is durable.
- **CI exists.** A `ubuntu-latest` + `windows-latest` matrix runs typecheck, build,
  the full suite and the contract gates. v0.6.0 was green on 303 tests on one Linux
  machine and still shipped the bug above; nothing short of a second OS would have
  caught it.
- **The built client is gated, not hand-checked.** `lib/client.js` is a committed
  artifact and `files` ships only `lib/`, so CI rebuilds and diffs it. A stale
  artifact used to be caught only by remembering to run one command before tagging.
- **A known retrieval hole is now visible instead of implied.** A precision red-line
  in `smoke.mjs` passed only because its fixture happened not to contain the shared
  2-gram it was guarding against; phrased the ordinary way, an unrelated query
  false-matches. It is recorded as a failing `test.todo` in
  `scripts/schema/f3-precision-hole.test.mjs` with the measurements showing why a
  threshold change alone cannot fix it. Retrieval behaviour is **unchanged** in this
  release — the fix lands in v0.7.0 with recall/MRR evidence.

---

## What's new in v0.6.0 — Tidy memory and governed skill evolution

v0.6.0 adds the missing safety half of self-evolution: automation may act, but every
non-trivial write has a deterministic boundary and a recovery path.

- **Tidy disposal tier.** `manual | suggest | tidy` now share one eligibility rule.
  Tidy automatically soft-deletes at most `tidyMaxPerRun` ordinary, low-importance
  memories that have never been recalled or injected and have passed the cool-off.
  Pinned, importance-3, preference, decision, pending and rejected records are
  never automatic subjects. Soft-deleted records remain visible and restorable.
  **No tier physically deletes memory. Tombstone GC is not part of v0.6.0.**
- **Durable operations with recovery.** Every skill mutation runs as a transaction
  with a manifest, a write-ahead log and a single commit point, so an interruption
  leaves a state the next start can finish rather than a half-written skill.
  Publishing uses the protocol the change actually needs — a new directory is one
  rename, a body rewrite commits the operation id inside the file it rewrites, a
  rollback goes through a retired intermediate, and an archive is a pure move.
  Cross-filesystem moves fail closed instead of degrading to copy-then-delete.
- **An exit from stuck operations.** A conflict or a partially-completed merge is
  frozen rather than guessed at, keeps its authorization so nothing else can touch
  the same target, and appears in the settings page for a roll-forward or roll-back
  decision. After the commit point nothing rolls back: a converge whose second
  source could not be archived reports the partial state and keeps the live merge,
  because "cleaning up" would destroy work that already succeeded.
- **Archives addressed by id.** Several archives of one skill coexist, each with a
  timestamped `archiveId`, and restore names the generation it wants. `skill_rollback`
  now only ever creates a proposal, and pins the chosen backup by content hash at
  proposal time so a later backup cannot change what comes back.
- **Skill proposals.** In manual and balanced modes, crystallize/refine/fold/converge
  create a proposal instead of changing the live catalog. The settings page is the
  only apply/reject surface; model tools cannot approve their own work. Select an
  explicit autonomous `skillProposalMode` if you want immediate writes after all
  safety checks.
- **Stale and ownership protection.** Proposal apply binds independent SHA-256
  hashes for prose and semantic state. Any human edit or competing mutation makes
  the proposal stale with zero overwrite. Skills are bound to a random per-install
  owner id; legacy skills require an explicit claim in the Web panel.
- **One mutation throat.** Model tools, Web actions, rollback and automatic archive
  all pass structured ownership, policy, size, secret, backup and receipt gates.
  Automatic skill bodies are capped at 10,000 characters; human paths at 40,000
  by default. An already oversized skill can only be rewritten smaller.
- **Secret persistence guard.** Strong GitHub/AWS/OpenAI/Anthropic/Slack/Bearer/PEM
  patterns are blocked before memory, skill, mirror or Git persistence. Source
  context and audit fields are redacted; incidents store only hashes and masked
  snippets, never the original token. Ordinary prose about “password” or “token”
  remains valid knowledge. Approving a quarantined finding binds to the exact
  occurrences reviewed — including repeated copies — plus the scanner and
  normalization versions, so a re-scan that finds more cannot be waved through by
  an older approval.
- **Objective background review.** Review requires substantial foreground work.
  Completed/interrupted turns qualify; error/blocked/aborted turns do not. State is
  isolated per session, and successful skill-tool use issues short-lived,
  single-use receipts for autonomous refine/fold/converge.
- **Optional turn-open approval.** When enabled, a direct high-value
  `memory_remember` can ask yes/no inside the active turn. This deliberately does
  **not** cover background review: that runs after `turn/end`, where DSH forbids an
  approval request. Background suggestions continue to use the settings review
  queue. The popup is off by default and limited to one per turn by default.
  Cancelling or dismissing leaves the memory pending — an unanswered prompt is not
  consent — and declining reports the memory as rejected rather than saved.
- **Web replay protection.** Privileged Web actions use short-lived, same-origin,
  single-use capabilities. This is CSRF/replay protection and an audit anchor; it
  is not presented as proof that a human clicked. Retrying the same operation id
  replays its receipt instead of being refused, so a client that lost its response
  is never pushed into publishing the same change twice.

Operational boundaries:

- Two processes may point at one evolve workspace without corrupting it: the first
  takes an instance lock and the second degrades to read-only for automatic work —
  tidy lists candidates instead of deleting them, and pruning refuses. A lock left
  by a crashed process is reclaimed as soon as that process is gone, not after a
  timeout. Running one DSH instance per workspace is still the recommended setup.
- There is an unavoidable, very small POSIX window between the final stale check
  and atomic rename. Do not hand-edit the same skill while an apply is in flight.
- The plugin still ships blank; no memory, proposal, incident or owner id is in the
  package. Runtime JSONL/proposal/operation files are excluded from workspace Git.

### New configuration

| Key | Default | Effect |
|---|---:|---|
| `disposalMode` | `manual` | `manual`, `suggest`, or recoverable `tidy` |
| `tidyMaxPerRun` | `5` | Maximum automatic soft-deletes per idle run |
| `idleMinutes` | `5` | Idle delay for suggest/tidy |
| `skillProposalMode` | `inherit` | Follow memory approval mode or explicitly select a skill mode |
| `skillAutoMaxChars` / `skillMaxChars` | `10000` / `40000` | Automatic/human skill-body limits |
| `approvalPromptEnabled` | `false` | Ask in-turn for direct high-value memory writes |
| `approvalPromptMaxPerTurn` | `1` | Popup budget per session turn |

---

## What's new in v0.5.2

**Fix: injected notices no longer make DSH refuse to load the session history.**

Every message this plugin injects (memory recall, the always-on preference snapshot, checkpoint and nudge notices) is tagged `source.form: 'notice'`. DSH's released-v0 session format requires a `notice` source to also carry a string `summary`; this plugin never set it. Harnesses up to `0.1.0-rc.x` did not validate that field, so the logs looked fine — but **DSH `0.1.5-rc.2` added a v0→v1 migration that validates every event on load and refuses the entire log**:

```
failed to observe session "session-…": @deepseek-ai/dsh-session-format-v0-to-v1
refuses this format v0 Session: user/message 10 source summary must be a string
```

The result is `历史加载失败` / "history failed to load" on every conversation this plugin ever injected into — which, with Tier 1 always-on, is effectively all of them.

- All 8 injection sites now set a short `source.summary`. No behaviour, config, or API change; the summary is metadata DSH shows when a notice is collapsed.
- **Upgrading fixes new sessions only.** Logs already written are still on disk with the missing field, and the harness still refuses them. To repair those, see below.

### Repairing session logs written by v0.5.1 and earlier

`scripts/repair-session-logs.mjs` rewrites the offending events in place. Stop the harness first, then:

```bash
# see what would change, without writing
node scripts/repair-session-logs.mjs --all ~/.dsh/sessions --dry

# repair in place (each modified log is backed up to <file>.bak.<timestamp>)
node scripts/repair-session-logs.mjs --all ~/.dsh/sessions
```

Requires **Node ≥ 22** — it needs the zstd support in `node:zlib` that Node 20 lacks. Use the same runtime your harness runs on (e.g. `~/.local/node22/bin/node`).

It is safe to re-run: repairs are idempotent, event count and `seq` numbering are preserved exactly (a session log's `seq` is dense, so nothing is ever deleted — only rewritten), and the concatenated-zstd-frame container layout is kept intact. The script self-verifies its own product and refuses to write if anything is off.

Besides the missing `summary`, it also repairs two unrelated refusals in the same pass, in case your logs have them: unknown historical event types written by other plugins (rewritten to a known no-op type, original payload preserved as text — note that DSH `0.1.5-rc.2` no longer accepts these even when marked `ignorable`), and `subagent/descriptor` events still on version 2.

---

## What's new in v0.5.1

**Fix: the always-on preference snapshot now reaches every new conversation.**

The Tier 1 always-on snapshot — the durable user preferences/facts block injected at the start of each turn — was deduplicated with a **process-global** last-key. Because durable preferences rarely change, the snapshot text stayed identical, so after the *first* conversation injected it, **every later conversation's first turn was silently suppressed** and never received the block at all. The per-step relevant-recall injector had the same class of cross-session leak on its repeat-suppressor.

- **Dedupe is now per-session**, keyed by the session via a `WeakMap`. Each new conversation gets the always-on block on turn 1; within a single conversation an unchanged snapshot is still skipped (the prompt-cache protection that dedupe was meant to provide is preserved). The `WeakMap` is reclaimed with the session — no manual cleanup, no leak.
- Regression test drives the real `apply(ctx)` with two independent sessions and asserts both the cross-session injection and the within-session suppression. Retrieval baseline unchanged (5/5 recall, MRR 1.0, R6 drift 0).

No config or API changes; no migration.

---

## What's new in v0.5.0

**Autonomy becomes a user-chosen dial, and Chinese retrieval is fixed at the root.**

Earlier versions hard-wired how much the memory could decide on its own. v0.5.0 makes that a product setting, on both the ingest and the disposal side — deliberately asymmetric, because an ingestion mistake is an *addition* (visible) while a disposal mistake is a *subtraction* (invisible).

### Ingestion autonomy — `approvalMode` (three tiers)
- **`manual`** — every model write waits for your confirm. **`balanced`** (default) — reversible writes that are anchored to a literal user utterance *or* near-duplicate of a confirmed memory auto-confirm; everything else is pending. **`autonomous`** — any reversible, non-conflicting write auto-confirms.
- **`autonomous` still forces conflicts and high-importance (imp 3) memories to pending** — the tier split sits *after* the conflict/importance scan, so it's a structural guarantee, not a fragile `if`.
- **Bounded so it can't flood the store:** at most `reviewMaxAutoPerTurn` auto-confirms per background-review turn (rest fall to pending), and a hard `maxPendingQueue` cap on the one region that can be losslessly refused. Confirmed memory is char-budget bound, pending is count-bound — neither pool grows without limit.
- Background review can no longer take the `anchored` auto-confirm shortcut on its own say-so (`anchoredToUser` is caller/store-derived, never model self-report).

### Disposal autonomy — `disposalMode` (two tiers)
- **`manual`** (default) — nothing proposed automatically. **`suggest`** — when idle, recompute and surface low-value candidates for your review. **Zero auto-deletion in any tier** — heat stays a read-only ordering signal, physical deletion is never automatic; you still act on candidates through the two-stage prune panel.
- Candidate rule is **objective and non-heat**: never injected *and* never recalled (both channels zero) + past an explicit cool-off (`disposalMinIdleDays`), excluding pinned / protected-kind / pending / recent. **Skills never enter any automatic tier** (fold/archive stay manual). The `tidy` tier (bounded auto soft-delete) is deferred to v0.6.x alongside tombstone GC.

### Retrieval (Chinese recall fixed)
- **R1/R2 — tokenizer bug fixed.** A greedy `{2,}` regex used to swallow an entire Chinese query into one token, so any multi-word paraphrase scored zero. Now runs match fully or fall back to down-weighted 2-gram fragments (stopword-filtered, capped), with a query-length-adaptive threshold. Recall up, precision held (adversarial false-match set stays at zero).
- **R3 — tags fold into the FTS index**, bridging part of the synonym gap at zero new dependency. **R5 — retrieval degradation is now visible** (fused vs bigram-only vs fts-degraded) instead of silently dropping quality. **R6 — extended CJK ranges** (Ext-A / Compatibility), verified to cause zero drift in the adjudicator's similarity thresholds on the real store (reproducible via `pnpm run test:baseline`).

### Observability / audit
- Background review runs land in the JSONL audit. Pending records carry the source-context snippet they were drawn from. The prune preview is tabular.

All new config is conservative by default (`balanced` / `manual`) — existing behavior is unchanged until you opt in via the two new blocks on the settings page.

---

## What's new in v0.4.2

**The missing half of "self-evolving": the human-facing pruning page.**

v0.4.0/v0.4.1 gave you the evolution loop (tiered approval, reinforcement, anti-bloat convergence, background review). v0.4.2 closes the loop on the *human* side — there was previously no UI to act on prune candidates, only back-end tools. You can now prune from the settings page:

- **Soft-delete (reversible).** Forgotten memories get a `forgottenAt` tombstone and disappear from recall / injection / crystallization, but stay in the store until you restore them. The MEMORY.md mirror gets a separate "## Forgotten (recoverable)" section so they never silently mix with active memories.
- **`pinned` — three-tier protection.** Pin a memory and it is locked from every code path: never enters prune candidates, never overwritten by near-duplicate reinforcement, never deleted without an explicit `confirm=true`. The protection lives in the data layer (one of the two places every delete goes through), so it holds regardless of whether the delete came from the panel, a tool call, or a future code path.
- **Protected-kind review area.** `preference` and `decision` memories are *not* direct-deleteable — the panel shows them in a read-only "Protected records (special review needed)" section rather than giving a button that does nothing.
- **Heat is a read-only ordering signal.** Each memory gets a power-law coldness score `H = 1 / (1 + λ·Δt)^α`. Time basis is `accessedAt || createdAt` — **never `updatedAt`** (merging / refining bumps `updatedAt` but that is not "access"; treating such a bump as decay would silently demote actively-used memory). Heat only orders prune candidates; it never archives anything automatically.
- **Two-stage panel: preview → execute.** Stage 1 (`POST /prune/preview`) builds an in-memory plan and returns a `planDigest`. Stage 2 (`POST /prune/execute`) consumes it. The plan registry uses **atomic claim** (synchronous consumed-flag flip *before* the applyPlan `await`) so double-click / retry / resend cannot re-execute — without it, `skill-converge` would create duplicate umbrella skills under load.
- **Per-target ETag staleness check.** Each target carries the etag it had at preview time. If something else mutates it before execute, that target is skipped (not-found / stale) with a reason; the rest of the plan still applies. No whole-plan failure.
- **JSONL audit, fail-open + amortized ring-trim.** Every run is appended to `.evolve-audit.jsonl` (500-row cap). The audit write is *fail-open* — a disk error warns, never blocks the prune.

A2 layout in the settings page: **approval queue** (existing) at top, then the new **controlled-prune** block (candidates + preview/execute + protected area + forgotten list), then **overview** below. Pinned rows render their checkbox disabled.

Excluded by design: local vector models, semantic search, knowledge graphs (too heavy for an optimization, not a rewrite). All four pure-logic mechanisms adopted — heat, JSONL audit, two-stage preview→execute with registry, idle refresh — were chosen because they add **zero new dependencies** and respect the "detect automatically, dispose explicitly" principle. The community is `chenzheshushi-commits/dsh-evolve` on GitHub; issue reports welcome.

---

## License

MIT
