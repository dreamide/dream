import { expect, test } from "vitest";
import { createSocketTickets } from "./socket-tickets.js";

test("a ticket is redeemed once", () => {
  const tickets = createSocketTickets();
  const ticket = tickets.issue();

  expect(tickets.redeem(ticket)).toBe(true);
  expect(tickets.redeem(ticket)).toBe(false);
});

test("an expired or unknown ticket is refused", () => {
  let time = 0;
  const tickets = createSocketTickets({ ttlMs: 1000, now: () => time });
  const ticket = tickets.issue();
  time = 1000;

  expect(tickets.redeem(ticket)).toBe(false);
  expect(tickets.redeem("nope")).toBe(false);
  expect(tickets.redeem(undefined)).toBe(false);
});
