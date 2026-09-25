import { describe, expect, it } from "vitest";
import { isUserTerminalInput } from "./terminal-untouched";

describe("isUserTerminalInput", () => {
  it("treats typed text, enter and pasted text as user input", () => {
    expect(isUserTerminalInput("l")).toBe(true);
    expect(isUserTerminalInput("\r")).toBe(true);
    expect(isUserTerminalInput("\x03")).toBe(true);
    expect(isUserTerminalInput("\x1b[200~git status\x1b[201~")).toBe(true);
    expect(isUserTerminalInput("\x1b[A")).toBe(true);
  });

  it("ignores automatic terminal query responses", () => {
    expect(isUserTerminalInput("\x1b[24;1R")).toBe(false);
    expect(isUserTerminalInput("\x1b[?1;2c")).toBe(false);
    expect(isUserTerminalInput("\x1b[>0;276;0c")).toBe(false);
    expect(isUserTerminalInput("\x1b[I")).toBe(false);
    expect(isUserTerminalInput("\x1b[O")).toBe(false);
    expect(isUserTerminalInput("\x1b[0n")).toBe(false);
    expect(isUserTerminalInput("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe(false);
    expect(isUserTerminalInput("\x1b[24;1R\x1b[?1;2c")).toBe(false);
  });
});
