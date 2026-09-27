import { describe, expect, it } from "vitest";
import { isCursorAgentVersionOutput } from "./cursor-cli.js";

describe("isCursorAgentVersionOutput", () => {
  it("accepts Cursor Agent's date-based build versions", () => {
    expect(isCursorAgentVersionOutput("2026.05.28-a70ca7c")).toBe(true);
    expect(isCursorAgentVersionOutput("2026.09.26-dd393fe\r\n")).toBe(true);
  });

  it("rejects other tools that install an `agent` binary", () => {
    // Grok Build ships `agent.exe`, and its help mentions `cursor-worker`.
    expect(
      isCursorAgentVersionOutput("grok 1.0.41 (4220f3b224a6) [stable]"),
    ).toBe(false);
    expect(isCursorAgentVersionOutput("1.2.3")).toBe(false);
    expect(isCursorAgentVersionOutput("")).toBe(false);
    expect(isCursorAgentVersionOutput(null)).toBe(false);
  });
});
