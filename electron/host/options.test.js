import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_OPTIONS,
  HostOptionError,
  hostOptionFlags,
  passHostFlags,
  renderHostOptionsMarkdown,
  resolveHostOptions,
} from "./options.js";

const resolve = (values = {}, env = {}) =>
  resolveHostOptions({
    context: { clientDirectory: "/runtime/client" },
    env,
    values,
  });

describe("the host option table", () => {
  it("has a flag and an environment variable for every option", () => {
    for (const option of HOST_OPTIONS) {
      expect(option.flag).toMatch(/^[a-z][a-z-]*$/);
      expect(option.env).toMatch(/^DREAM_HOST_[A-Z_]+$/);
    }
  });

  it("takes a flag over a variable over the default, and says which", () => {
    const { from, options, sources } = resolve(
      { "idle-timeout": "0" },
      { DREAM_HOST_IDLE_TIMEOUT: "60", DREAM_HOST_PORT: "4100" },
    );
    expect(options.idleTimeout).toBe(0);
    expect(sources.idleTimeout).toBe("flag");
    expect(from.idleTimeout).toBe("--idle-timeout");
    expect(options.port).toBe(4100);
    expect(sources.port).toBe("env");
    expect(from.port).toBe("DREAM_HOST_PORT");
    expect(options.remotePort).toBeNull();
    expect(sources.remotePort).toBe("default");
    expect(from.remotePort).toBeNull();
    expect(options.clientDir).toBe("/runtime/client");
  });

  it("derives the data directory and database from the home", () => {
    const { options } = resolve({}, { DREAM_HOST_HOME: "/srv/dream" });
    expect(options.dataDir).toBe(path.resolve("/srv/dream/data"));
    expect(options.database).toBe(path.resolve("/srv/dream/data/dream.db"));
  });

  it("still reads DREAM_DB_PATH, after the option's own variable", () => {
    expect(resolve({}, { DREAM_DB_PATH: "/x/dev.db" }).from.database).toBe(
      "DREAM_DB_PATH",
    );
    expect(
      resolve({}, { DREAM_DB_PATH: "/x/dev.db", DREAM_HOST_DATABASE: "/y.db" })
        .options.database,
    ).toBe(path.resolve("/y.db"));
  });

  it("reads lists and switches from variables", () => {
    const { options } = resolve(
      {},
      {
        DREAM_HOST_REMOTE_ORIGINS: "https://a.example, https://b.example/x",
        DREAM_HOST_TRUST_FORWARDED_HOST: "yes",
      },
    );
    expect(options.remoteOrigins).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(options.trustForwardedHost).toBe(true);
  });

  it("refuses an invalid value, naming where it came from", () => {
    expect(() => resolve({ port: "70000" })).toThrow(HostOptionError);
    expect(() => resolve({ port: "70000" })).toThrow(/--port/);
    expect(() => resolve({}, { DREAM_HOST_IDLE_TIMEOUT: "soon" })).toThrow(
      /DREAM_HOST_IDLE_TIMEOUT.*seconds/,
    );
    expect(() => resolve({}, { DREAM_HOST_OWNER: "root" })).toThrow(
      /user or desktop/,
    );
  });

  it("writes options back as the flags that give them", () => {
    const flags = hostOptionFlags({
      diagnostics: true,
      owner: "desktop",
      remoteOrigins: ["https://a.example"],
      trustForwardedHost: false,
    });
    expect(flags).toEqual([
      "--diagnostics",
      "--owner",
      "desktop",
      "--remote-origin",
      "https://a.example",
    ]);
    expect(
      resolve(Object.fromEntries([["owner", "desktop"]])).options.owner,
    ).toBe("desktop");
    expect(passHostFlags({ json: true, port: "5" })).toEqual(["--port", "5"]);
  });

  it("is the table in the docs", () => {
    const docs = readFileSync(
      new URL("../../docs/host-service.md", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(docs).toContain(renderHostOptionsMarkdown());
  });
});
