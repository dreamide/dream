// How every request reaches a host: never following a redirect, and telling
// the connection supervisor what the host answered or that it could not be
// reached. The network is a fake.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { fetchFromHost, isTransientHostStatus } from "./host-endpoint";
import { connectionSupervisor } from "./runtime";

afterEach(() => vi.restoreAllMocks());

const reports = () => {
  const report = vi
    .spyOn(connectionSupervisor, "report")
    .mockImplementation(() => {});
  return () => report.mock.calls.map(([hostId, state]) => [hostId, state]);
};

test("a request never follows a redirect, and the host's answer is reported", async () => {
  const seen = reports();
  const sent: RequestInit[] = [];
  const response = await fetchFromHost(
    "devbox",
    "/api/hosts/devbox/api/chat",
    { method: "POST", redirect: "follow" },
    async (_input, init) => {
      sent.push(init ?? {});
      return new Response("ok");
    },
  );
  assert.equal(await response.text(), "ok");
  assert.equal(sent[0].redirect, "error");
  assert.equal(sent[0].method, "POST");
  assert.deepEqual(seen(), [["devbox", "ok"]]);
});

test("an unauthorized answer says so; a failed request says the host is unreachable", async () => {
  const seen = reports();
  await fetchFromHost(
    "devbox",
    "/api/x",
    {},
    async () => new Response("", { status: 401 }),
  );
  await assert.rejects(
    fetchFromHost("devbox", "/api/x", {}, async () => {
      throw new TypeError("Failed to fetch");
    }),
    /Failed to fetch/,
  );
  assert.deepEqual(seen(), [
    ["devbox", "unauthorized"],
    ["devbox", "unreachable"],
  ]);
});

test("a request its caller aborted says nothing about the host", async () => {
  const seen = reports();
  await assert.rejects(
    fetchFromHost("devbox", "/api/x", {}, async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    }),
    /aborted/,
  );
  assert.deepEqual(seen(), []);
});

test("server errors, timeouts and rate limits are worth asking again; refusals are not", () => {
  for (const status of [500, 502, 503, 408, 429])
    assert.equal(isTransientHostStatus(status), true, String(status));
  for (const status of [200, 204, 400, 401, 403, 404, 409])
    assert.equal(isTransientHostStatus(status), false, String(status));
});
