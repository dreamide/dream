/**
 * This window's id as a client of its hosts. Sent with every API request
 * (`x-dream-client-id`), so a host stamps the changes this window makes
 * with it and the window can tell its own echoes from other clients'
 * changes on the host socket.
 */
export const CLIENT_ID_HEADER = "x-dream-client-id";

export const CLIENT_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `client-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
