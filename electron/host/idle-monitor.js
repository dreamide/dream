// Shuts an idle daemon down. Idle means nothing at all is going on (no
// client on the terminal socket, no live terminal, no request being
// answered) continuously for `timeoutMs`. Work never counts as idle, so a
// disconnected client's terminals keep the daemon alive indefinitely.

export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * @param {{
 *   timeoutMs: number,
 *   isBusy: () => boolean,
 *   onIdle: () => void,
 *   checkIntervalMs?: number,
 *   now?: () => number,
 *   setInterval?: (callback: () => void, ms: number) => unknown,
 *   clearInterval?: (timer: unknown) => void,
 * }} options
 *   `timeoutMs` of 0 (or not finite) never shuts down.
 */
export function createIdleMonitor({
  timeoutMs,
  isBusy,
  onIdle,
  checkIntervalMs,
  now = () => Date.now(),
  setInterval: schedule = (callback, ms) => {
    const timer = setInterval(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearInterval: cancel = (timer) => clearInterval(timer),
}) {
  const enabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
  let idleSince = null;
  let timer = null;
  let fired = false;

  const tick = () => {
    if (!enabled || fired) return;
    if (isBusy()) {
      idleSince = null;
      return;
    }
    idleSince ??= now();
    if (now() - idleSince >= timeoutMs) {
      fired = true;
      stop();
      onIdle();
    }
  };

  const stop = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  return {
    enabled,
    tick,
    stop,
    start() {
      if (!enabled || timer !== null) return;
      idleSince = now();
      timer = schedule(
        tick,
        checkIntervalMs ?? Math.min(30_000, Math.max(1_000, timeoutMs / 10)),
      );
    },
  };
}
