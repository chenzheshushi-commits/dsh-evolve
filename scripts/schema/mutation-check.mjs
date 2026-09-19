/**
 * 门禁变异测试（v0.6.4 用例集）：把每个门禁对应的缺陷手动注入回去，看它是否真的变红。
 *
 * 目的：dsh-evolve 反复出现"看起来有门禁、实际没人守"的模式。一个绿着的测试
 * 只有在"注回缺陷就会红"时才算门禁，否则它只是装饰。
 *
 * ⚠ 自带基线校验：某个测试文件在"未变异"状态下不满足 fail=0，说明它根本没跑
 *   起来（路径错/导入失败），此时所有"变红"都是假阳性，脚本直接退出。
 *   三道防线：①基线必须绿 ②必须见到 `# tests N` ③报出首个失败断言名。
 *
 * 用例分三类：
 *   expectRed: true（默认）—— 装了缺陷就应该红，绿了说明门禁是装饰
 *   expectRed: false        —— 预期门禁覆盖不到；红了我反而要记（说明比预期好）
 *   另有两条标着 "红=假阳性"：它们注入的是**行为完全等价**的正确写法，红了说明
 *   门禁在按文本形状判定、会误杀正确重构。
 *
 * 用法: node mutation-check.mjs [仓库路径]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Default to the repository this file now lives in, rather than the absolute scratch
// path it was written against.
const REPO = (process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url))).replace(/[\\/]+$/, '');
const NODE = process.execPath;

function sh(args) {
  return execFileSync(args[0], args.slice(1), { cwd: REPO, encoding: 'utf8' });
}
function shQuiet(args) {
  try { return { out: sh(args), code: 0 }; } catch (e) { return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 }; }
}

/** 跑一个测试文件（相对 scripts/schema/），返回通过/失败/待办计数。 */
function runTest(file) {
  const rel = `scripts/schema/${file}`;
  const r = shQuiet([NODE, '--test', rel]);
  const num = (k) => Number((r.out.match(new RegExp(`# ${k} (\\d+)`)) ?? [0, 0])[1]);
  const started = /# tests \d+/.test(r.out);
  // 加载期抛错（例如模块顶层的不变式失败）不会有 `# tests`，但它是实实在在的门禁生效。
  const loadError = /Error:|Cannot find module|not ok \d+ -/m.test(r.out);
  return { pass: num('pass'), fail: num('fail'), todo: num('todo'), exit: r.code, started, loadError, raw: r.out };
}

/** 还原：git 跟踪的回 HEAD，新文件直接删。 */
function restore(paths) {
  for (const p of paths) {
    const tracked = shQuiet(['git', 'ls-files', '--error-unmatch', p]).code === 0;
    if (tracked) shQuiet(['git', 'checkout', 'HEAD', '--', p]);
    else { try { unlinkSync(join(REPO, p)); } catch { /* already gone */ } }
  }
}

function edit(rel, from, to) {
  const p = join(REPO, rel);
  const before = readFileSync(p, 'utf8');
  const after = before.replace(from, to);
  if (after === before) throw new Error(`变异未命中: ${rel} 里找不到 ${JSON.stringify(from.slice(0, 70))}`);
  writeFileSync(p, after);
}

const CASES = [];
function caseOf(c) { CASES.push(c); }

// ══════════ 一、被修缺陷回装（最有说服力：这套门禁到底拦不拦得住那个 bug） ══════════

// ── A. fsyncFile 退回只读句柄（Windows EPERM 原缺陷）──
caseOf({
  name: "A lib/fsync.js 的 fsyncFile 退回 flush(f, 'r')",
  target: 'lib/fsync.js',
  mutate: () => edit('lib/fsync.js',
    "export function fsyncFile(file) {\n  return flush(file, 'r+', { readOnlyIsUnsupported: false });",
    "export function fsyncFile(file) {\n  return flush(file, 'r', { readOnlyIsUnsupported: false });"),
  test: 'fsync-platform.test.mjs',
  expect: "fsyncFile 必须开 'r+' 的调用点断言",
});

// ── B. 改名绕过：形参改成 dir，同时退回 'r' ──
caseOf({
  name: "B 形参改名 dir + 退回 'r'（曾打穿过门禁的那一招）",
  target: 'lib/fsync.js',
  mutate: () => edit('lib/fsync.js',
    "export function fsyncFile(file) {\n  return flush(file, 'r+', { readOnlyIsUnsupported: false });",
    "export function fsyncFile(dir) {\n  return flush(dir, 'r', { readOnlyIsUnsupported: false });"),
  test: 'fsync-platform.test.mjs',
  expect: '按调用点判定后，改名不再能绕过',
});

// ── C. 白名单外新建模块，写普通形态的路径级 fsync ──
caseOf({
  name: 'C 新建模块 lib/zzz-mutation-plain.js，写普通形态的路径级 fsync',
  target: 'lib/zzz-mutation-plain.js',
  mutate: () => writeFileSync(join(REPO, 'lib/zzz-mutation-plain.js'),
    "import { openSync, fsyncSync, closeSync } from 'node:fs';\n"
    + "export function flushIt(p) { const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }\n"),
  test: 'fsync-platform.test.mjs',
  expect: '「扫描 lib/ 自动发现违规模块」断言',
});

// ── C2. 同缺陷，实参写成嵌套调用 ──
caseOf({
  name: "C2 同缺陷，实参写成 openSync(dirname(p), 'r')（嵌套调用）",
  target: 'lib/zzz-mutation-nested.js',
  mutate: () => writeFileSync(join(REPO, 'lib/zzz-mutation-nested.js'),
    "import { openSync, fsyncSync, closeSync } from 'node:fs';\n"
    + "import { dirname } from 'node:path';\n"
    + "export function flushIt(p) { const fd = openSync(dirname(p), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }\n"),
  test: 'fsync-platform.test.mjs',
  expect: '括号平衡扫描：嵌套实参也必须被看见',
});

// ── S1. ★ 本版声称修掉：模式写成双引号 ──
caseOf({
  name: 'S1 ★ 同缺陷，模式写成双引号 openSync(p, "r")',
  target: 'lib/zzz-mutation-dquote.js',
  mutate: () => writeFileSync(join(REPO, 'lib/zzz-mutation-dquote.js'),
    'import { openSync, fsyncSync, closeSync } from \'node:fs\';\n'
    + 'export function flushIt(p) { const fd = openSync(p, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }\n'),
  test: 'fsync-platform.test.mjs',
  expect: '引号风格不是语义：双引号形态必须同样被判定',
});

// ── S2. ★ 本版声称修掉：模式是计算值 ──
caseOf({
  name: "S2 ★ 同缺陷，模式提成变量 const M = 'r'; openSync(p, M)",
  target: 'lib/zzz-mutation-varmode.js',
  mutate: () => writeFileSync(join(REPO, 'lib/zzz-mutation-varmode.js'),
    'import { openSync, fsyncSync, closeSync } from \'node:fs\';\n'
    + 'const M = \'r\';\n'
    + 'export function flushIt(p) { const fd = openSync(p, M); try { fsyncSync(fd); } finally { closeSync(fd); } }\n'),
  test: 'fsync-platform.test.mjs',
  expect: '计算型 mode 必须按"不可静态判定"上报，不能当成合规',
});

// ── T. ★ 本版声称修掉：open 与 flush 相隔 >400 字符 ──
caseOf({
  name: 'T ★ 同缺陷，openSync 与 fsyncSync 相隔 520 字符',
  target: 'lib/zzz-mutation-farapart.js',
  mutate: () => writeFileSync(join(REPO, 'lib/zzz-mutation-farapart.js'),
    'import { openSync, fsyncSync, closeSync } from \'node:fs\';\n'
    + 'export function flushIt(p) { const fd = openSync(p, \'r\');\n'
    + '  const pad = \'' + 'p'.repeat(520) + '\';\n'
    + '  try { if (pad.length < 0) return; fsyncSync(fd); } finally { closeSync(fd); } }\n'),
  test: 'fsync-platform.test.mjs',
  expect: '观察窗口改成"所在作用域"后，距离不再能藏住缺陷',
});

// ── U. ★ 本版声称修掉：违规模块放进 lib/ 子目录 ──
caseOf({
  name: 'U ★ 违规模块放进 lib/sub/（发现逻辑是否递归）',
  target: 'lib/sub/zzz-mutation-sub.js',
  mutate: () => {
    mkdirSync(join(REPO, 'lib', 'sub'), { recursive: true });
    writeFileSync(join(REPO, 'lib/sub/zzz-mutation-sub.js'),
      'import { openSync, fsyncSync, closeSync } from \'node:fs\';\n'
      + 'export function flushIt(p) { const fd = openSync(p, \'r\'); try { fsyncSync(fd); } finally { closeSync(fd); } }\n');
  },
  test: 'fsync-platform.test.mjs',
  restoreTo: ['lib/sub/zzz-mutation-sub.js'],
  expect: '递归发现：子目录里的同类缺陷必须被扫到',
});

// ── K. lib/skills.js 退回私有目录 fsync + 吞掉一切 ──
caseOf({
  name: 'K lib/skills.js 退回私有目录 fsync + 吞掉一切',
  target: 'lib/skills.js',
  mutate: () => edit('lib/skills.js', '  fsyncDir(dirname(file));',
    "  try { const dfd = openSync(dirname(file), 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* platform */ }"),
  test: 'fsync-platform.test.mjs',
  expect: '「lib/fsync.js 之外不得有路径级 fsync」断言',
});

// ── K2. 同一缺陷的等价改写：把实参提成局部变量（行为完全不变）──
caseOf({
  name: "K2 同缺陷等价改写：实参提成局部变量 openSync(d, 'r')",
  target: 'lib/skills.js',
  mutate: () => edit('lib/skills.js', '  fsyncDir(dirname(file));',
    "  const d = dirname(file);\n  const dfd = openSync(d, 'r');\n  try { fsyncSync(dfd); } finally { closeSync(dfd); }"),
  test: 'fsync-platform.test.mjs',
  expect: '判定不依赖表达式写法：提成局部变量同样要被看见',
});

// ── E. fsyncTree 丢弃 fsyncFile 的返回值 ──
caseOf({
  name: 'E lib/op-runtime.js 的 fsyncTree 丢弃 fsyncFile 结果（v0.6.0 原始形态）',
  target: 'lib/op-runtime.js',
  mutate: () => edit('lib/op-runtime.js',
    "      const r = fsyncFile(full);\n      if (r.ok) continue;\n"
    + "      if (r.outcome === FSYNC_NOT_WRITABLE) unsynced.push(full);\n"
    + "      else unsupported.push(full);",
    '      fsyncFile(full);'),
  test: 'fsync-platform.test.mjs',
  expect: 'fsyncTree 必须分支于 fsyncFile 返回值的断言',
});

// ── F. publish 协议装回"任一文件刷不动就中止发布"──
caseOf({
  name: 'F publish-protocols 装回 abort（一个只读文件失败整条发布）',
  target: 'lib/publish-protocols.js',
  mutate: () => edit('lib/publish-protocols.js',
    '  writeMarker(stagingDir, durabilityMarker(marker, synced, logger, stagingDir));',
    '  if (!synced.ok || synced.unsynced.length > 0) {\n'
    + '    return { ok: false, reason: `refusing to publish a durability marker (first: ${synced.unsynced[0]})` };\n'
    + '  }\n  writeMarker(stagingDir, marker);'),
  test: 'fsync-platform.test.mjs',
  expect: '「marker 必须经 durabilityMarker 落章」+「不得出现 abort 文案」两条断言',
});

// ── N. 把 durabilityMarker 换回裸 writeMarker ──
caseOf({
  name: 'N publish-protocols 的 marker 不走 durabilityMarker（降级被静默吞掉）',
  target: 'lib/publish-protocols.js',
  mutate: () => edit('lib/publish-protocols.js',
    '  writeMarker(stagingDir, durabilityMarker(marker, synced, logger, stagingDir));',
    '  writeMarker(stagingDir, marker);'),
  test: 'fsync-platform.test.mjs',
  expect: '「每个 publish 路径的 marker 都必须落章」断言',
});

// ── P. fsync.js 不再 rethrow（真实 ENOSPC/EIO 被当成平台拒绝）──
caseOf({
  name: 'P lib/fsync.js 不再 rethrow（真实 ENOSPC/EIO 被当成平台拒绝）',
  target: 'lib/fsync.js',
  mutate: () => edit('lib/fsync.js',
    '    if (!FSYNC_SOFT_FAIL.includes(code)) throw e;   // ENOSPC/EIO are real failures',
    '    if (!FSYNC_SOFT_FAIL.includes(code)) { /* mutation: swallow */ }'),
  test: 'fsync-platform.test.mjs',
  expect: 'flush 必须 rethrow 白名单外的码',
});

// ── L. ★ 本版声称修掉：把真实 I/O 错误码塞进 NOT_WRITABLE ──
caseOf({
  name: 'L ★ NOT_WRITABLE 塞进 ENOSPC/EIO/ENOENT（把真实故障标成"只读对象"）',
  target: 'lib/fsync.js',
  mutate: () => edit('lib/fsync.js',
    "const NOT_WRITABLE = Object.freeze(['EACCES', 'EPERM', 'EROFS']);",
    "const NOT_WRITABLE = Object.freeze(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EIO', 'ENOENT']);"),
  test: 'fsync-platform.test.mjs',
  expect: '模块加载期的不变式：NOT_WRITABLE ⊆ FSYNC_SOFT_FAIL，违反即拒绝加载',
});

// ── X. ★ 反向：把 EROFS 从 SOFT_FAIL 里删掉（会让不变式失败）──
caseOf({
  name: 'X ★ FSYNC_SOFT_FAIL 删掉 EROFS（NOT_WRITABLE 就不再是子集）',
  target: 'lib/fsync.js',
  mutate: () => edit('lib/fsync.js',
    "  ['EINVAL', 'EACCES', 'EPERM', 'EISDIR', 'ENOTSUP', 'EROFS'],",
    "  ['EINVAL', 'EACCES', 'EPERM', 'EISDIR', 'ENOTSUP'],"),
  test: 'fsync-platform.test.mjs',
  expect: '同一条不变式反向成立：删掉 EROFS 也必须拒绝加载',
});

// ── V. ★ 把"唯一的行为证据"静默关掉 ──
caseOf({
  name: 'V ★ 让 readOnlyIsEnforced 恒返回 false（唯一的行为证据想变成永久 skip）',
  target: 'scripts/schema/fsync-platform.test.mjs',
  mutate: () => edit('scripts/schema/fsync-platform.test.mjs',
    "function readOnlyIsEnforced(dir) {\n  const probe = join(dir, '.ro-probe');",
    "function readOnlyIsEnforced(dir) {\n  return false;   // mutation: silently disable the only behavioural proof\n"
    + "  const probe = join(dir, '.ro-probe');"),
  test: 'fsync-platform.test.mjs',
  expect: 'skip 必须由环境解释：非 root 的 skip 一律算失败',
});

// ── O. ★ 本版声称修掉：marker 上不再记录降级信息 ──
caseOf({
  name: 'O publish-protocols 的 marker 不再写 durability 字段',
  target: 'lib/publish-protocols.js',
  mutate: () => edit('lib/publish-protocols.js',
    "    durability: unsynced.length > 0 ? 'partial' : 'platform-limited',",
    '    // mutation: no durability field'),
  test: 'fsync-platform.test.mjs',
  expect: '「publish-protocols 必须给 marker 落 durability」断言',
});

// ── Q. ★ fsyncTree 把恒真的 ok 装回来 ──
caseOf({
  name: 'Q fsyncTree 把恒真的 ok: true 装回来',
  target: 'lib/op-runtime.js',
  mutate: () => edit('lib/op-runtime.js',
    '  walk(root);\n  for (const dir of dirs.reverse()) fsyncDir(dir);\n  return { unsynced, unsupported };',
    '  walk(root);\n  for (const dir of dirs.reverse()) fsyncDir(dir);\n  return { ok: true, unsynced, unsupported };'),
  test: 'fsync-platform.test.mjs',
  expect: '「fsyncTree 不得返回恒真的 ok」断言',
});

// ── AA. durability 门禁的正对照：把某条 roll-forward 的 degraded 摘掉 ──
caseOf({
  name: 'AA ★ 摘掉一条 roll-forward 上的 ...degraded(marker)',
  target: 'lib/op-runtime.js',
  mutate: () => edit('lib/op-runtime.js',
    "return { verdict: 'roll-forward', reason: 'destination carries this operation marker', ...degraded(marker) };",
    "return { verdict: 'roll-forward', reason: 'destination carries this operation marker' };"),
  test: 'fsync-platform.test.mjs',
  expect: '「每个确认提交的 roll-forward 都要带上降级信息」断言',
});

// ── R. ★ 本版声称修掉：budgetStatus 退回读持久化 injectionCount ──
caseOf({
  name: 'R store.js 的 memoryBudgetStatus 退回读持久化 injectionCount',
  target: 'lib/store.js',
  mutate: () => edit('lib/store.js',
    '    const records = this.confirmed().map((r) => (\n'
    + '      r.injectionCount === this.effectiveInjectionCount(r)\n'
    + '        ? r\n'
    + '        : { ...r, injectionCount: this.effectiveInjectionCount(r) }\n'
    + '    ));\n'
    + '    return { enabled: true, ...budgetStatus(records, max, this.config) };',
    '    return { enabled: true, ...budgetStatus(this.confirmed(), max, this.config) };'),
  test: 'fsync-platform.test.mjs',
  expect: '「effective 计数只有一个定义」断言（在 fsync-platform.test.mjs 尾部）',
});

// ── M. ★ 本版声称修掉：setConfig 写到临时对象（设置页静默失效）──
caseOf({
  name: 'M ★ setConfig 改成 Object.assign({ ...cfg }, patch)（写入临时对象）',
  target: 'lib/index.js',
  mutate: () => edit('lib/index.js', '            Object.assign(cfg, patch);',
    '            Object.assign({ ...cfg }, patch);'),
  test: 'config-liveness.test.mjs',
  expect: '行为断言：POST set-config 之后，真实配置必须移动',
});

// ══════════ 二、既有门禁（跨版本仍然适用） ══════════

// ── D. store.js 退回构造期快照拷贝 ──
caseOf({
  name: 'D lib/store.js 退回 this.config = { ...DEFAULTS, ...config }',
  target: 'lib/store.js',
  mutate: () => edit('lib/store.js',
    '    const live = options.config ?? {};\n'
    + '    for (const [k, v] of Object.entries(MEMORY_DEFAULTS)) {\n'
    + '      if (live[k] === undefined) live[k] = v;\n'
    + '    }\n'
    + '    this.config = live;',
    '    this.config = { ...MEMORY_DEFAULTS, ...(options.config ?? {}) };'),
  test: 'config-liveness.test.mjs',
  expect: '配置活性：构造后 setConfig 仍必须可见',
});

// ── G. 孤儿测试：新增一个从不被 package.json 引用的 *.test.mjs ──
caseOf({
  name: 'G 新增一个没写进 package.json scripts 的测试文件',
  target: 'scripts/schema/zzz-mutation-orphan.test.mjs',
  mutate: () => writeFileSync(join(REPO, 'scripts/schema/zzz-mutation-orphan.test.mjs'),
    "import { test } from 'node:test';\ntest('orphan', () => {});\n"),
  test: 'fsync-platform.test.mjs',
  expect: '「每个 *.test.mjs 都被 test 脚本引用」断言',
});

// ── H. 编码门禁：给某个 .py 门禁脚本塞一个非 ASCII 字符 ──
caseOf({
  name: 'H 给 scripts/schema 下的 .py 塞一个 U+2B50（复刻 v0.6.0 的事故）',
  target: 'scripts/schema/test_tree_hash_regression.py',
  mutate: () => edit('scripts/schema/test_tree_hash_regression.py', 'def main():',
    "PASS_MARK = '\u2b50'  # decorative glyph\n\n\ndef main():"),
  test: 'gate-scripts-ascii.test.mjs',
  expect: 'Python 门禁脚本 ASCII-only 断言',
});

// ── I. requirements 门禁：让 CI 重新内联 pin 版本 ──
caseOf({
  name: 'I verify.yml 重新内联 pip install 版本（与 requirements.txt 双份 pin）',
  target: '.github/workflows/verify.yml',
  mutate: () => edit('.github/workflows/verify.yml',
    'python -m pip install --disable-pip-version-check -r scripts/schema/requirements.txt',
    'python -m pip install --disable-pip-version-check "jsonschema[format]==4.23.0" rfc3339-validator==0.1.4'),
  test: 'gate-scripts-ascii.test.mjs',
  expect: '「CI 必须从 requirements.txt 安装」断言',
});

// ── J. F3 棘轮：只用抬地板的方式"修"它 ──
caseOf({
  name: 'J 把 MATCH_BASE_MIN 抬到 1.62（抬地板冒充修好精度悬崖）',
  target: 'lib/search.js',
  mutate: () => edit('lib/search.js', 'export const MATCH_BASE_MIN = 1.0;', 'export const MATCH_BASE_MIN = 1.62;'),
  test: 'f3-precision-hole.test.mjs',
  expect: 'F3 证据测试：不得用抬地板换掉召回',
});

// ══════════ 三、主动找绕过路径（预期门禁覆盖不到） ══════════

// ── M2. config 写路径换成逐键赋值（等价改写，不是缺陷）──
caseOf({
  name: 'M2 config 写路径换成逐键赋值 for (const [k,v] of Object.entries(patch)) cfg[k] = v',
  target: 'lib/index.js',
  mutate: () => edit('lib/index.js', '            Object.assign(cfg, patch);',
    '            for (const [k, v] of Object.entries(patch)) cfg[k] = v;'),
  test: 'config-liveness.test.mjs',
  expectRed: false,
  expect: '预期【仍绿】——本版 README 明确声称这条等价重构必须通过',
});

// ── W. ★★ 把 store 收到的配置换成快照拷贝（本文件头部文档点名的那个缺陷）──
caseOf({
  name: 'W ★★ index.js 的 new MemoryStore 收到 config 快照 { ...cfg }',
  target: 'lib/index.js',
  mutate: () => edit('lib/index.js',
    '    workspaceDir, config: cfg, logger: ctx.logger ?? undefined, fts,',
    '    workspaceDir, config: { ...cfg }, logger: ctx.logger ?? undefined, fts,'),
  test: 'config-liveness.test.mjs',
  expectRed: true,
  expect: '门禁的靶子：POST set-config 收紧 cap 到 1 之后，写第二条 pending 必须被拒；'
    + 'store 拿快照则仍以为是 50 → 接受 → 红',
});

// ── Y1. ★ durability 门禁的 500 字符观察窗 ──
caseOf({
  name: 'Y1 ★ 插入一个 marker 读，其 roll-forward 落在 500 字符之外',
  target: 'lib/op-runtime.js',
  mutate: () => edit('lib/op-runtime.js', 'export function removeMarker(dir) {',
    '// mutation: marker read whose roll-forward sits beyond the fixed window\n'
    + 'export function zzzFarMarker(dir) {\n'
    + '  const marker = readMarker(dir);\n'
    + "  const pad = '" + 'Q'.repeat(560) + "';\n"
    + '  if (!marker) return null;\n'
    + "  return { verdict: 'roll-forward', reason: 'probe ' + pad.length };\n"
    + '}\n\n'
    + 'export function removeMarker(dir) {'),
  test: 'fsync-platform.test.mjs',
  expectRed: true,
  expect: '预期【变红】（v0.7.0 起反转）。这条原本是用来暴露 500 字符观察窗的：'
    + '旧门禁只看 readMarker 之后 500 字符，把 roll-forward 推到窗外它就看不见，所以"仍绿"='
    + '门禁有洞。L0③ 把该断言改成按【语句】界定 + 钉住"恰好三个 marker-trusting roll-forward"，'
    + '于是新插入的第四个 roll-forward 会被数出来 → 变红才是正确行为。'
    + '★ 红的原因必须是计数不符，不是窗口截断。',
});

// ── Y2. ★ 只改键序、行为完全等价 —— 会不会被误杀 ──
caseOf({
  name: 'Y2 ★ 把 ...degraded(marker) 挪到 verdict 之前（键序变化，行为等价）',
  target: 'lib/op-runtime.js',
  mutate: () => edit('lib/op-runtime.js',
    "return { verdict: 'roll-forward', reason: 'destination carries this operation marker', ...degraded(marker) };",
    "return { ...degraded(marker), verdict: 'roll-forward', reason: 'destination carries this operation marker' };"),
  test: 'fsync-platform.test.mjs',
  expectRed: false,
  expect: '预期【仍绿】：键序变化行为等价。旧门禁只看 verdict 之后 220 字符里有没有字面量 '
    + 'degraded(，把 ...degraded(marker) 挪到 verdict 之前就落到窗外 → 误杀。'
    + 'L0③ 改成按【语句】读整条 return，键序就不再影响判定。',
});

// ── Z. ★ 计算型写模式被当成违规 —— 会不会误报合法写法 ──
caseOf({
  name: 'Z ★ 合法的写句柄写成 openSync(tmp, MODE)（MODE = \'w\'）',
  target: 'lib/zzz-mutation-writemode.js',
  mutate: () => writeFileSync(join(REPO, 'lib/zzz-mutation-writemode.js'),
    "import { openSync, fsyncSync, closeSync } from 'node:fs';\n"
    + "const MODE = 'w';\n"
    + 'export function flushTmp(tmp) { const fd = openSync(tmp, MODE); try { fsyncSync(fd); } finally { closeSync(fd); } }\n'),
  test: 'fsync-platform.test.mjs',
  expectRed: false,
  expect: "预期【仍绿】；若变红 = 假阳性：本文件自己写明写句柄是合法模式，计算型 mode 却一律上报",
});

// ══════════════════════════════════════════════════════════════════════════
// ── 基线：未变异时必须 fail=0 ──
const usedFiles = [...new Set(CASES.map((c) => c.test))];
console.log('════════ 基线校验（未变异，必须 fail=0）════════\n');
let harnessOk = true;
for (const f of usedFiles) {
  const r = runTest(f);
  const ok = r.started && r.fail === 0;
  if (!ok) harnessOk = false;
  console.log(`  ${ok ? '✅' : '🔴'} ${f}: pass=${r.pass} fail=${r.fail} todo=${r.todo} exit=${r.exit}${r.started ? '' : '  ← 测试没跑起来！'}`);
}
if (!harnessOk) {
  console.log('\n🔴 基线不通过：变异测试的结论不可信，先修脚本/环境。\n');
  process.exit(2);
}

const results = [];
for (const c of CASES) {
  let outcome;
  try {
    const m = c.mutate();
    if (m && typeof m === 'object' && 'code' in m && m.code !== 0) throw new Error(`变异命令失败: ${m.out.slice(0, 120)}`);
    const r = runTest(c.test);
    const red = (r.started && r.fail > 0) || (!r.started && r.loadError);
    outcome = {
      red,
      detail: r.started
        ? `pass=${r.pass} fail=${r.fail} todo=${r.todo}`
        : (r.loadError ? '测试文件/被测模块在加载期即抛错（门禁生效）' : `测试没跑起来（exit=${r.exit}）`),
    };
    if (r.fail > 0) {
      const firstFail = (r.raw.match(/not ok \d+ - (.+)/m) ?? [])[1] ?? '(未捕获断言名)';
      outcome.detail += `\n                  ← 首个失败断言: ${firstFail.slice(0, 110)}`;
    } else if (!r.started && r.loadError) {
      const err = (r.raw.match(/(?:Error|TypeError|ReferenceError): (.+)/) ?? [])[1] ?? '(未捕获错误)';
      outcome.detail += `\n                  ← 抛出: ${err.slice(0, 110)}`;
    }
  } catch (e) {
    outcome = { red: null, detail: `变异本身失败: ${e.message.slice(0, 140)}` };
  } finally {
    restore(c.restoreTo ?? [c.target]);
  }
  results.push({ ...c, ...outcome });
}

console.log('\n════════ 变异测试结果 ════════\n');
let holes = 0;
let fps = 0;
for (const r of results) {
  const expectRed = r.expectRed !== false;
  let mark;
  if (r.red === null) mark = '⚠️ 无法判定';
  else if (expectRed && r.red) mark = '✅ 变红（门禁有效）';
  else if (expectRed && !r.red) { mark = '🔴 仍绿（门禁无效）'; holes += 1; }
  else if (!expectRed && r.red) { mark = 'ℹ️ 意外变红（见下方 expect 说明：可能是假阳性）'; if (/假阳性/.test(r.expect)) fps += 1; }
  else mark = '⚪ 仍绿（预期覆盖不到）';
  console.log(`${mark}  ${r.name}`);
  console.log(`        目标: ${r.target}`);
  console.log(`        测的断言: ${r.expect}`);
  console.log(`        结果: ${r.detail}\n`);
}

console.log(`════════ 小结：预期变红但没红的 ${holes} 项（门禁的洞）；等价改写被误杀的 ${fps} 项（假阳性） ════════`);
try { rmSync(join(REPO, 'lib', 'sub'), { recursive: true, force: true }); } catch { /* none */ }
const dirty = shQuiet(['git', 'status', '--porcelain']).out.trim();
console.log('════════ 工作树状态 ════════');
console.log(dirty.split('\n').filter((l) => l && !l.includes('package-lock.json')).join('\n') || '  clean（所有变异已还原）');
