import { describe, expect, it } from "vitest";
import { parseAcpToolOutput } from "./grok-stream.js";

describe("ACP tool output normalization", () => {
  it("preserves JSON file content for read tools", () => {
    expect(parseAcpToolOutput("[]", "readFile")).toBe("[]");
    expect(
      parseAcpToolOutput('{"stdout":"literal file data"}', "readFile"),
    ).toBe('{"stdout":"literal file data"}');
  });

  it("decodes command result envelopes only for command tools", () => {
    const serialized = '{"output":"done\\n","exitCode":0}';
    expect(parseAcpToolOutput(serialized, "runCommand")).toEqual({
      exitCode: 0,
      output: "done\n",
    });
    expect(parseAcpToolOutput(serialized, "mcp__example__read")).toBe(
      serialized,
    );
  });

  it("formats non-empty web search results but preserves empty results", () => {
    expect(
      parseAcpToolOutput(
        '[{"title":"Amp","url":"https://ampcode.com","excerpts":["Manual"]}]',
        "webSearch",
      ),
    ).toBe("[Amp](https://ampcode.com)\n\nManual");
    expect(parseAcpToolOutput("[]", "webSearch")).toBe("[]");
  });

  it("preserves malformed and unrecognized JSON output", () => {
    expect(parseAcpToolOutput("{not-json", "runCommand")).toBe("{not-json");
    expect(parseAcpToolOutput('{"custom":true}', "unknown")).toBe(
      '{"custom":true}',
    );
  });
});
