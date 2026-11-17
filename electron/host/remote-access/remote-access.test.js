import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { readRemoteAccess } from "../../shared/remote-access-view.js";
import { createRemoteAccess } from "./remote-access.js";
import { TailscaleProblem } from "./tailscale.js";

/** Remote access over a data directory whose settings file says `saved`. */
const withSaved = (saved) => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-remote-"));
  const settingsFile = path.join(dataDirectory, "remote-access.json");
  writeFileSync(settingsFile, JSON.stringify(saved));
  const calls = [];
  const access = createRemoteAccess({
    dataDirectory,
    settingsFile,
    hostId: () => "host",
    listen: async ({ port }) => {
      calls.push("listen");
      return { port, origins: [] };
    },
    close: async () => {
      calls.push("close");
    },
    fetchImpl: async () => Response.json({ hostId: "host" }),
    tailscale: {
      device: async () => {
        calls.push("tailscale");
        return { dnsName: "host.tailnet.ts.net" };
      },
      enable: async () => {
        calls.push("tailscale");
      },
      disable: async () => {
        calls.push("tailscale");
      },
    },
    pickPort: async () => 5410,
  });
  return { access, calls, settingsFile };
};

test("a host saved with the removed reverse-proxy mode starts with access off", async () => {
  const { access, calls } = withSaved({
    enabled: true,
    mode: "origin",
    origin: "https://dream.example.com",
    port: 5410,
    version: 1,
  });
  const status = await access.start();
  expect(status.enabled).toBe(false);
  expect(status.mode).toBe("tailscale");
  expect(status.requestedOrigin).toBeNull();
  // Nothing is exposed: no listener, and no Tailscale Serve entry.
  expect(calls).toEqual([]);
});

test("the enable route refuses the removed mode", async () => {
  const { remoteAccessEnableSchema } = await import(
    "../../api/remote-access-routes.js"
  );
  expect(remoteAccessEnableSchema.safeParse({ mode: "origin" }).success).toBe(
    false,
  );
  expect(
    remoteAccessEnableSchema.safeParse({ mode: "cloudflare" }).success,
  ).toBe(true);
});

test("a saved Cloudflare route keeps its settings", async () => {
  const { access } = withSaved({
    enabled: false,
    mode: "cloudflare",
    origin: "https://dream.example.com",
    cloudflareManaged: false,
    port: 5410,
    version: 1,
  });
  const status = await access.start();
  expect(status.mode).toBe("cloudflare");
  expect(status.requestedOrigin).toBe("https://dream.example.com");
  expect(status.phase).toBe("off");
  expect(status.cloudflare.managed).toBe(false);
});

test("switching to Tailscale keeps the Cloudflare address for switching back", async () => {
  const { access } = withSaved({
    enabled: false,
    mode: "cloudflare",
    origin: "https://dream.example.com",
    port: 5410,
    version: 1,
  });
  await access.start();
  const status = await access.enable({ mode: "tailscale", port: null });
  await access.disable();
  expect(status.mode).toBe("tailscale");
  // Not the active route's address, which the settings row and CLI show.
  expect(status.requestedOrigin).toBeNull();
  expect(status.cloudflare.origin).toBe("https://dream.example.com");
});

test("the host says whether the saved settings can be turned on", async () => {
  const cloudflare = {
    mode: "cloudflare",
    origin: "https://dream.example.com",
    version: 1,
  };
  const status = async (saved) =>
    (await withSaved(saved).access.start()).configured;
  expect(await status({ mode: "tailscale", version: 1 })).toBe(true);
  // The user runs the connector, so the address is all it needs, including
  // a file saved when Dream ran the connector itself.
  expect(await status(cloudflare)).toBe(true);
  expect(await status({ ...cloudflare, cloudflareManaged: true })).toBe(true);
  expect(await status({ ...cloudflare, origin: null })).toBe(false);
});

test("startup removes the token and runtime Dream once kept for cloudflared", async () => {
  const { access, settingsFile } = withSaved({
    enabled: false,
    mode: "cloudflare",
    origin: "https://dream.example.com",
    cloudflareManaged: true,
    version: 1,
  });
  const retired = `${settingsFile}.cloudflare`;
  mkdirSync(path.join(retired, "runtime"), { recursive: true });
  writeFileSync(path.join(retired, "tunnel-token"), "eyJ-secret");
  const status = await access.start();
  expect(existsSync(retired)).toBe(false);
  expect(status.cloudflare).toEqual({
    managed: false,
    defaultPort: 5410,
    origin: "https://dream.example.com",
  });
});

test("an unusable Cloudflare setup is refused and saves nothing", async () => {
  const saved = { mode: "tailscale", version: 1 };
  const refusal = async (request) => {
    const { access, settingsFile } = withSaved(saved);
    await access.start();
    const status = await access.enable(request);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual(saved);
    expect(status.enabled).toBe(false);
    expect(status.problem?.refused).toBe(true);
    return status.problem?.code;
  };
  expect(await refusal({ mode: "cloudflare" })).toBe("needs-origin");
  expect(
    await refusal({
      mode: "cloudflare",
      origin: "https://quiet-river.trycloudflare.com",
    }),
  ).toBe("quick-tunnel");
});

/** Remote access the host was started with (`--remote-port`, DH-14). */
const withOverride = (override, saved = { enabled: false, version: 1 }) => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-remote-"));
  const settingsFile = path.join(dataDirectory, "remote-access.json");
  writeFileSync(settingsFile, JSON.stringify(saved));
  const calls = [];
  const access = createRemoteAccess({
    close: async () => {
      calls.push("close");
    },
    dataDirectory,
    fetchImpl: async () => Response.json({ hostId: "host" }),
    hostId: () => "host",
    listen: async (options) => {
      calls.push(["listen", options]);
      return { origins: options.publicOrigins, port: options.port };
    },
    override,
    settingsFile,
    tailscale: {
      device: async () => {
        throw new Error("Tailscale is not used under an override.");
      },
    },
  });
  return { access, calls, settingsFile };
};

test("remote access set at start serves its port and reports where it came from", async () => {
  const { access, calls, settingsFile } = withOverride({
    origins: ["https://dream.example.com"],
    port: 6000,
    sources: { remoteOrigins: "--remote-origin", remotePort: "--remote-port" },
    trustForwardedHost: true,
  });
  const status = await access.start();
  expect(status).toMatchObject({
    address: "https://dream.example.com",
    enabled: true,
    listening: true,
    lockedBy: ["--remote-origin", "--remote-port"],
    mode: "proxy",
    origin: "https://dream.example.com",
    override: { sources: { remotePort: "--remote-port" } },
    phase: "ready",
    port: 6000,
    ready: true,
  });
  expect(calls).toEqual([
    [
      "listen",
      {
        port: 6000,
        publicOrigins: ["https://dream.example.com"],
        trustForwardedHost: true,
      },
    ],
  ]);

  // Settings cannot change it, and the saved settings are left alone.
  const refused = await access.enable({ mode: "tailscale" });
  expect(refused.problem).toMatchObject({ code: "overridden", refused: true });
  expect(refused.problem.message).toContain("--remote-port");
  // A refused change leaves the route as it was.
  expect(refused).toMatchObject({
    lockedBy: ["--remote-origin", "--remote-port"],
    phase: "ready",
  });
  const refusedOff = await access.disable();
  expect(refusedOff).toMatchObject({
    listening: true,
    phase: "ready",
    problem: { code: "overridden", refused: true },
  });
  expect(JSON.parse(readFileSync(settingsFile, "utf8")).enabled).toBe(false);
});

/** A Tailscale CLI fake that records what it was asked to serve. */
const fakeTailscale = (calls, { disable } = {}) => ({
  device: async () => {
    calls.push(["device"]);
    return { dnsName: "host.tailnet.ts.net" };
  },
  enable: async (entry) => {
    calls.push(["serve", entry]);
  },
  disable:
    disable ??
    (async (entry) => {
      calls.push(["unserve", entry]);
      return true;
    }),
});

/** Remote access over `saved`, with each part replaceable. */
const setUp = ({
  saved = { version: 1 },
  override = null,
  tailscale = fakeTailscale,
  listen,
  fetchImpl = async () => Response.json({ hostId: "host" }),
} = {}) => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-remote-"));
  const settingsFile = path.join(dataDirectory, "remote-access.json");
  writeFileSync(settingsFile, JSON.stringify(saved));
  const calls = [];
  const access = createRemoteAccess({
    close: async () => {
      calls.push(["close"]);
    },
    dataDirectory,
    fetchImpl,
    hostId: () => "host",
    listen:
      listen ??
      (async ({ port, publicOrigins }) => {
        calls.push(["listen", port, publicOrigins]);
        return { origins: publicOrigins, port };
      }),
    override,
    pickPort: async () => 5410,
    settingsFile,
    tailscale: tailscale(calls),
  });
  const read = () => JSON.parse(readFileSync(settingsFile, "utf8"));
  return { access, calls, read };
};

const TAILNET = "https://host.tailnet.ts.net";
const portInUse = async () => {
  throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
};

test("turning Tailscale on replaces the Serve entry Dream made for another port", async () => {
  const { access, calls, read } = setUp({
    saved: {
      enabled: false,
      httpsPort: 8443,
      mode: "tailscale",
      port: 5410,
      servedBy: { httpsPort: 8443, localPort: 5410 },
      version: 1,
    },
  });
  await access.start();
  const status = await access.enable({ httpsPort: 443 });
  expect(calls).toEqual([
    ["device"],
    ["listen", 5410, [TAILNET]],
    ["unserve", { httpsPort: 8443, localPort: 5410 }],
    ["serve", { httpsPort: 443, localPort: 5410 }],
  ]);
  expect(read().servedBy).toEqual({ httpsPort: 443, localPort: 5410 });
  expect(status).toMatchObject({
    address: TAILNET,
    enabled: true,
    lockedBy: null,
    mode: "tailscale",
    origin: TAILNET,
    phase: "ready",
    problem: null,
    ready: true,
  });

  // Checking again keeps the listener and Dream's own entry.
  calls.length = 0;
  expect((await access.refresh()).phase).toBe("ready");
  expect(calls).toEqual([
    ["device"],
    ["serve", { httpsPort: 443, localPort: 5410 }],
  ]);

  // Off: the listener closes and only Dream's entry is removed.
  calls.length = 0;
  const off = await access.disable();
  expect(calls).toEqual([
    ["close"],
    ["unserve", { httpsPort: 443, localPort: 5410 }],
  ]);
  expect(read().servedBy).toBeNull();
  expect(off).toMatchObject({
    address: null,
    enabled: false,
    listening: false,
    phase: "off",
    problem: null,
    ready: false,
  });
});

test("each phase shows the address it can stand behind", async () => {
  let answerDevice;
  const device = new Promise((resolve) => {
    answerDevice = resolve;
  });
  let reply;
  const { access } = setUp({
    fetchImpl: () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
    saved: { enabled: true, mode: "tailscale", version: 1 },
    tailscale: (calls) => ({ ...fakeTailscale(calls), device: () => device }),
  });
  // Saved on and not applied yet: nothing is known.
  expect(access.status()).toMatchObject({ address: null, phase: "checking" });
  const started = access.start();
  await Promise.resolve();
  expect(access.status()).toMatchObject({ address: null, phase: "checking" });

  // The device's address, while a request through it is on its way.
  answerDevice({ dnsName: "host.tailnet.ts.net" });
  await vi.waitFor(() => expect(reply).toBeDefined());
  expect(access.status()).toMatchObject({
    address: TAILNET,
    origin: null,
    phase: "checking",
    ready: false,
  });

  // It reached another host: shown as the address that did not work.
  reply(Response.json({ hostId: "another" }));
  const status = await started;
  expect(status).toMatchObject({
    address: TAILNET,
    origin: null,
    phase: "notReady",
    problem: {
      code: "unreachable",
      params: { origin: TAILNET, port: 5410 },
    },
    ready: false,
  });
  expect(status.problem.message).toContain("reaches a different Dream host");

  // Off: a Tailscale route has no address of its own; a Cloudflare one
  // shows its saved hostname.
  expect((await access.disable()).address).toBeNull();
  const cloudflare = await setUp({
    saved: {
      enabled: false,
      mode: "cloudflare",
      origin: "https://dream.example.com",
      version: 1,
    },
  }).access.start();
  expect(cloudflare).toMatchObject({
    address: "https://dream.example.com",
    phase: "off",
  });
});

test("a port already in use is a problem the user can act on", async () => {
  const { access, calls, read } = setUp({ listen: portInUse });
  const status = await access.enable({ mode: "tailscale", port: 6123 });
  expect(status).toMatchObject({
    enabled: true,
    listening: false,
    phase: "notReady",
    problem: { code: "port-in-use", params: { port: 6123 } },
  });
  // Tailscale was not pointed at a listener that never started.
  expect(calls).toEqual([["device"]]);
  expect(read()).toMatchObject({ port: 6123, servedBy: null });
});

test("a failed disable is off, reports the entry left behind, and removes it next time", async () => {
  let failing = true;
  const { access, calls, read } = setUp({
    saved: {
      enabled: true,
      mode: "tailscale",
      port: 5410,
      servedBy: { httpsPort: 443, localPort: 5410 },
      version: 1,
    },
    tailscale: (calls) =>
      fakeTailscale(calls, {
        disable: async (entry) => {
          if (failing)
            throw new TailscaleProblem(
              "not-running",
              "Tailscale is installed but not running.",
            );
          calls.push(["unserve", entry]);
          return true;
        },
      }),
  });
  expect((await access.start()).phase).toBe("ready");
  const failed = await access.disable();
  expect(failed).toMatchObject({
    enabled: false,
    listening: false,
    phase: "off",
    problem: { code: "not-running" },
  });
  expect(read()).toMatchObject({
    enabled: false,
    servedBy: { httpsPort: 443, localPort: 5410 },
  });

  failing = false;
  calls.length = 0;
  const off = await access.disable();
  expect(off).toMatchObject({ phase: "off", problem: null });
  expect(calls).toEqual([["unserve", { httpsPort: 443, localPort: 5410 }]]);
  expect(read().servedBy).toBeNull();
});

const OVERRIDE = {
  origins: ["https://dream.example.com"],
  port: 6000,
  sources: { remoteOrigins: "--remote-origin", remotePort: "--remote-port" },
  trustForwardedHost: true,
};

test("start-up options lock remote access whatever its phase", async () => {
  const unreachable = await setUp({
    fetchImpl: async () => new Response("", { status: 502 }),
    override: OVERRIDE,
  }).access.start();
  expect(unreachable).toMatchObject({
    address: "https://dream.example.com",
    lockedBy: ["--remote-origin", "--remote-port"],
    mode: "proxy",
    phase: "notReady",
    problem: { code: "unreachable", params: { port: 6000 } },
  });
  expect(unreachable.problem.message).toContain(
    "reverse proxy forwards https://dream.example.com to http://127.0.0.1:6000",
  );

  // No public origin given: nothing to check, so on and not ready.
  const unnamed = await setUp({
    fetchImpl: async () => {
      throw new Error("Nothing should be checked.");
    },
    override: {
      ...OVERRIDE,
      origins: [],
      sources: { remotePort: "--remote-port" },
    },
  }).access.start();
  expect(unnamed).toMatchObject({
    address: null,
    listening: true,
    lockedBy: ["--remote-port"],
    phase: "notReady",
    problem: null,
  });

  const busy = await setUp({
    listen: portInUse,
    override: OVERRIDE,
  }).access.start();
  expect(busy).toMatchObject({
    lockedBy: ["--remote-origin", "--remote-port"],
    phase: "notReady",
    problem: { code: "port-in-use", params: { port: 6000 } },
  });
});

test("a status from a host older than its phase is read the same way", () => {
  const older = {
    checkedAt: null,
    enabled: true,
    httpsPort: 443,
    listening: true,
    mode: "cloudflare",
    origin: null,
    port: 5410,
    problem: null,
    ready: false,
    requestedOrigin: "https://dream.example.com",
  };
  expect(readRemoteAccess(older)).toEqual({
    address: "https://dream.example.com",
    configured: true,
    lockedBy: null,
    phase: "checking",
  });
  expect(
    readRemoteAccess({ ...older, origin: older.requestedOrigin, ready: true }),
  ).toMatchObject({ address: "https://dream.example.com", phase: "ready" });
  const unreachable = { code: "unreachable", message: "", url: null };
  expect(readRemoteAccess({ ...older, problem: unreachable }).phase).toBe(
    "notReady",
  );
  // A refused change says nothing about the route.
  expect(
    readRemoteAccess({ ...older, problem: { ...unreachable, refused: true } })
      .phase,
  ).toBe("checking");
  expect(
    readRemoteAccess({
      ...older,
      configured: false,
      enabled: false,
      mode: "tailscale",
      requestedOrigin: null,
    }),
  ).toEqual({ address: null, configured: false, lockedBy: null, phase: "off" });
  // Before `configured`, a host that was on had been set up.
  expect(readRemoteAccess({ ...older, enabled: false }).configured).toBe(false);
  expect(
    readRemoteAccess({
      ...older,
      mode: "proxy",
      override: { sources: { remotePort: "DREAM_HOST_REMOTE_PORT" } },
    }).lockedBy,
  ).toEqual(["DREAM_HOST_REMOTE_PORT"]);
  expect(readRemoteAccess({ ...older, mode: "proxy" }).lockedBy).toEqual([
    "--remote-port",
  ]);

  // A newer host's answer is taken as it is.
  expect(
    readRemoteAccess({
      ...older,
      address: null,
      lockedBy: ["--remote-port"],
      phase: "notReady",
    }),
  ).toEqual({
    address: null,
    configured: true,
    lockedBy: ["--remote-port"],
    phase: "notReady",
  });
});
