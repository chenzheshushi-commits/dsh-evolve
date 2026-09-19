/**
 * 门禁变异矩阵（v0.6.5）。
 *
 * v0.6.5 只改了门禁（无生产代码改动）。本探针对「config 接线」与相邻的几条
 * 行为/文本门禁注入一批变异，逐个跑【全契约层】，回答四个问题：
 *
 *   A. 该门禁声称能抓的缺陷形态，注入回去真的变红吗？红的是它自己那条吗？（漏报 / 装饰）
 *   B. 语义完全等价的重构（改名、去中间变量、换等价写法）会不会被误杀？（假阳性）
 *   C. 门禁判据自身的洞：文本正则能不能绕过？
 *   D. 断言是否恒真（窗口起点就在 marker 上、断言的模式又是 marker 的前缀）？
 *
 * 每条都先跑一次未变异基线（必须 fail=0），再注入 —— 见 skill 的「基线校验」。
 * 对每条预期变红的用例，还断言「红的是该红的那条测试」，否则只算「红得有偏差」。
 *
 * 用法: node config-guard-mutation-matrix.mjs [仓库路径]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Default to the repository this file now lives in, rather than the absolute scratch
// path it was written against.
const DEFAULT_REPO = fileURLToPath(new URL('../..', import.meta.url));
const REPO = (process.argv[2] ?? DEFAULT_REPO).replace(/[\\/]+$/, '');
const NODE = process.execPath;

/** package.json 的 test 脚本是权威清单（有门禁守着它不漏文件）。 */
function contractFiles() {
  const pkg = readFileSync(join(REPO, 'package.json'), 'utf8');
  const names = [...pkg.matchAll(/scripts\/schema\/([A-Za-z0-9._-]+\.test\.mjs)/g)].map((m) => `scripts/schema/${m[1]}`);
  return [...new Set(names)];
}

function runSuite() {
  let out;
  try {
    out = execFileSync(NODE, ['--test', '--test-reporter=tap', ...contractFiles()],
      { cwd: REPO, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { out = (e.stdout ?? '') + (e.stderr ?? ''); }
  const num = (k) => Number((out.match(new RegExp(`# ${k} (\\d+)`)) ?? [0, 0])[1]);
  // # TODO 的用例在 TAP 里也是 not ok，不是失败，剔掉
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((n) => !/# TODO/.test(n));
  const msg = (() => {
    const m = /^not ok \d+ - (?!.*# TODO)(.+)$/m.exec(out);
    if (!m) return '';
    // Bounded by the next TAP line rather than by 3000 characters. The original was
    // `out.slice(m.index, m.index + 3000)` -- the exact shape window-scan.mjs exists
    // to flag, and this file is now inside its scope. A diagnostic that silently
    // truncates is also the wrong thing to hand someone debugging a failure.
    const rest = out.slice(m.index);
    const nextTap = rest.slice(1).search(/^(?:not ok|ok) \d+ /m);
    const block = nextTap === -1 ? rest : rest.slice(0, nextTap + 1);
    const e = /error:[\s\S]{0,40}?\n((?:[ \t]+.*\n){1,3})/.exec(block);
    return e ? e[1].split('\n').map((s) => s.trim()).filter(Boolean).join(' ⏎ ').slice(0, 220) : '';
  })();
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), failed, msg };
}

const IDX = join(REPO, 'lib', 'index.js');
const STORE = join(REPO, 'lib', 'store.js');
const CLIENT = join(REPO, 'lib', 'client.js');
const FILES = [IDX, STORE, CLIENT];
const originals = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));

/** 一条 ~1,500 字符的说明注释（把地标推出 1,200 字符的窗口）——不改任何行为。 */
const LONG_COMMENT = '    // ' + 'the gate below is deliberate: one shared check rather than one per handler, so a handler added later cannot silently skip it. '.repeat(12);

const E2E = 'POST set-config reaches the live store (end to end)';

const CASES = [
  // ── A. 门禁声称覆盖的缺陷形态（漏报检验）──────────────────────────
  {
    id: 'A1',
    name: 'store 拿到构造期快照（index.js:279  config: cfg → { ...cfg }）',
    file: IDX,
    from: '    workspaceDir, config: cfg, logger: ctx.logger ?? undefined, fts,',
    to: '    workspaceDir, config: { ...cfg }, logger: ctx.logger ?? undefined, fts,',
    expectRed: true, expectFailName: E2E,
    note: '本轮门禁的核心靶子',
  },
  {
    id: 'A2',
    name: '写路径落在临时副本上（index.js:1798  Object.assign(cfg, patch) → Object.assign({ ...cfg }, patch)）',
    file: IDX,
    from: '            Object.assign(cfg, patch);',
    to: '            Object.assign({ ...cfg }, patch);',
    expectRed: true, expectFailName: E2E,
    note: '「同一个 bug 上一层」',
  },
  {
    id: 'A3',
    name: 'store 自己退回构造期快照（store.js  this.config = live → { ...DEFAULTS, ...options.config }）',
    file: STORE,
    from: '    const live = options.config ?? {};\n'
      + '    for (const [k, v] of Object.entries(MEMORY_DEFAULTS)) {\n'
      + '      if (live[k] === undefined) live[k] = v;\n'
      + '    }\n'
      + '    this.config = live;',
    to: '    this.config = { ...MEMORY_DEFAULTS, ...(options.config ?? {}) };',
    expectRed: true, expectFailName: E2E,
    note: 'README 自述「fails three assertions」——本条用来数它到底红几条',
  },
  {
    id: 'A4',
    name: '换一种拷贝写法（index.js:279  config: Object.assign({}, cfg)）',
    file: IDX,
    from: '    workspaceDir, config: cfg, logger: ctx.logger ?? undefined, fts,',
    to: '    workspaceDir, config: Object.assign({}, cfg), logger: ctx.logger ?? undefined, fts,',
    expectRed: true, expectFailName: E2E,
    note: '验证门禁不是只认 { ...obj } 这一种字面形状',
  },

  // ── B. 语义等价的重构（假阳性检验）────────────────────────────────
  {
    id: 'B1',
    name: '等价重构：Object.assign(cfg, patch) → 逐键赋值',
    file: IDX,
    from: '            Object.assign(cfg, patch);',
    to: '            for (const [k, v] of Object.entries(patch)) cfg[k] = v;',
    expectRed: false,
    note: 'v0.6.3 的旧门禁在这里误杀过；新门禁应当放行（README 也这么自述）',
  },
  {
    id: 'B2',
    name: '等价重构：局部变量改名 live → shared（声明与全部引用一起改）',
    file: STORE,
    from: '    const live = options.config ?? {};\n'
      + '    for (const [k, v] of Object.entries(MEMORY_DEFAULTS)) {\n'
      + '      if (live[k] === undefined) live[k] = v;\n'
      + '    }\n'
      + '    this.config = live;',
    to: '    const shared = options.config ?? {};\n'
      + '    for (const [k, v] of Object.entries(MEMORY_DEFAULTS)) {\n'
      + '      if (shared[k] === undefined) shared[k] = v;\n'
      + '    }\n'
      + '    this.config = shared;',
    expectRed: false,
    note: '行为逐字节等价：仍是宿主那个对象 + 回填默认值',
  },
  {
    id: 'B3',
    name: '等价重构：去掉中间变量，直接 this.config 持有宿主对象并就地回填',
    file: STORE,
    from: '    const live = options.config ?? {};\n'
      + '    for (const [k, v] of Object.entries(MEMORY_DEFAULTS)) {\n'
      + '      if (live[k] === undefined) live[k] = v;\n'
      + '    }\n'
      + '    this.config = live;',
    to: '    this.config = options.config ?? {};\n'
      + '    for (const [k, v] of Object.entries(MEMORY_DEFAULTS)) {\n'
      + '      if (this.config[k] === undefined) this.config[k] = v;\n'
      + '    }',
    expectRed: false,
    note: '语义完全等价（live === this.config），只是省掉一个中间变量',
  },

  // ── C. 门禁判据自身的洞（文本正则绕过）───────────────────────────
  {
    id: 'C1',
    name: 'store 文本门禁的绕过：间接 spread（正则看不见，行为测试应当兜住）',
    file: STORE,
    from: '    const live = options.config ?? {};',
    to: '    const live = { ...(options.config ?? {}) };',
    expectRed: true, expectFailName: 'a config change made after construction is visible to the store',
    note: 'config-liveness.test.mjs:99 的正则只认 this.config = { ... ；这条在正则外',
  },
  {
    id: 'C2',
    name: 'apply 忽略宿主传入的 config（index.js:212 去掉 ...config）',
    file: IDX,
    from: '  const cfg = { ...MEMORY_DEFAULTS, ...SKILL_DEFAULTS, ...config };',
    to: '  const cfg = { ...MEMORY_DEFAULTS, ...SKILL_DEFAULTS };',
    expectRed: true,
    note: '测「宿主配置有没有被端到端读入」；仍绿 = 覆盖缺口',
  },

  // ── D. 判据恒真 / 定长窗口的误杀 ─────────────────────────────────
  {
    id: 'D1',
    name: '★ 断言恒真：把回滚提案的 POST 目标换成别的端点（client.js）',
    file: CLIENT,
    from: '/skills/rollback-proposal`',
    to: '/skills/nope-not-here`',
    expectRed: true, expectFailName: 'the rollback button proposes rather than rolls back',
    note: 'ui-api-contract.test.mjs:106 的窗口从 marker 自身起算，/rollback-proposal/ 是 marker 前缀',
  },
  {
    id: 'D2',
    name: '★ 定长窗口误杀：在 index.js:1691 execute() 开头插入一条注释（行为零变化）',
    file: IDX,
    from: '  async function execute(planDigest, opts = {}) {',
    to: '  async function execute(planDigest, opts = {}) {\n' + LONG_COMMENT,
    expectRed: false,
    note: 'instance-lock.test.mjs:145 用 slice(execStart, execStart + 1200) 找 mutationsAllowed',
  },
  {
    id: 'D3',
    name: '★ 定长窗口误杀：在 store.js 构造器签名后插入一条注释（行为零变化）',
    file: STORE,
    from: '  constructor(table, options = {}) {\n    this.table = table;',
    to: '  constructor(table, options = {}) {\n'
      + '    // ' + 'the config object is held live on purpose, and the comment explaining why sits here rather than above the class, so a reader meets it exactly where the decision is made. '.repeat(6) + '\n'
      + '    this.table = table;',
    expectRed: false,
    note: "config-liveness.test.mjs:98 用 slice(indexOf('constructor(table'), +1600) 切构造器；this.config = live 现在在 +918",
  },
];

console.log(`\n仓库: ${REPO}`);
console.log(`用例: ${CASES.length} 条\n`);

const base = runSuite();
console.log(`① 未变异基线（全契约层 ${contractFiles().length} 文件）: tests=${base.tests} pass=${base.pass} fail=${base.fail}`);
if (base.fail !== 0 || base.tests === 0) {
  console.log('🔴 基线不绿 → 探针结论不可信，退出');
  process.exit(2);
}

const results = [];
for (const c of CASES) {
  const orig = originals.get(c.file);
  if (!orig.includes(c.from)) { console.log(`🔴 ${c.id} 锚点未命中（源码变了？）`); results.push({ c, miss: true }); continue; }
  let r;
  try {
    writeFileSync(c.file, orig.replace(c.from, c.to));
    r = runSuite();
  } finally {
    writeFileSync(c.file, orig);
  }
  if (readFileSync(c.file, 'utf8') !== orig) { console.log(`🔴 ${c.id} 还原失败，中止`); process.exit(2); }
  const red = r.fail > 0;
  const verdictOk = red === c.expectRed;
  const rightOne = c.expectRed
    ? (c.expectFailName ? r.failed.some((n) => n.includes(c.expectFailName)) : true)
    : true;
  results.push({ c, r, red, verdictOk, rightOne });
  console.log(`${verdictOk && rightOne ? '✅' : '⚠️ '} ${c.id} ${c.name}`);
  console.log(`     结果: fail=${r.fail} / pass=${r.pass}  预期${c.expectRed ? '变红' : '仍绿'} → ${red ? '变红' : '仍绿'}${verdictOk ? '' : '   ← 与预期不符'}`);
  if (red) {
    console.log(`     红的用例: ${r.failed.slice(0, 4).join(' | ')}${r.failed.length > 4 ? ` (+${r.failed.length - 4})` : ''}`);
    if (c.expectRed && c.expectFailName) {
      console.log(`     声称守的那条: ${rightOne ? '✅ 在红名单里' : `⚠️ 不在红名单里（这条断言压根没失败）`}`);
    }
    if (r.msg) console.log(`     断言消息: ${r.msg}`);
  }
}

console.log('\n════════ 小结 ════════');
const expRed = CASES.filter((c) => c.expectRed);
const expGreen = CASES.filter((c) => !c.expectRed);
const caught = results.filter((x) => x.c?.expectRed && x.red);
const missed = results.filter((x) => x.c?.expectRed && !x.red);
const wrongOne = results.filter((x) => x.c?.expectRed && x.red && !x.rightOne);
const falsePos = results.filter((x) => x.c && !x.c.expectRed && x.red);
console.log(`预期变红 ${expRed.length} 条 → 真变红 ${caught.length}，漏 ${missed.length}，红错了对象 ${wrongOne.length}`);
console.log(`预期仍绿 ${expGreen.length} 条 → 误杀 ${falsePos.length}`);
for (const m of missed) console.log(`  ⚠️ 漏: ${m.c.id} ${m.c.name}`);
for (const w of wrongOne) console.log(`  ⚠️ 红错了对象: ${w.c.id} ${w.c.name}`);
for (const f of falsePos) console.log(`  ⚠️ 误杀: ${f.c.id} ${f.c.name}`);
console.log(`\n工作树还原: ${FILES.every((p) => readFileSync(p, 'utf8') === originals.get(p)) ? '✅ 全部还原' : '🔴 有残留'}`);
console.log('');
