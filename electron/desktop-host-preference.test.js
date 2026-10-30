import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  desktopHostPreferencePath,
  readDesktopHostPreference,
  rendererHostMode,
  resolveDesktopHostMode,
  writeDesktopHostPreference,
} from "./desktop-host-preference.js";

let directory;
let database;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dream-host-preference-"));
  database = path.join(directory, "dream.db");
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("the desktop host preference", () => {
  it("defaults to a local host that stops at quit", () => {
    expect(readDesktopHostPreference(database)).toEqual({
      keepRunning: false,
      mode: "local",
    });
  });

  it("keeps what was saved and ignores what it does not know", () => {
    writeDesktopHostPreference(database, { keepRunning: true });
    expect(
      writeDesktopHostPreference(database, { mode: "remote", other: 1 }),
    ).toEqual({ keepRunning: true, mode: "remote" });
    writeFileSync(
      desktopHostPreferencePath(database),
      JSON.stringify({ keepRunning: "yes", mode: "nowhere" }),
    );
    expect(readDesktopHostPreference(database)).toEqual({
      keepRunning: false,
      mode: "local",
    });
  });
});

describe("resolveDesktopHostMode", () => {
  const local = { mode: "local" };
  const resolve = (options) =>
    resolveDesktopHostMode({
      preference: local,
      serviceServesDesktop: () => false,
      workspaceSeparate: true,
      ...options,
    });

  it("runs the desktop's own child host by default", () => {
    expect(resolve({})).toEqual({ mode: "child", reason: "default" });
    expect(resolve({ envMode: "auto" }).mode).toBe("child");
    expect(resolve({ envMode: "desktop" }).mode).toBe("child");
  });

  it("attaches to an installed service that serves this desktop", () => {
    expect(resolve({ serviceServesDesktop: () => true })).toEqual({
      mode: "service",
      reason: "installed-service",
    });
  });

  it("honours remote-only from Settings", () => {
    expect(
      resolve({
        preference: { mode: "remote" },
        serviceServesDesktop: () => true,
      }),
    ).toEqual({ mode: "remote", reason: "preference" });
  });

  it("lets DREAM_HOST_MODE win, and refuses an unknown one", () => {
    expect(
      resolve({ envMode: "in-process", preference: { mode: "remote" } }),
    ).toEqual({ mode: "in-process", reason: "DREAM_HOST_MODE" });
    expect(resolve({ envMode: "service" }).mode).toBe("service");
    expect(() => resolve({ envMode: "elsewhere" })).toThrow(/DREAM_HOST_MODE/);
  });

  it("keeps the host in this process while the workspace shares its writer", () => {
    expect(
      resolve({
        preference: { mode: "remote" },
        serviceServesDesktop: () => true,
        workspaceSeparate: false,
      }),
    ).toEqual({ mode: "in-process", reason: "shared-writer" });
  });

  it("does not look for a service when it cannot matter", () => {
    let asked = false;
    resolve({
      preference: { mode: "remote" },
      serviceServesDesktop: () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
  });
});

describe("rendererHostMode", () => {
  it("tells the page whether its host outlives it", () => {
    expect(rendererHostMode("child")).toBe("service");
    expect(rendererHostMode("service")).toBe("service");
    expect(rendererHostMode("in-process")).toBe("desktop");
    expect(rendererHostMode("remote")).toBe("remote");
  });
});
