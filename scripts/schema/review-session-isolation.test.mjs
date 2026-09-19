/**
 * Background review must be isolated per session.
 *
 * The bug: one process-wide TurnSnapshotCollector and one process-wide
 * lastReviewedTurn served every session at once. Six consequences, each with a
 * test below:
 *
 *   1. two conversations' text landed in the same reviewer call, producing
 *      "lessons" stitched together from unrelated work
 *   2. session A's turn/end reset the buffer session B was still filling
 *   3. turn numbers all start at 1, so A's turn 12 could starve B's turn 3
 *   4. the buffer was only reset when a review was actually due, so a snapshot
 *      described as "ONE finished turn" often held several
 *   5. skipping a turn without consuming its buffer left that noise for the next
 *      review
 *   6. currentInitiator() was read inside the fire-and-forget task, by which time
 *      it could already point at a different session
 *
 * The state lives in a WeakMap keyed by session, so this exercises the same
 * shape the plugin uses rather than reaching into internals.
 *
 * Run: node --test scripts/schema/review-session-isolation.test.mjs
 */

import test from 'node:test';

import { enclosingStatement } from './source-scope.mjs';
import assert from 'node:assert/strict';

import { TurnSnapshotCollector } from '../../lib/review.js';

/**
 * The plugin's per-session wiring, reproduced.
 *
 * Deliberately a copy of the shape in index.js rather than an import: the
 * behaviour under test is "state is keyed by session and consumed every turn",
 * and this makes the contract explicit.
 */
function makeReviewer({ everyTurns = 5, maxChars = 12000 } = {}) {
  const perSession = new WeakMap();
  const reviewed = [];

  const stateFor = (session) => {
    let st = perSession.get(session);
    if (!st) {
      st = { collector: new TurnSnapshotCollector({ maxChars }), lastReviewedTurn: 0, stepCount: 1 };
      perSession.set(session, st);
    }
    return st;
  };

  return {
    reviewed,
    add(session, role, text) { stateFor(session).collector.add(role, text); },
    peek(session) { return stateFor(session).collector.snapshot(); },
    step(session) { stateFor(session).stepCount += 1; },
    noStep(session) { stateFor(session).stepCount = 0; },

    /** What index.js does on turn/end. */
    endTurn(session, turnNo, { reasonKind = 'completed', initiator = null } = {}) {
      const st = stateFor(session);
      if (!st.collector.hasContent) return { consumed: '', reviewed: false };

      // Consume unconditionally, before any decision (fixes 4 and 5).
      const snapshot = st.collector.snapshot();
      st.collector.reset();
      const stepCount = st.stepCount;
      st.stepCount = 1;

      // Capture the initiator before going async (fixes 6).
      const capturedInitiator = initiator;

      const reviewable = reasonKind === 'completed' || reasonKind === 'interrupted';
      const substantial = reasonKind === 'interrupted' || stepCount > 0;
      const foreground = !initiator?.agent?.session || initiator.agent.session === session;
      const due = reviewable && substantial && foreground && turnNo - st.lastReviewedTurn >= everyTurns;
      if (due) {
        st.lastReviewedTurn = turnNo;
        reviewed.push({ session, turnNo, snapshot, initiator: capturedInitiator });
      }
      return { consumed: snapshot, reviewed: due };
    },
  };
}

const sessionA = { id: 'A' };
const sessionB = { id: 'B' };

test('1: two sessions never see each other\'s text', () => {
  const r = makeReviewer({ everyTurns: 1 });
  r.add(sessionA, 'user', 'deploy the warehouse service');
  r.add(sessionB, 'user', 'fix the invoice template');
  r.add(sessionA, 'assistant', 'restarting smallwh now');
  r.add(sessionB, 'assistant', 'updating the docx layout');

  const a = r.peek(sessionA);
  const b = r.peek(sessionB);
  assert.ok(a.includes('warehouse') && a.includes('smallwh'));
  assert.ok(!a.includes('invoice') && !a.includes('docx'),
    'a lesson stitched from two conversations is worse than no lesson');
  assert.ok(b.includes('invoice') && b.includes('docx'));
  assert.ok(!b.includes('warehouse'));
});

test('2: ending a turn in A does not clear B\'s buffer', () => {
  const r = makeReviewer({ everyTurns: 1 });
  r.add(sessionA, 'user', 'first conversation');
  r.add(sessionB, 'user', 'second conversation, still going');

  r.endTurn(sessionA, 1);
  assert.equal(r.peek(sessionA), '', 'A consumed its own buffer');
  assert.ok(r.peek(sessionB).includes('still going'),
    'B was mid-turn and must be untouched');
});

test('3: throttle counters are per session', () => {
  const r = makeReviewer({ everyTurns: 5 });

  // A runs a long conversation and gets reviewed at turn 5.
  for (let t = 1; t <= 5; t += 1) {
    r.add(sessionA, 'user', `a-turn-${t}`);
    r.endTurn(sessionA, t);
  }
  assert.equal(r.reviewed.filter((x) => x.session === sessionA).length, 1);

  // B is only on its third turn. With a shared counter, A's turn 5 would have
  // moved the goalpost and B would be reviewed far too early or not at all.
  for (let t = 1; t <= 3; t += 1) {
    r.add(sessionB, 'user', `b-turn-${t}`);
    r.endTurn(sessionB, t);
  }
  assert.equal(r.reviewed.filter((x) => x.session === sessionB).length, 0,
    'B has not reached its own threshold yet');

  r.add(sessionB, 'user', 'b-turn-4');
  r.endTurn(sessionB, 4);
  r.add(sessionB, 'user', 'b-turn-5');
  const last = r.endTurn(sessionB, 5);
  assert.equal(last.reviewed, true, 'B is reviewed on ITS fifth turn');
  assert.ok(!last.consumed.includes('b-turn-4'),
    'and the snapshot is just this turn, not everything since the last review');
});

test('4: a snapshot describes ONE turn, even when no review runs', () => {
  // This is the consequence of resetting only when due: the reviewer prompt says
  // "ONE finished turn" while the text spanned several.
  const r = makeReviewer({ everyTurns: 10 });
  r.add(sessionA, 'user', 'turn one content');
  const first = r.endTurn(sessionA, 1);
  assert.equal(first.reviewed, false, 'not due yet');
  assert.ok(first.consumed.includes('turn one'));

  r.add(sessionA, 'user', 'turn two content');
  const second = r.endTurn(sessionA, 2);
  assert.ok(second.consumed.includes('turn two'));
  assert.ok(!second.consumed.includes('turn one'),
    'throttling decides whether to call the LLM, not whether to keep the text');
});

test('5: a turn that ended in an error is skipped AND its buffer cleared', () => {
  const r = makeReviewer({ everyTurns: 1 });
  r.add(sessionA, 'user', 'this attempt blew up');
  const bad = r.endTurn(sessionA, 1, { reasonKind: 'error' });
  assert.equal(bad.reviewed, false, 'a failed turn is a bad basis for a lesson');
  assert.equal(r.peek(sessionA), '', 'and its noise must not survive into the next review');

  r.add(sessionA, 'user', 'a clean turn');
  const good = r.endTurn(sessionA, 2);
  assert.equal(good.reviewed, true);
  assert.ok(!good.consumed.includes('blew up'),
    'the failed turn must not contaminate the next snapshot');
});

test('6: the initiator is captured before the async hop', () => {
  const r = makeReviewer({ everyTurns: 1 });
  r.add(sessionA, 'user', 'work in session A');
  r.endTurn(sessionA, 1, { initiator: { agent: 'agent-A' } });

  // Session B's turn ends with a different initiator; A's recorded value must
  // not have been overwritten by whatever was current later.
  r.add(sessionB, 'user', 'work in session B');
  r.endTurn(sessionB, 1, { initiator: { agent: 'agent-B' } });

  assert.deepEqual(r.reviewed.map((x) => x.initiator.agent), ['agent-A', 'agent-B'],
    'each review must carry the initiator that was current at ITS turn/end');
});

test('an empty turn is a no-op', () => {
  const r = makeReviewer({ everyTurns: 1 });
  const out = r.endTurn(sessionA, 1);
  assert.deepEqual(out, { consumed: '', reviewed: false });
  assert.equal(r.reviewed.length, 0, 'nothing was said, so there is nothing to review');
});

test('the collector still bounds what it keeps', () => {
  const c = new TurnSnapshotCollector({ maxChars: 60 });
  c.add('user', 'x'.repeat(200));
  assert.ok(c.snapshot().length <= 60, 'a runaway turn must not become an unbounded prompt');
  c.add('assistant', 'more text that should be refused');
  assert.ok(c.snapshot().length <= 60);
});

// ── the real plugin, not just this reproduction ──────────────────────────────
// The tests above exercise a copy of the wiring, which proves the design but not
// that index.js actually uses it. This project has been burned by "defined but
// never called" enough times to check the real source.

test('index.js wires review state per session, not process-wide', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'lib', 'index.js'), 'utf8');

  assert.match(src, /perSession = new WeakMap\(\)/,
    'state must be keyed by session so it disappears with the session');
  assert.match(src, /reviewStateFor/, 'and reached through a per-session accessor');

  // The old shape: a single collector and counter shared by everything.
  assert.ok(!/const reviewCollector = /.test(src),
    'a process-wide collector is exactly the bug');
  assert.ok(!/^\s*let lastReviewedTurn = 0;/m.test(src),
    'a process-wide turn counter lets one session starve another');

  // Consumption must not sit inside the `due` branch.
  const consumeIdx = src.indexOf('reviewState.collector.reset()');
  const dueIdx = src.indexOf('const due = ');
  assert.ok(consumeIdx > 0 && dueIdx > 0, 'both statements must exist');
  assert.ok(consumeIdx < dueIdx,
    'the buffer must be consumed BEFORE the throttle decision, or a snapshot '
    + 'claiming one turn will contain several');

  // The initiator must be read before the fire-and-forget task starts. Search
  // the review block specifically -- looking from the top of the file finds an
  // unrelated earlier match and the assertion passes for the wrong reason.
  const asyncIdx = src.indexOf('void (async () => {', consumeIdx);
  assert.ok(asyncIdx > consumeIdx, 'the fire-and-forget review task must exist');
  const beforeAsync = src.slice(consumeIdx, asyncIdx);
  // This was `slice(asyncIdx, asyncIdx + 2000)`, and because the assertion below is
  // NEGATIVE the window failed in the quiet direction: a task longer than 2000
  // characters simply stopped being checked past that point, so the guard could pass
  // while the very thing it bans sat at character 2100. (Measured: 2253 characters of
  // comment injected into the task left all 12 tests green.) The task is one
  // statement -- `void (async () => { ... })();` -- so bound it by that statement and
  // the whole body is always covered.
  const insideAsync = enclosingStatement(src, asyncIdx);
  assert.ok(insideAsync.includes('})') && insideAsync.length > 200,
    'the async task statement must be captured in full, not clipped');
  assert.match(beforeAsync, /currentInitiator\?\.\(\)/,
    'the initiator must be captured synchronously, while it still refers to THIS session');
  assert.ok(!/currentInitiator\?\.\(\)/.test(insideAsync),
    'reading it inside the async task can pick up whichever session became current');

  assert.match(src, /reasonKind === 'completed' \|\| reasonKind === 'interrupted'/,
    'only completed/interrupted turns may be reviewed');
  assert.match(src, /const substantial = reasonKind === 'interrupted' \|\| stepCount > 0/,
    'completed greetings must not spend a review call');
  assert.match(src, /initiator\.agent\.session === session/,
    'background/subagent initiators must not self-review');
});

test('S3: blocked/aborted/error skip, interrupted is reviewed', () => {
  for (const bad of ['blocked','aborted','error']) { const r=makeReviewer({everyTurns:1}); r.add(sessionA,'user','work'); assert.equal(r.endTurn(sessionA,1,{reasonKind:bad}).reviewed,false,bad) }
  const r=makeReviewer({everyTurns:1}); r.add(sessionA,'user','wrong path corrected'); assert.equal(r.endTurn(sessionA,1,{reasonKind:'interrupted'}).reviewed,true);
});

test('S3: a completed turn without any step is not substantial', () => {
  const r=makeReviewer({everyTurns:1}); r.add(sessionA,'user','first substantial'); r.endTurn(sessionA,1);
  r.add(sessionA,'user','hello only'); r.noStep(sessionA); assert.equal(r.endTurn(sessionA,2).reviewed,false);
});

test('S3: a background initiator cannot trigger self-review', () => {
  const r=makeReviewer({everyTurns:1}); r.add(sessionA,'user','substantial');
  assert.equal(r.endTurn(sessionA,1,{initiator:{agent:{session:sessionB}}}).reviewed,false);
});
