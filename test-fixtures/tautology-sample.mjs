// ── test-fixtures/tautology-sample.mjs ──
// fixture: 恒真断言 —— 【恒真扫描器】的自检锚点。Do not fix it.
// ★ 单参 slice: 故意【不】触发窗口判据（理由见本步末尾的写法 A/B/C 对照）
import assert from 'node:assert/strict';
const client = 'rollback-proposal-create ...';
const idx = client.indexOf('rollback-proposal-create');
const w = client.slice(idx);
assert.match(w, /rollback-proposal/);   // 模式在 marker 文本上就能匹配 = 恒真
