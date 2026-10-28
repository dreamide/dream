import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createRemoteAccess } from "./remote-access.js";

/** Remote access over a data directory whose settings file says `saved`. */
const withSaved = (saved, { tokenSaved = false, configure } = {}) => {
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
    cloudflare: {
      status: () => ({ state: "idle", tokenSaved }),
      detect: async () => undefined,
      stop: async () => undefined,
      configure: configure ?? (async () => undefined),
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
  const status = async (saved, options) =>
    (await withSaved(saved, options).access.start()).configured;
  expect(await status({ mode: "tailscale", version: 1 })).toBe(true);
  // A connector Dream runs needs its token.
  expect(await status(cloudflare)).toBe(false);
  expect(await status(cloudflare, { tokenSaved: true })).toBe(true);
  // A connector the user runs needs only the address.
  expect(await status({ ...cloudflare, cloudflareManaged: false })).toBe(true);
  expect(await status({ ...cloudflare, origin: null })).toBe(false);
});

test("an unusable Cloudflare setup is refused and saves nothing", async () => {
  const saved = { mode: "tailscale", version: 1 };
  const refusal = async (request, options) => {
    const { access, settingsFile } = withSaved(saved, options);
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
  expect(
    await refusal(
      {
        mode: "cloudflare",
        origin: "https://dream.example.com",
        cloudflareToken: "cloudflared service install eyJ",
      },
      {
        configure: async () => {
          throw Object.assign(new Error("Paste only the token."), {
            problemCode: "cloudflare-token",
          });
        },
      },
    ),
  ).toBe("cloudflare-token");
});
