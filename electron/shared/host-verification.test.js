// Whether the host a route reached is the one a connection expects: one
// predicate for every pinned identity, and the checks around it.
import assert from "node:assert/strict";
import { test } from "vitest";
import { SUPPORTED_HOST_PROTOCOLS } from "../host/protocol.js";
import { acceptHostDescriptor } from "./host-connections.js";
import {
  catalogMatchesHost,
  hostProtocolProblem,
  matchesPinnedIdentity,
} from "./host-verification.js";

const PINNED = { hostId: "host_a", fingerprint: "SHA256:a" };

test.each([
  [
    "the same host",
    PINNED,
    { hostId: "host_a", fingerprint: "SHA256:a" },
    true,
  ],
  [
    "another host ID",
    PINNED,
    { hostId: "host_b", fingerprint: "SHA256:a" },
    false,
  ],
  [
    "another fingerprint",
    PINNED,
    { hostId: "host_a", fingerprint: "SHA256:b" },
    false,
  ],
  [
    "no fingerprint against a pinned one",
    PINNED,
    { hostId: "host_a", fingerprint: null },
    false,
  ],
  [
    "no fingerprint field against a pinned one",
    PINNED,
    { hostId: "host_a" },
    false,
  ],
  ["a host that names no ID", PINNED, { fingerprint: "SHA256:a" }, false],
  ["nothing reported", PINNED, null, false],
  [
    "no pinned fingerprint",
    { hostId: "host_a", fingerprint: null },
    { hostId: "host_a", fingerprint: "SHA256:b" },
    true,
  ],
  [
    "no pinned fingerprint, none reported",
    { hostId: "host_a" },
    { hostId: "host_a", fingerprint: null },
    true,
  ],
  [
    "no pinned fingerprint, another host ID",
    { hostId: "host_a", fingerprint: null },
    { hostId: "host_b", fingerprint: null },
    false,
  ],
])("pinned identity: %s", (_name, pinned, reported, expected) => {
  assert.equal(matchesPinnedIdentity(pinned, reported), expected);
});

test.each([
  ["the verified host", { host: PINNED }, true],
  [
    "another fingerprint",
    { host: { hostId: "host_a", fingerprint: "SHA256:b" } },
    false,
  ],
  ["no fingerprint", { host: { hostId: "host_a" } }, false],
  [
    "another host",
    { host: { hostId: "host_b", fingerprint: "SHA256:a" } },
    false,
  ],
  ["no descriptor", {}, false],
])("catalog matches its verified host: %s", (_name, catalog, expected) => {
  assert.equal(catalogMatchesHost(catalog, PINNED), expected);
});

test("protocol check names what to update", () => {
  const { min, max } = SUPPORTED_HOST_PROTOCOLS;
  assert.equal(hostProtocolProblem(min), null);
  assert.equal(hostProtocolProblem(max), null);
  assert.match(
    hostProtocolProblem(undefined) ?? "",
    /did not say which protocol/,
  );
  assert.match(hostProtocolProblem("1") ?? "", /did not say which protocol/);
  assert.match(
    hostProtocolProblem(max + 1) ?? "",
    /Update Dream on this computer/,
  );
  assert.match(hostProtocolProblem(min - 1) ?? "", /Update dream-host there/);
});

// Saved host connections use the strict predicate too: a host that names
// the saved ID but drops the saved fingerprint is not loaded.
test("a saved connection refuses a host that reports no fingerprint", () => {
  const saved = {
    version: 1,
    id: "box",
    hostId: "host_a",
    fingerprint: "SHA256:a",
    verifiedAt: null,
    routes: [{ id: "ssh:box", kind: "ssh", sshHostId: "box" }],
  };
  const accept = (descriptor) =>
    acceptHostDescriptor([saved], {
      connectionId: "box",
      descriptor: { hostProtocolVersion: 1, ...descriptor },
      labelOf: () => "box",
    });
  assert.equal(accept(PINNED).error, null);
  assert.match(
    accept({ hostId: "host_a" }).error ?? "",
    /different Dream host/,
  );
});
