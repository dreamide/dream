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

/**
 * `POST /api/host/settings`: who this host is and every option it runs with,
 * with where each came from (host/settings-report.js), for Settings.
 * @param {import("hono").Hono} app
 * @param {(() => object) | undefined} getHostSettings
 */
export function registerHostSettingsRoute(app, getHostSettings) {
  app.post("/api/host/settings", (c) =>
    getHostSettings
      ? c.json(getHostSettings())
      : c.text("This host does not report its settings.", 404),
  );
}
