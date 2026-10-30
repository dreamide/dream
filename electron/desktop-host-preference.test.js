import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  desktopHostPreferencePath,
  readDesktopHostPreference,
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
  it("defaults to running agents on this computer", () => {
    expect(readDesktopHostPreference(database)).toEqual({ mode: "local" });
  });

  it("keeps what was saved and ignores what it does not know", () => {
    expect(
      writeDesktopHostPreference(database, {
        keepRunning: true,
        mode: "remote",
      }),
    ).toEqual({ mode: "remote" });
    expect(readDesktopHostPreference(database)).toEqual({ mode: "remote" });
    writeFileSync(
      desktopHostPreferencePath(database),
      JSON.stringify({ keepRunning: true, mode: "nowhere" }),
    );
    expect(readDesktopHostPreference(database)).toEqual({ mode: "local" });
  });
});

describe("resolveDesktopHostMode", () => {
  const resolve = (options) =>
    resolveDesktopHostMode({
      preference: { mode: "local" },
      workspaceSeparate: true,
      ...options,
    });

  it("runs the host in its own process by default", () => {
    expect(resolve({})).toEqual({ mode: "detached", reason: "default" });
    expect(resolve({ envMode: "auto" }).mode).toBe("detached");
    expect(resolve({ envMode: "desktop" }).mode).toBe("detached");
  });

  it("honours remote hosts only from Settings", () => {
    expect(resolve({ preference: { mode: "remote" } })).toEqual({
      mode: "remote",
      reason: "preference",
    });
  });

  it("lets DREAM_HOST_MODE win, and explains the removed service mode", () => {
    expect(
      resolve({ envMode: "in-process", preference: { mode: "remote" } }),
    ).toEqual({ mode: "in-process", reason: "DREAM_HOST_MODE" });
    expect(resolve({ envMode: "remote" }).mode).toBe("remote");
    expect(() => resolve({ envMode: "service" })).toThrow(/dream-host serve/);
    expect(() => resolve({ envMode: "elsewhere" })).toThrow(
      /auto, remote or in-process/,
    );
  });

  it("keeps the host in this process while the workspace shares its writer", () => {
    expect(
      resolve({ preference: { mode: "remote" }, workspaceSeparate: false }),
    ).toEqual({ mode: "in-process", reason: "shared-writer" });
  });
});
