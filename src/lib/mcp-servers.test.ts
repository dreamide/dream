import assert from "node:assert/strict";
import { test } from "vitest";
import {
  describeMcpServerTarget,
  formatKeyValueLines,
  normalizeBooleanRecord,
  normalizeMcpServer,
  normalizeMcpServerList,
  parseArgsLines,
  parseKeyValueLines,
  resolveEffectiveMcpServers,
  sanitizeMcpServerName,
} from "@/lib/mcp-servers";
import type { McpServerConfig } from "@/types/ide";

const createServer = (
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig => ({
  args: [],
  command: "npx",
  createdAt: "2026-01-01T00:00:00.000Z",
  enabled: true,
  env: {},
  headers: {},
  id: "server-1",
  name: "filesystem",
  transport: "stdio",
  url: "",
  ...overrides,
});

test("normalizeMcpServer drops invalid entries", () => {
  assert.equal(normalizeMcpServer(null), null);
  assert.equal(normalizeMcpServer({ id: "a" }), null);
  assert.equal(
    normalizeMcpServer({
      id: "a",
      name: "bad name",
      transport: "stdio",
      command: "x",
    }),
    null,
  );
  assert.equal(
    normalizeMcpServer({
      id: "a",
      name: "ok",
      transport: "stdio",
      command: "",
    }),
    null,
  );
  assert.equal(
    normalizeMcpServer({ id: "a", name: "ok", transport: "http", url: "" }),
    null,
  );
});

test("normalizeMcpServer clears transport-irrelevant fields", () => {
  const stdio = normalizeMcpServer({
    args: ["-y", 1, "pkg"],
    command: " npx ",
    env: { A: "1", B: 2 },
    headers: { X: "y" },
    id: "a",
    name: "fs",
    transport: "stdio",
    url: "http://ignored",
  });
  assert.deepEqual(stdio, {
    args: ["-y", "pkg"],
    command: "npx",
    createdAt: "1970-01-01T00:00:00.000Z",
    enabled: true,
    env: { A: "1" },
    headers: {},
    id: "a",
    name: "fs",
    transport: "stdio",
    url: "",
  });

  const http = normalizeMcpServer({
    command: "ignored",
    enabled: false,
    headers: { Authorization: "Bearer x" },
    id: "b",
    name: "remote",
    transport: "http",
    url: "https://example.com/mcp",
  });
  assert.deepEqual(http?.command, "");
  assert.deepEqual(http?.headers, { Authorization: "Bearer x" });
  assert.equal(http?.enabled, false);
});

test("normalizeMcpServerList dedupes by id", () => {
  const list = normalizeMcpServerList([
    createServer({ id: "a" }),
    createServer({ id: "a", name: "duplicate" }),
    createServer({ id: "b" }),
    "junk",
  ]);
  assert.deepEqual(
    list.map((server) => server.id),
    ["a", "b"],
  );
  assert.deepEqual(normalizeMcpServerList("nope"), []);
});

test("normalizeBooleanRecord keeps only boolean values", () => {
  assert.deepEqual(normalizeBooleanRecord({ a: true, b: false, c: "x" }), {
    a: true,
    b: false,
  });
  assert.deepEqual(normalizeBooleanRecord([true]), {});
});

test("resolveEffectiveMcpServers applies project overrides", () => {
  const settings = {
    mcpServers: [
      createServer({ enabled: true, id: "on" }),
      createServer({ enabled: false, id: "off" }),
      createServer({ enabled: true, id: "forced-off" }),
      createServer({ enabled: false, id: "forced-on" }),
    ],
  };
  const project = {
    mcpServerOverrides: { "forced-off": false, "forced-on": true },
  };
  assert.deepEqual(
    resolveEffectiveMcpServers(settings, project).map((server) => server.id),
    ["on", "forced-on"],
  );
  assert.deepEqual(
    resolveEffectiveMcpServers(settings, null).map((server) => server.id),
    ["on", "forced-off"],
  );
});

test("parseKeyValueLines splits on the first equals sign", () => {
  const result = parseKeyValueLines(
    "API_KEY=abc=def\n# comment\n\n  TOKEN = value \nnotakeyvalue\n1BAD=x",
  );
  assert.deepEqual(result.values, { API_KEY: "abc=def", TOKEN: "value" });
  assert.deepEqual(result.errors, [
    { line: 5, message: "invalid-format" },
    { line: 6, message: "invalid-key" },
  ]);
});

test("key/value and args round-trip through format/parse", () => {
  const record = { A: "1", B: "two words" };
  assert.deepEqual(
    parseKeyValueLines(formatKeyValueLines(record)).values,
    record,
  );
  assert.deepEqual(parseArgsLines("-y\n\n @scope/pkg \n"), [
    "-y",
    "@scope/pkg",
  ]);
});

test("sanitizeMcpServerName produces a valid name", () => {
  assert.equal(sanitizeMcpServerName("My Server (v2)"), "My-Server-v2-");
  assert.equal(sanitizeMcpServerName("--weird"), "weird");
  assert.equal(sanitizeMcpServerName("!!!"), "server");
});

test("describeMcpServerTarget summarizes command or url", () => {
  assert.equal(
    describeMcpServerTarget(createServer({ args: ["-y", "pkg"] })),
    "npx -y pkg",
  );
  assert.equal(
    describeMcpServerTarget(
      createServer({ transport: "http", url: "https://x.dev/mcp" }),
    ),
    "https://x.dev/mcp",
  );
});
