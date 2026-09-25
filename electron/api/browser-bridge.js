/**
 * Holder for the main-process browser agent bridge.
 *
 * The Hono API runs inside the Electron main process, but `electron/api`
 * modules deliberately avoid importing `electron` so they stay unit-testable.
 * `main.js` creates the bridge and registers it here; tool code reads it.
 */

let browserBridge = null;
let browserMcpEndpoint = null;

export const setBrowserBridge = (bridge) => {
  browserBridge = bridge ?? null;
};

export const getBrowserBridge = () => browserBridge;

/**
 * Where external agent CLIs (Codex, OpenCode, ACP adapters) reach the browser
 * tools over Streamable HTTP. Set by the API server once it is listening.
 * `{ url, headers }`; `url` has no trailing slash and no project segment.
 */
export const setBrowserMcpEndpoint = (endpoint) => {
  browserMcpEndpoint =
    endpoint && typeof endpoint.url === "string" && endpoint.url
      ? { headers: { ...(endpoint.headers ?? {}) }, url: endpoint.url }
      : null;
};

export const getBrowserMcpEndpoint = () => browserMcpEndpoint;
