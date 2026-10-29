import { afterEach, describe, expect, it, vi } from "vitest";
import * as cli from "../shared/cli.js";
import {
  assertSafeAntigravityArg,
  getAntigravityCliSpawnErrorMessage,
  getAntigravityCliUnavailableMessage,
  resolveAntigravityCliLaunch,
  resolveAntigravityEffort,
} from "./antigravity-cli.js";

describe("antigravity-cli helpers", () => {
  it("returns unavailable message", () => {
    const message = getAntigravityCliUnavailableMessage();
    expect(message).toContain("Google Antigravity CLI is not installed");
    expect(message).toContain("agy");
  });

  it("formats spawn error message for ENOENT and general errors", () => {
    expect(getAntigravityCliSpawnErrorMessage({ code: "ENOENT" })).toBe(
      getAntigravityCliUnavailableMessage(),
    );
    expect(
      getAntigravityCliSpawnErrorMessage(new Error("Permission denied")),
    ).toBe("Permission denied");
    expect(getAntigravityCliSpawnErrorMessage(null)).toBe(
      "Antigravity CLI request failed.",
    );
  });

  it("resolves effort only for models that support configurable reasoning effort", () => {
    expect(resolveAntigravityEffort("gemini-3.8-flash", "high")).toBe("high");
    expect(resolveAntigravityEffort("gemini-3.8-flash", "medium")).toBe(
      "medium",
    );
    expect(resolveAntigravityEffort(undefined, "low")).toBeNull();
    expect(resolveAntigravityEffort("", "max")).toBeNull();

    // Models with built-in effort suffixes return null to prevent CLI conflict errors
    expect(
      resolveAntigravityEffort("gemini-3.8-flash-low", "medium"),
    ).toBeNull();
    expect(
      resolveAntigravityEffort("gemini-3.8-flash-high", "high"),
    ).toBeNull();
    expect(
      resolveAntigravityEffort("gpt-oss-120b-medium", "medium"),
    ).toBeNull();

    // Models that do not support effort return null
    expect(resolveAntigravityEffort("claude-sonnet-4-6", "medium")).toBeNull();
    expect(
      resolveAntigravityEffort("claude-opus-4-6-thinking", "low"),
    ).toBeNull();

    // Invalid efforts return null
    expect(resolveAntigravityEffort("gemini-3.8-flash", "ultra")).toBeNull();
    expect(resolveAntigravityEffort("gemini-3.8-flash", null)).toBeNull();
  });

  it("validates shell arguments when batch shell launch is enabled", () => {
    const batchLaunch = { shell: true };
    const directLaunch = { shell: false };

    expect(() =>
      assertSafeAntigravityArg(batchLaunch, "gemini-3.8-flash", "model"),
    ).not.toThrow();
    expect(() =>
      assertSafeAntigravityArg(
        batchLaunch,
        "session-123_abc:part",
        "conversation ID",
      ),
    ).not.toThrow();

    expect(() =>
      assertSafeAntigravityArg(batchLaunch, "gemini & calc.exe", "model"),
    ).toThrow(/Unsupported model/);
    expect(() =>
      assertSafeAntigravityArg(batchLaunch, "id; rm -rf", "conversation ID"),
    ).toThrow(/Unsupported conversation ID/);

    // Direct launch without shell allows normal execution without throwing
    expect(() =>
      assertSafeAntigravityArg(directLaunch, "gemini & calc.exe", "model"),
    ).not.toThrow();
  });

  describe("resolveAntigravityCliLaunch", () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      vi.restoreAllMocks();
    });

    it("quotes batch file path with spaces on Windows and sets shell: true", async () => {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      vi.spyOn(cli.cliCatalog, "derived").mockResolvedValue("agy");
      vi.spyOn(cli.cliCatalog, "path").mockResolvedValue(
        "C:\\Users\\Jane Doe\\.gemini\\antigravity-cli\\bin\\agy.bat",
      );

      const launch = await resolveAntigravityCliLaunch();
      expect(launch).toEqual({
        argsPrefix: [],
        command:
          '"C:\\Users\\Jane Doe\\.gemini\\antigravity-cli\\bin\\agy.bat"',
        shell: true,
      });
    });

    it("does not quote batch file path without spaces on Windows and sets shell: true", async () => {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      vi.spyOn(cli.cliCatalog, "derived").mockResolvedValue("agy");
      vi.spyOn(cli.cliCatalog, "path").mockResolvedValue(
        "C:\\agy\\bin\\agy.cmd",
      );

      const launch = await resolveAntigravityCliLaunch();
      expect(launch).toEqual({
        argsPrefix: [],
        command: "C:\\agy\\bin\\agy.cmd",
        shell: true,
      });
    });

    it("does not quote non-batch file path and sets shell: false", async () => {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      vi.spyOn(cli.cliCatalog, "derived").mockResolvedValue("agy");
      vi.spyOn(cli.cliCatalog, "path").mockResolvedValue(
        "C:\\Program Files\\agy\\bin\\agy.exe",
      );

      const launch = await resolveAntigravityCliLaunch();
      expect(launch).toEqual({
        argsPrefix: [],
        command: "C:\\Program Files\\agy\\bin\\agy.exe",
        shell: false,
      });
    });
  });
});
