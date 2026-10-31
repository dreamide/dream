import { describe, expect, it } from "vitest";
import { resolveDesktopHostMode } from "./desktop-host-mode.js";

describe("resolveDesktopHostMode", () => {
  const resolve = (options) =>
    resolveDesktopHostMode({ workspaceSeparate: true, ...options });

  it("runs the host in its own process by default", () => {
    expect(resolve({})).toEqual({ mode: "detached", reason: "default" });
    expect(resolve({ envMode: "auto" }).mode).toBe("detached");
    expect(resolve({ envMode: "desktop" }).mode).toBe("detached");
  });

  it("lets DREAM_HOST_MODE choose, and explains the removed modes", () => {
    expect(resolve({ envMode: "in-process" })).toEqual({
      mode: "in-process",
      reason: "DREAM_HOST_MODE",
    });
    expect(() => resolve({ envMode: "remote" })).toThrow(/always runs a host/);
    expect(() => resolve({ envMode: "service" })).toThrow(/dream-host serve/);
    expect(() => resolve({ envMode: "elsewhere" })).toThrow(
      /auto or in-process/,
    );
  });

  it("keeps the host in this process while the workspace shares its writer", () => {
    expect(resolve({ workspaceSeparate: false })).toEqual({
      mode: "in-process",
      reason: "shared-writer",
    });
  });
});
