// ── test-fixtures/window-sample.mjs ──
// fixture: 定长窗口 —— 【窗口扫描器】的自检锚点。Do not fix it.
//
// Measured: this file is flagged by the tautology criterion TOO, not only the window
// one. slice(i, i + 4) from indexOf('beta') and then asserting it equals 'beta' is
// true by construction -- both criteria are correct about it. Harmless because
// test-fixtures/ is outside every scanner's scope, so neither gate can be polluted
// by it; the plan's table expecting exactly one hit per fixture was optimistic.
import assert from 'node:assert/strict';
const src = 'alpha beta gamma';
const i = src.indexOf('beta');
const w = src.slice(i, i + 4);     // ← 双参 + 数字字面量 = 窗口判据要咬的形态
assert.equal(w, 'beta');
