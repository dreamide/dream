import { describe, expect, it } from "vitest";
import {
  assertSafeAntigravityArg,
  getAntigravityCliSpawnErrorMessage,
  getAntigravityCliUnavailableMessage,
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
    expect(resolveAntigravityEffort(undefined, "low")).toBe("low");
    expect(resolveAntigravityEffort("", "max")).toBe("max");

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
});
