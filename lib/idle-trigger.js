/**
 * Idle-refresh trigger (v0.4.2, opt-in, DEFAULT OFF).
 *
 * Refreshes disposal candidates when the user is actually idle, WITHOUT a
 * standing timer. A single unref'd setTimeout, re-armed on each write (the
 * "no polling, no cron" pattern): it fires once when the idle window elapses,
 * and any write clears and re-arms it. unref() means it never keeps the process
 * alive. The callback does a READ-ONLY candidate recompute -- never any disposal.
 *
 * ⚠️ NEVER setInterval / polling.
 *
 * ── Why enabled is a predicate, not a boolean ────────────────────────────────
 *
 * It used to be destructured into the closure as a value, evaluated once when
 * the plugin applied its config. setConfig() mutates the config object in place,
 * so the object changed but the captured boolean never did: switching
 * disposalMode from manual to suggest in the settings page armed nothing, and the
 * candidate list stayed empty until the whole service restarted. Reproduced:
 *
 *     cfg={disposalMode:'manual'} -> createIdleTrigger({enabled:false})
 *     cfg.disposalMode='suggest'  -> noteWrite() -> isArmed() === false
 *
 * Reading the live config through a predicate fixes "the next write sees the new
 * value". It does NOT fix "the switch takes effect now", because arming only
 * happens on a write -- a user who flips the toggle and then sits still would
 * still wait forever. reconfigure() closes that gap.
 *
 * @module dsh-evolve/idle-trigger
 */
export function createIdleTrigger({
  // Preferred: predicates, read at decision time.
  isEnabled,
  getIdleMinutes,
  // Legacy value form, still accepted so existing callers keep working.
  enabled,
  idleMinutes,
  onIdle,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
}) {
  let timer = null;
  let disposed = false;

  const enabledNow = typeof isEnabled === 'function' ? isEnabled : () => !!enabled;
  const idleMsNow = () => {
    const minutes = typeof getIdleMinutes === 'function' ? getIdleMinutes() : idleMinutes;
    return Math.max(0, (minutes ?? 5) * 60000);
  };

  function arm() {
    if (disposed || !enabledNow()) return;
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(async () => {
      timer = null;
      if (disposed) return;
      // Re-check on fire: the user may have switched the feature off during the
      // idle window, and running the callback then would contradict the setting.
      if (!enabledNow()) return;
      try { await onIdle(); } catch { /* best-effort read-only refresh */ }
    }, idleMsNow());
    // don't keep the event loop alive just for a refresh
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function cancel() {
    if (timer) { clearTimeoutFn(timer); timer = null; }
  }

  return {
    /** Call on every store write: reset the idle clock (clear + re-arm). */
    noteWrite() {
      if (disposed || !enabledNow()) return;
      arm();
    },

    /**
     * Call after a config change so it takes effect immediately.
     *
     * Turning the feature on starts the idle clock right away instead of waiting
     * for the next write; turning it off cancels the pending timer instead of
     * leaving one running for a feature that is now disabled.
     */
    reconfigure() {
      if (disposed) return;
      if (enabledNow()) arm();
      else cancel();
    },

    /** Whether a timer is currently pending (for tests). */
    isArmed() { return timer !== null; },

    dispose() {
      disposed = true;
      cancel();
    },
  };
}
