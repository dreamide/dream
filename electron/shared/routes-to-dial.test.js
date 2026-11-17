// What connecting a saved host dials, and the one check of that shape where
// it reaches the main process.
import { expect, test } from "vitest";
import { listHostChoices } from "./host-connections.js";
import {
  connectionOfSshHost,
  MAX_HOST_ROUTES,
  readConnectRequest,
  routesToDial,
  sshHostOf,
} from "./routes-to-dial.js";

const SSH_HOSTS = [
  { id: "devbox", label: "Devbox", target: "me@devbox" },
  { id: "ci", label: "CI", target: "ci.example" },
];

const saved = (routes, extra = {}) => ({
  version: 1,
  id: "conn-1",
  hostId: "host_a",
  fingerprint: "SHA256:a",
  verifiedAt: "2026-11-01T00:00:00.000Z",
  routes,
  ...extra,
});

const HTTPS = {
  id: "https:1",
  kind: "https",
  origin: "https://host.example",
  credentialId: "cred-1",
};

test.each([
  {
    name: "an SSH host never saved dials its own SSH route, unpinned",
    connectionId: "devbox",
    saved: null,
    expected: {
      hostId: "devbox",
      routes: [{ id: "ssh:devbox", kind: "ssh", target: "me@devbox" }],
      expectedIdentity: null,
    },
  },
  {
    name: "an SSH host gone from Settings has nothing to dial",
    connectionId: "gone",
    saved: null,
    expected: { hostId: "gone", routes: [], expectedIdentity: null },
  },
  {
    name: "a saved connection dials its routes in order, pinned to its host",
    connectionId: "conn-1",
    saved: saved([
      { id: "ssh:ci", kind: "ssh", sshHostId: "ci" },
      HTTPS,
      { id: "ssh:devbox", kind: "ssh", sshHostId: "devbox" },
    ]),
    expected: {
      hostId: "conn-1",
      routes: [
        { id: "ssh:ci", kind: "ssh", target: "ci.example" },
        HTTPS,
        { id: "ssh:devbox", kind: "ssh", target: "me@devbox" },
      ],
      expectedIdentity: { hostId: "host_a", fingerprint: "SHA256:a" },
    },
  },
  {
    name: "a saved SSH route whose host left Settings is left out",
    connectionId: "conn-1",
    saved: saved([{ id: "ssh:gone", kind: "ssh", sshHostId: "gone" }, HTTPS]),
    expected: {
      hostId: "conn-1",
      routes: [HTTPS],
      expectedIdentity: { hostId: "host_a", fingerprint: "SHA256:a" },
    },
  },
  {
    name: "the home host's own route and a page's origin are not dialed",
    connectionId: "local",
    saved: saved(
      [
        { id: "local", kind: "local" },
        { id: "origin:https://x.example", kind: "origin", origin: "x" },
        HTTPS,
      ],
      { id: "local", fingerprint: null },
    ),
    expected: {
      hostId: "local",
      routes: [HTTPS],
      expectedIdentity: { hostId: "host_a", fingerprint: null },
    },
  },
])("$name", ({ connectionId, saved, expected }) => {
  const request = routesToDial({ connectionId, saved, sshHosts: SSH_HOSTS });
  expect(request).toEqual(expected);
  // What the renderer resolves is what the main process accepts.
  if (request.routes.length)
    expect(readConnectRequest(request)).toEqual(request);
});

test("an SSH route's host and a host choice's target come from the same join", () => {
  const route = { id: "ssh:ci", kind: "ssh", sshHostId: "ci" };
  expect(sshHostOf(route, SSH_HOSTS)).toBe(SSH_HOSTS[1]);
  expect(sshHostOf(HTTPS, SSH_HOSTS)).toBeNull();
  expect(
    listHostChoices([saved([HTTPS, route])], SSH_HOSTS).find(
      (choice) => choice.id === "conn-1",
    ),
  ).toMatchObject({ label: "CI", target: "ci.example" });
});

const ssh = (id, target = "box") => ({ id, kind: "ssh", target });

test.each([
  ["no payload", undefined, "A connection needs an id."],
  ["no connection id", { routes: [ssh("a")] }, "A connection needs an id."],
  [
    "no routes",
    { hostId: "h", routes: [] },
    `A connection needs between 1 and ${MAX_HOST_ROUTES} routes.`,
  ],
  [
    "a bare SSH target",
    { hostId: "h", target: "box" },
    `A connection needs between 1 and ${MAX_HOST_ROUTES} routes.`,
  ],
  [
    "too many routes",
    {
      hostId: "h",
      routes: Array.from({ length: MAX_HOST_ROUTES + 1 }, (_, i) =>
        ssh(`r${i}`),
      ),
    },
    `A connection needs between 1 and ${MAX_HOST_ROUTES} routes.`,
  ],
  [
    "a route with no id",
    { hostId: "h", routes: [{ kind: "ssh", target: "box" }] },
    "A route needs an id.",
  ],
  [
    "an SSH route with no target",
    { hostId: "h", routes: [{ id: "a", kind: "ssh", target: " " }] },
    "Each route needs an SSH target or paired HTTPS origin.",
  ],
  [
    "an SSH route named by its Settings id",
    { hostId: "h", routes: [{ id: "a", kind: "ssh", sshHostId: "a" }] },
    "Each route needs an SSH target or paired HTTPS origin.",
  ],
  [
    "an HTTPS route with no credential",
    {
      hostId: "h",
      routes: [{ id: "a", kind: "https", origin: "https://x.example" }],
    },
    "Each route needs an SSH target or paired HTTPS origin.",
  ],
  [
    "repeated route ids",
    { hostId: "h", routes: [ssh("a"), ssh("a", "other")] },
    "Route ids must be distinct.",
  ],
  [
    "an expected host with no id",
    { hostId: "h", routes: [ssh("a")], expectedIdentity: { fingerprint: "" } },
    "An expected host needs an id and a fingerprint or null.",
  ],
])("a connect request with %s is refused", (_case, payload, message) => {
  expect(() => readConnectRequest(payload)).toThrow(message);
});

test("a connect request is read with only the fields it names, its target trimmed", () => {
  expect(
    readConnectRequest({
      hostId: "h",
      routes: [
        { id: "a", kind: "ssh", target: " me@box ", extra: true },
        { ...HTTPS, token: "secret" },
      ],
      expectedIdentity: { hostId: "host_a", fingerprint: null },
    }),
  ).toEqual({
    hostId: "h",
    routes: [{ id: "a", kind: "ssh", target: "me@box" }, HTTPS],
    expectedIdentity: { hostId: "host_a", fingerprint: null },
  });
});

test("the connection that reaches an SSH host is found by its route", () => {
  const connection = saved([
    { id: "ssh:devbox", kind: "ssh", sshHostId: "devbox" },
    HTTPS,
  ]);
  expect(connectionOfSshHost([connection], "devbox")).toBe(connection);
  expect(connectionOfSshHost([connection], "ci")).toBeNull();
  expect(connectionOfSshHost(undefined, "devbox")).toBeNull();
});
