import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createRemoteAccess } from "./remote-access.js";

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
  expect(status.cloudflare.managed).toBe(false);
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
  expect(status.cloudflare).toEqual({ managed: false, defaultPort: 5410 });
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
