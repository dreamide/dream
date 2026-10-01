// The token every /api/* request carries (the host socket excepted, see
// host-socket-routes.js). A small module of its own so a daemon launcher can
// use it without loading the whole API.
import { randomBytes } from "node:crypto";

export const API_SESSION_TOKEN_HEADER = "x-dream-api-token";

export function createApiSessionToken() {
  return randomBytes(32).toString("hex");
}
