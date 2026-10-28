import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  RemoteAccessStatus,
  RemoteClaim,
  RemoteDeviceSession,
  RemotePairing,
} from "@/lib/api-client";
import {
  createFakeApiClient,
  type FakeApiHandlers,
} from "@/lib/api-client-fake";
import { createRemoteAccessState } from "./remote-access-state";

const device: RemoteDeviceSession = {
  id: "phone",
  deviceName: "Phone",
  clientKind: "web",
  scopes: ["view", "operate"],
  grantedBy: "operator",
  createdAt: "2026-10-25",
  lastUsedAt: "2026-10-25",
  expiresAt: "2026-11-25",
  revokedAt: null,
};
const status: RemoteAccessStatus = {
  enabled: true,
  ready: true,
  listening: true,
  mode: "cloudflare",
  port: 4321,
  httpsPort: 443,
  origin: "https://host.example",
  requestedOrigin: "https://host.example",
  checkedAt: "2026-10-25",
  problem: null,
};
const pairing: RemotePairing = {
  pairingId: "pair",
  code: "123456",
  fragment: "pair=secret",
  scopes: ["view"],
  expiresAt: "2026-10-25",
  urls: ["https://host.example/pair#pair=secret"],
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const models: ReturnType<typeof createRemoteAccessState>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const model of models.splice(0)) model.stop();
  vi.useRealTimers();
});

const setup = (overrides: FakeApiHandlers = {}) => {
  const server = {
    status: { ...status },
    devices: [{ ...device }],
    claims: [] as RemoteClaim[],
  };
  const { client, calls } = createFakeApiClient({
    remoteAccess: () => server.status,
    remoteClaims: () => ({ claims: server.claims }),
    remoteSessions: () => ({ sessions: server.devices }),
    remoteSessionRevoke: ({ sessionId }) => {
      const revoked = { ...device, id: sessionId, revokedAt: "2026-10-26" };
      server.devices = [revoked];
      return { session: revoked };
    },
    remoteAccessDisable: () => {
      server.status = { ...server.status, enabled: false, ready: false };
      return server.status;
    },
    remoteAccessEnable: () => {
      server.status = { ...server.status, mode: "tailscale" };
      return server.status;
    },
    remoteAccessCheck: () => server.status,
    remotePairingCreate: () => pairing,
    remoteClaimAnswer: () => {
      server.claims = [];
      return { approved: true, session: device };
    },
    ...overrides,
  });
  const model = createRemoteAccessState({ api: client });
  models.push(model);
  model.start();
  return { model, server, calls };
};
const loaded = async (model: ReturnType<typeof createRemoteAccessState>) => {
  await vi.waitFor(() => expect(model.getSnapshot().status).not.toBeNull());
};

test("an old poll cannot resurrect a device after revocation and a fresh list", async () => {
  const old = deferred<{ sessions: RemoteDeviceSession[] }>();
  let reads = 0;
  const { model } = setup({
    remoteSessions: () => {
      reads += 1;
      if (reads === 2) return old.promise;
      return { sessions: reads === 1 ? [device] : [] };
    },
  });
  await loaded(model);
  const pending = model.refresh();
  expect(await model.revoke("phone")).toBe(true);
  await vi.waitFor(() => expect(reads).toBe(3));
  old.resolve({ sessions: [device] });
  await pending;
  expect(model.getSnapshot().devices).toEqual([]);
});

test("poll failure after a successful change preserves accepted status and form defaults", async () => {
  let fail = false;
  const { model } = setup({
    remoteAccess: () => {
      if (fail) throw new Error("Offline");
      return status;
    },
  });
  await loaded(model);
  fail = true;
  expect(await model.disable()).toBe(true);
  await model.refresh();
  expect(model.getSnapshot().status?.enabled).toBe(false);
  expect(model.getSnapshot().initialStatus).toEqual(status);
  expect(model.getSnapshot().error).toBeNull();
});

test("write failure retains devices and its error survives a background refresh", async () => {
  const { model } = setup({
    remoteSessionRevoke: () => {
      throw new Error("Permission denied");
    },
  });
  await loaded(model);
  expect(await model.revoke("phone")).toBe(false);
  await model.refresh();
  expect(model.getSnapshot().devices).toEqual([device]);
  expect(model.getSnapshot().error?.kind).toBe("change");
  expect(model.getSnapshot().busy).toBe(false);
});

test("stop invalidates a read and polling restarts safely after effect cleanup", async () => {
  const old = deferred<RemoteAccessStatus>();
  let reads = 0;
  const { model, calls } = setup({
    remoteAccess: () => (++reads === 1 ? old.promise : status),
  });
  model.stop();
  old.resolve({ ...status, enabled: false });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(model.getSnapshot().status).toBeNull();
  expect(calls.filter((call) => call.name === "remoteAccess")).toHaveLength(1);
  model.start();
  await loaded(model);
  expect(model.getSnapshot().status).toEqual(status);
});

test("a slow read never accumulates interval polls", async () => {
  const pending = deferred<RemoteAccessStatus>();
  const { model, calls } = setup({ remoteAccess: () => pending.promise });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls.filter((call) => call.name === "remoteAccess")).toHaveLength(1);
  pending.resolve(status);
  await loaded(model);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(calls.filter((call) => call.name === "remoteAccess")).toHaveLength(2);
});

test("a pending mutation refuses duplicate writes and cannot publish after disposal", async () => {
  const pending = deferred<RemoteAccessStatus>();
  const { model, calls } = setup({
    remoteAccessDisable: () => pending.promise,
  });
  await loaded(model);
  const first = model.disable();
  expect(model.getSnapshot().busy).toBe(true);
  expect(await model.disable()).toBe(false);
  expect(
    calls.filter((call) => call.name === "remoteAccessDisable"),
  ).toHaveLength(1);
  model.stop();
  pending.resolve({ ...status, enabled: false });
  expect(await first).toBe(false);
  expect(model.getSnapshot().status?.enabled).toBe(true);
  expect(model.getSnapshot().busy).toBe(false);
});

test("pairing results are discarded after the dialog resets; fresh results choose the verified address", async () => {
  const pending = deferred<RemotePairing>();
  let requests = 0;
  const { model } = setup({
    remotePairingCreate: () => (++requests === 1 ? pending.promise : pairing),
  });
  await loaded(model);
  const first = model.createPairing(["view"]);
  model.clearPairing();
  pending.resolve(pairing);
  await first;
  expect(model.getSnapshot().pairing).toBeNull();
  await model.createPairing(["view"]);
  expect(model.getSnapshot().pairingUrl).toBe(pairing.urls[0]);
});

test("claim answers and access commands share the accepted snapshot", async () => {
  const { model, server } = setup();
  server.claims = [
    {
      claimId: "claim",
      deviceName: "Phone",
      clientKind: "web",
      scopes: ["view"],
      createdAt: "2026-10-25",
      expiresAt: "2026-10-26",
    },
  ];
  await loaded(model);
  await model.refresh();
  expect(model.getSnapshot().claims).toHaveLength(1);
  await model.answer("claim", true);
  expect(model.getSnapshot().claims).toEqual([]);
  await model.enable({ mode: "tailscale", httpsPort: 443 });
  await model.check();
  expect(model.getSnapshot().status?.mode).toBe("tailscale");
  expect(model.getSnapshot().initialStatus?.mode).toBe("cloudflare");
});
