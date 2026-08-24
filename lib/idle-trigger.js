/**
 * Idle-refresh trigger (v0.4.2, opt-in, DEFAULT OFF).
 *
 * Refreshes prune candidates when the user is actually idle, WITHOUT a standing
 * timer. Uses a single unref'd setTimeout re-armed on each write (the
 * "no polling, no cron" pattern): the timer fires once when the idle window
 * elapses; any write clears+re-arms it. unref() means it never keeps the process
 * alive. Callback does READ-ONLY candidate recompute only — NEVER any disposal.
 * dispose() must clear the pending timer.
 *
 * ⚠️ NEVER setInterval / polling.
 *
 * @module dsh-evolve/idle-trigger
 */
export function createIdleTrigger({ enabled, idleMinutes, onIdle, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = () => Date.now() }) {
  let timer = null;
  let disposed = false;
  const idleMs = Math.max(0, (idleMinutes ?? 5) * 60000);

  function arm() {
    if (disposed || !enabled) return;
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(async () => {
      timer = null;
      if (disposed) return;
      try { await onIdle(); } catch { /* best-effort read-only refresh */ }
    }, idleMs);
    // don't keep the event loop alive just for a refresh
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    /** Call on every store write: reset the idle clock (clear + re-arm). */
    noteWrite() {
      if (disposed || !enabled) return;
      arm();
    },
    /** Whether a timer is currently pending (for tests). */
    isArmed() { return timer !== null; },
    dispose() {
      disposed = true;
      if (timer) { clearTimeoutFn(timer); timer = null; }
    },
  };
}
