// One-time tickets for WebSocket upgrades. A browser WebSocket cannot send
// the API token header, so a client first asks for a ticket over a guarded
// JSON route and then opens the socket with `?ticket=`. A ticket works once
// and expires quickly, so a long-lived token never appears in a URL.
import { randomBytes } from "node:crypto";

export const SOCKET_TICKET_TTL_MS = 30_000;

export function createSocketTickets({
  ttlMs = SOCKET_TICKET_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const tickets = new Map();

  const prune = () => {
    const time = now();
    for (const [ticket, expiresAt] of tickets) {
      if (expiresAt <= time) tickets.delete(ticket);
    }
  };

  return {
    issue() {
      prune();
      const ticket = randomBytes(24).toString("hex");
      tickets.set(ticket, now() + ttlMs);
      return ticket;
    },

    /** True once for a live ticket; false for unknown, used or expired. */
    redeem(ticket) {
      if (typeof ticket !== "string" || !tickets.has(ticket)) return false;
      const expiresAt = tickets.get(ticket);
      tickets.delete(ticket);
      return expiresAt > now();
    },
  };
}
