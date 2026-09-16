import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getCodexMcpFingerprint,
  normalizeMcpServerList,
  toAcpMcpServers,
  toClaudeMcpServers,
  toCodexConfigOverrides,
  toOpenCodeMcpConfig,
} from "./mcp-servers.js";

const stdio = {
  args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me"],
  command: "npx",
  createdAt: "2026-01-01T00:00:00.000Z",
  enabled: true,
  env: { API_KEY: 'se"cret' },
  headers: {},
  id: "a",
  name: "filesystem",
  transport: "stdio",
  url: "",
};

const http = {
  args: [],
  command: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  enabled: true,
  env: {},
  headers: { Authorization: "Bearer token" },
  id: "b",
  name: "remote",
  transport: "http",
  url: "https://example.com/mcp",
};

const bare = {
  ...stdio,
  args: [],
  env: {},
  id: "c",
  name: "bare",
};

test("normalizeMcpServerList drops invalid and duplicate entries", () => {
  const list = normalizeMcpServerList([
    stdio,
    { ...stdio },
    http,
    { id: "x" },
    null,
  ]);
  assert.deepEqual(
    list.map((server) => server.id),
    ["a", "b"],
  );
});

test("toClaudeMcpServers maps transports and omits empty fields", () => {
  assert.deepEqual(toClaudeMcpServers([stdio, http, bare]), {
    bare: { type: "stdio", command: "npx" },
    filesystem: {
      type: "stdio",
      command: "npx",
      args: stdio.args,
      env: stdio.env,
    },
    remote: {
      type: "http",
      url: "https://example.com/mcp",
      headers: http.headers,
    },
  });
});

test("toOpenCodeMcpConfig maps to local/remote entries", () => {
  assert.deepEqual(
    toOpenCodeMcpConfig([stdio, { ...http, transport: "sse" }]),
    {
      filesystem: {
        type: "local",
        command: ["npx", ...stdio.args],
        environment: stdio.env,
        enabled: true,
      },
      remote: {
        type: "remote",
        url: "https://example.com/mcp",
        headers: http.headers,
        enabled: true,
      },
    },
  );
});

test("toAcpMcpServers produces name/value lists", () => {
  assert.deepEqual(toAcpMcpServers([stdio, http]), [
    {
      name: "filesystem",
      command: "npx",
      args: stdio.args,
      env: [{ name: "API_KEY", value: 'se"cret' }],
    },
    {
      type: "http",
      name: "remote",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer token" }],
    },
  ]);
});

test("toCodexConfigOverrides emits TOML-safe -c pairs", () => {
  assert.deepEqual(toCodexConfigOverrides([stdio, http, bare]), [
    "-c",
    'mcp_servers.filesystem.command="npx"',
    "-c",
    'mcp_servers.filesystem.args=["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\me"]',
    "-c",
    'mcp_servers.filesystem.env={ API_KEY = "se\\"cret" }',
    "-c",
    "mcp_servers.filesystem.enabled=true",
    "-c",
    'mcp_servers.remote.url="https://example.com/mcp"',
    "-c",
    'mcp_servers.remote.http_headers={ Authorization = "Bearer token" }',
    "-c",
    "mcp_servers.remote.enabled=true",
    "-c",
    'mcp_servers.bare.command="npx"',
    "-c",
    "mcp_servers.bare.enabled=true",
  ]);
  assert.deepEqual(toCodexConfigOverrides([]), []);
});

test("getCodexMcpFingerprint is stable across ordering", () => {
  assert.equal(
    getCodexMcpFingerprint([stdio, http]),
    getCodexMcpFingerprint([http, stdio]),
  );
  assert.notEqual(
    getCodexMcpFingerprint([stdio]),
    getCodexMcpFingerprint([{ ...stdio, args: [] }]),
  );
  assert.equal(getCodexMcpFingerprint([]), "[]");
});

test("quoteWindowsShellArg preserves spaces, quotes and backslashes", async () => {
  const { quoteWindowsShellArg } = await import("./mcp-servers.js");
  assert.equal(quoteWindowsShellArg("-c"), "-c");
  assert.equal(
    quoteWindowsShellArg('mcp_servers.x.args=["-y", "pkg"]'),
    '"mcp_servers.x.args=[\\"-y\\", \\"pkg\\"]"',
  );
  assert.equal(
    quoteWindowsShellArg('mcp_servers.x.command="C:\\bin\\node.exe"'),
    '"mcp_servers.x.command=\\"C:\\bin\\node.exe\\""',
  );
  assert.equal(quoteWindowsShellArg("ends\\"), "ends\\");
  assert.equal(quoteWindowsShellArg("ends here\\"), '"ends here\\\\"');
  assert.equal(quoteWindowsShellArg(""), '""');
});
