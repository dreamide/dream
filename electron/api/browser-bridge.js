/**
 * Holder for the main-process browser agent bridge.
 *
 * The Hono API runs inside the Electron main process, but `electron/api`
 * modules deliberately avoid importing `electron` so they stay unit-testable.
 * `main.js` creates the bridge and registers it here; tool code reads it.
 */

let browserBridge = null;

export const setBrowserBridge = (bridge) => {
  browserBridge = bridge ?? null;
};

export const getBrowserBridge = () => browserBridge;
