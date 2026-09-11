// Repair DSH session logs that the v0->v1 format migrator refuses to load.
//
// WHEN YOU NEED THIS
// -----------------
// dsh-evolve <= 0.5.1 wrote plugin notice messages into the session log without
// the `summary` field that DSH's released-v0 format requires. Older harnesses
// (<= 0.1.0-rc.x) never validated it, so the logs looked fine. DSH 0.1.5-rc.2
// added a v0->v1 migration that validates every event on load, and now refuses
// the whole log:
//
//   failed to observe session "session-...": @deepseek-ai/dsh-session-format-v0-to-v1
//   refuses this format v0 Session: user/message 10 source summary must be a string
//
// Upgrading dsh-evolve stops NEW breakage; it cannot retroactively fix logs
// already on disk. Run this script once to repair the existing ones.
//
// USAGE
// -----
//   # inspect one session without writing anything
//   node scripts/repair-session-logs.mjs <in.jsonl.zstd> <out.jsonl.zstd> --dry
//
//   # scan and repair every session in place (backs each file up first)
//   node scripts/repair-session-logs.mjs --all ~/.dsh/sessions
//   node scripts/repair-session-logs.mjs --all ~/.dsh/sessions --dry
//
// Stop the harness first (`systemctl --user stop dsh.service`, or however you
// run it) so nothing writes while the logs are rewritten.
//
// WHAT IT REPAIRS
// ---------------
//   1. plugin notice sources missing `summary`      -> inject a summary string
//   2. unknown historical event types               -> rewrite the envelope to a
//      known no-op type (feedback/record), preserving the original payload as
//      text. Events cannot simply be dropped: seq is DENSE (the decoder demands
//      seq === runningEventCount), so deleting one breaks every later event.
//   3. subagent/descriptor version < 3              -> bump to 3 when the
//      payload already satisfies the v3 shape
//
// The container layout is preserved exactly: a session log is CONCATENATED zstd
// frames (frame 0 = exactly one header line, each later frame = one batch), not
// a single zstd stream. Recompressing the whole file as one frame makes the
// harness refuse it with "first frame is not exactly one header line".
//
// REQUIRES Node >= 22 (node:zlib gained the zstd APIs in 22.15/23; Node 20 has
// no zstd support at all and this script cannot run there).
import { readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";

const { constants, zstdCompressSync, zstdDecompressSync } = zlib;
if (typeof zstdCompressSync !== "function" || typeof zstdDecompressSync !== "function") {
  console.error(
    `this script needs Node's zstd support in node:zlib, which ${process.version} does not have.\n` +
    "Run it with Node >= 22 -- the same runtime that runs your harness, e.g.\n" +
    "  ~/.local/node22/bin/node scripts/repair-session-logs.mjs --all ~/.dsh/sessions --dry",
  );
  process.exit(3);
}

const ZSTD_MAGIC = 0xfd2fb528;
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

// Envelope keys the released-v0 format admits (EVENT_REQUIRED + optional).
const ALLOWED_ENVELOPE_KEYS = new Set([
  "type", "seq", "time", "data", "ignorable", "surfaceOp", "sourceEventSeqs",
]);

// Event types this build's migrator knows. Anything else is refused outright,
// even with ignorable:true, so it must be rewritten rather than tolerated.
const KNOWN_V0_TYPES = new Set([
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided",
  "approval/policy", "assistant/chunk", "assistant/message", "command/done", "command/run",
  "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
  "feedback/record", "goal/change", "hook/invoked", "hook/result", "llm/retry",
  "llm/retry-started", "model/selection", "permission/preset", "plan/mode",
  "request/context", "request/header", "sandbox/mode", "schedule/change",
  "session-log-deepseek/delivery-accepted", "session/end-seed", "session/title",
  "session/title-llm-request", "step/end", "step/start", "subagent/descriptor",
  "subagent/model-selection-policy", "team/member", "team/message/delivered",
  "team/message/queued", "team/task", "todo/write", "tool-workflow/agent-end",
  "tool-workflow/agent-start", "tool-workflow/run-end", "tool-workflow/run-start",
  "tool/call", "tool/code-dispatch", "tool/code-dispatch-start", "tool/result",
  "turn/end", "turn/start", "user/message", "web/deepseek-search-llm-request",
]);

// Packed assistant-chunk run rows: decoded by a separate codec path, never
// validated as events. Leave them completely alone.
const PACKED_TAGS = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
      throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** Repair one parsed event row in place. Returns a repair tag, or null if untouched. */
function repairEvent(o, frameIndex) {
  const type = o.type;
  if (typeof type !== "string") return null;
  // Packed runs use a different envelope (seq0/time0) and a separate codec
  // path that never runs event validation -- leave them untouched.
  if (PACKED_TAGS.has(type)) return null;

  for (const key of Object.keys(o))
    if (!ALLOWED_ENVELOPE_KEYS.has(key))
      throw new Error(`frame ${frameIndex} seq ${o.seq}: unexpected envelope key ${key}`);

  // Class 2: unknown historical event type -> known no-op carrying its payload.
  if (!KNOWN_V0_TYPES.has(type)) {
    const carried = JSON.stringify(o.data ?? null);
    o.type = "feedback/record";
    o.data = { text: `[migrated ${type}] ${carried}` };
    delete o.surfaceOp;        // feedback/record is not a surface event
    delete o.sourceEventSeqs;
    o.ignorable = true;
    return `unknown-type:${type}`;
  }

  const data = o.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;

  // Class 3: stale subagent descriptor version.
  if (type === "subagent/descriptor" && data.version !== 3) {
    const before = data.version;
    if (typeof before !== "number" || !Number.isInteger(before) || before < 0)
      throw new Error(`seq ${o.seq}: descriptor version is not a count: ${JSON.stringify(before)}`);
    // v3 shape check: continuable needs a non-empty label; agentProvider/agentModel paired.
    if (data.mode !== "one-shot") {
      if (data.mode !== "continuable")
        throw new Error(`seq ${o.seq}: descriptor mode ${JSON.stringify(data.mode)} not migratable`);
      if (typeof data.label !== "string" || data.label.length === 0)
        throw new Error(`seq ${o.seq}: continuable descriptor lacks a label`);
    }
    if ((data.agentProvider === undefined) !== (data.agentModel === undefined))
      throw new Error(`seq ${o.seq}: descriptor agentProvider/agentModel unpaired`);
    if (typeof data.provider !== "string" || data.provider.length === 0)
      throw new Error(`seq ${o.seq}: descriptor lacks provider`);
    data.version = 3;
    return `descriptor:${before}->3`;
  }

  // Class 1: plugin notice source missing a string summary.
  const src = data.source;
  if (src !== null && typeof src === "object" && !Array.isArray(src)
      && src.form === "notice" && typeof src.summary !== "string") {
    const plugin = typeof src.plugin === "string" ? src.plugin : "plugin";
    src.summary = `${plugin} 通知`;
    return `notice-summary:${plugin}`;
  }

  return null;
}

/**
 * Repair one session log buffer.
 * @returns {{ result: Buffer, frames: number, rows: number, patched: number, repairs: Record<string,number> }}
 * @throws if the container is torn or the product fails self-verification
 */
function repairSessionLog(raw) {
  const { frames, tornStart } = scanZstdFrames(raw);
  if (tornStart !== undefined) throw new Error(`refusing to rewrite: torn final frame at ${tornStart}`);

  const repairs = {};
  let patched = 0;
  const out = [];
  for (const [i, f] of frames.entries()) {
    const plain = zstdDecompressSync(raw.subarray(f.start, f.end));
    if (plain.length === 0 || plain.at(-1) !== 10)
      throw new Error(`frame ${i} does not end on a newline`);
    if (i === 0) {
      if (plain.indexOf(10) !== plain.length - 1)
        throw new Error("frame 0 is not exactly one header line");
      out.push(zstdCompressSync(plain, CHECKSUM_OPTIONS));   // header frame: never touched
      continue;
    }

    const text = plain.toString("utf8");
    const lines = text.split("\n");
    let frameDirty = false;
    for (let k = 0; k < lines.length; k++) {
      if (!lines[k]) continue;
      let o;
      try { o = JSON.parse(lines[k]); } catch { continue; }
      const tag = repairEvent(o, i);
      if (tag === null) continue;
      lines[k] = JSON.stringify(o);
      repairs[tag] = (repairs[tag] ?? 0) + 1;
      patched++;
      frameDirty = true;
    }
    out.push(zstdCompressSync(Buffer.from(frameDirty ? lines.join("\n") : text, "utf8"), CHECKSUM_OPTIONS));
  }

  const result = Buffer.concat(out);

  // self-verify the product before it is allowed anywhere near the original:
  // container shape, dense-seq invariant, and zero residual offenders.
  const check = scanZstdFrames(result);
  if (check.tornStart !== undefined) throw new Error("product has a torn frame");
  if (check.frames.length !== frames.length)
    throw new Error(`frame count changed: ${frames.length} -> ${check.frames.length}`);
  const h = zstdDecompressSync(result.subarray(check.frames[0].start, check.frames[0].end));
  if (h.indexOf(10) !== h.length - 1) throw new Error("product frame 0 is not exactly one header line");

  let residual = 0, seq = 0, rows = 0;
  for (const [i, f] of check.frames.entries()) {
    const p = zstdDecompressSync(result.subarray(f.start, f.end)).toString("utf8");
    for (const line of p.split("\n")) {
      if (!line) continue;
      const o = JSON.parse(line);
      if (i === 0) continue;
      rows++;
      // dense-seq invariant: packed run rows carry seq0 (not seq) and advance the
      // running count by their payload length (one event per chunk member).
      if (PACKED_TAGS.has(o.type)) {
        if (o.seq0 !== seq) throw new Error(`product seq gap at run: expected ${seq}, got ${o.seq0}`);
        const members = o.type === "tool-call-chunks" ? o.data?.args : o.data?.texts;
        if (!Array.isArray(members) || members.length === 0)
          throw new Error(`product run at seq0 ${o.seq0} has no payload members`);
        seq += members.length;
        continue;
      }
      if (o.seq !== seq) throw new Error(`product seq gap: expected ${seq}, got ${o.seq}`);
      seq += 1;
      if (!KNOWN_V0_TYPES.has(o.type)) residual++;
      const s = o.data?.source;
      if (s && typeof s === "object" && s.form === "notice" && typeof s.summary !== "string") residual++;
      if (o.type === "subagent/descriptor" && o.data?.version !== 3) residual++;
    }
  }
  if (residual !== 0) throw new Error(`product still has ${residual} offending rows`);

  return { result, frames: frames.length, rows, patched, repairs };
}

/** Collect every `<root>/<project>/<session-*>/session.jsonl.zstd`. */
function findSessionLogs(root) {
  const found = [];
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project);
    let st; try { st = statSync(projectDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const session of readdirSync(projectDir)) {
      const file = join(projectDir, session, "session.jsonl.zstd");
      try { if (statSync(file).isFile()) found.push(file); } catch { /* not a session dir */ }
    }
  }
  return found.sort();
}

const USAGE = `usage:
  node scripts/repair-session-logs.mjs <in.jsonl.zstd> <out.jsonl.zstd> [--dry]
  node scripts/repair-session-logs.mjs --all <sessions-root> [--dry]

Stop the harness first so nothing writes while the logs are rewritten.
--all repairs in place and backs each modified file up to <file>.bak.<timestamp>.`;

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const positional = argv.filter((a) => a !== "--dry" && a !== "--all");

if (argv.includes("--all")) {
  const root = positional[0];
  if (!root) { console.error(USAGE); process.exit(2); }
  const files = findSessionLogs(root);
  console.log(`scanning ${files.length} session log(s) under ${root}${dry ? " (dry run)" : ""}`);
  const totals = {};
  let repaired = 0, clean = 0, failed = 0;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  for (const file of files) {
    const label = file.split("/").slice(-2)[0];
    let outcome;
    try { outcome = repairSessionLog(readFileSync(file)); }
    catch (error) { failed++; console.error(`  FAIL  ${label}: ${error.message}`); continue; }
    if (outcome.patched === 0) { clean++; continue; }
    for (const [k, v] of Object.entries(outcome.repairs)) totals[k] = (totals[k] ?? 0) + v;
    if (!dry) {
      copyFileSync(file, `${file}.bak.${stamp}`);
      writeFileSync(file, outcome.result);
    }
    repaired++;
    console.log(`  ${dry ? "WOULD FIX" : "FIXED"}  ${label}  ${outcome.patched} event(s)  ${JSON.stringify(outcome.repairs)}`);
  }
  console.log(JSON.stringify({ scanned: files.length, repaired, alreadyClean: clean, failed, repairs: totals, wrote: !dry }));
  if (failed > 0) process.exit(1);
} else {
  const [src, dst] = positional;
  if (!src || !dst) { console.error(USAGE); process.exit(2); }
  const raw = readFileSync(src);
  const outcome = repairSessionLog(raw);
  if (!dry) writeFileSync(dst, outcome.result);
  console.log(JSON.stringify({
    src: src.split("/").slice(-2)[0], frames: outcome.frames, rows: outcome.rows,
    patched: outcome.patched, repairs: outcome.repairs,
    bytesIn: raw.length, bytesOut: outcome.result.length, wrote: !dry,
  }));
}
