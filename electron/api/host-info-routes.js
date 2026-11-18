import { HOST_ROUTES } from "../shared/host-routes.js";
import { registerRoute } from "./shared/register-route.js";
// `GET /api/host-info`: who this host is, for a client deciding whether it
// can talk to it (protocol version and capabilities) and a launcher deciding
// whether a running daemon can be reused.

/**
 * @param {import("hono").Hono} app
 * @param {() => object} getHostInfo
 */
export function registerHostInfoRoute(app, getHostInfo) {
  registerRoute(app, HOST_ROUTES.hostInfo, (c) => c.json(getHostInfo()));
}
