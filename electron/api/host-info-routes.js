// `GET /api/host-info`: who this host is, for a client deciding whether it
// can talk to it (protocol version and capabilities) and a launcher deciding
// whether a running daemon can be reused.

/**
 * @param {import("hono").Hono} app
 * @param {() => object} getHostInfo
 */
export function registerHostInfoRoute(app, getHostInfo) {
  app.get("/api/host-info", (c) => c.json(getHostInfo()));
}
