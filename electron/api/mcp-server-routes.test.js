import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dream-test-user-data" },
}));

const { mergeMcpImportCandidates, registerMcpServerRoutes } = await import(
  "./mcp-server-routes.js"
);

const temporaryDirectories = [];
const originalHome = process.env.DREAM_MCP_IMPORT_HOME;
const originalBearer = process.env.DREAM_TEST_MCP_BEARER;

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.DREAM_MCP_IMPORT_HOME;
  } else {
    process.env.DREAM_MCP_IMPORT_HOME = originalHome;
  }
  if (originalBearer === undefined) {
    delete process.env.DREAM_TEST_MCP_BEARER;
  } else {
    process.env.DREAM_TEST_MCP_BEARER = originalBearer;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

const createDirectory = async (prefix) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const writeFile = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
};

const createApp = () => {
  const app = new Hono();
  registerMcpServerRoutes(app);
  return app;
};

const requestCandidates = async (app, body) => {
  const response = await app.request("/api/mcp-servers/import-candidates", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return (await response.json()).candidates;
};

test("collects and dedupes servers from every supported config file", async () => {
  const home = await createDirectory("dream-mcp-home-");
  const project = await createDirectory("dream-mcp-project-");
  process.env.DREAM_MCP_IMPORT_HOME = home;
  process.env.DREAM_TEST_MCP_BEARER = "secret-token";

  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: {
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          command: "npx",
          env: { LOG: "1" },
        },
        "My Remote": { type: "sse", url: "https://sse.example.com" },
      },
      projects: {
        [project]: {
          mcpServers: { scoped: { command: "scoped-cmd" } },
        },
      },
    }),
  );
  await writeFile(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: "different", args: [] },
        projectOnly: {
          type: "http",
          url: "https://http.example.com",
          headers: { X: "1" },
        },
      },
    }),
  );
  await writeFile(
    path.join(home, ".codex", "config.toml"),
    `
[mcp_servers.codex_stdio]
command = "uvx"
args = ["server"]
env = { TOKEN = "t" }

[mcp_servers.codex_remote]
url = "https://codex.example.com"
bearer_token_env_var = "DREAM_TEST_MCP_BEARER"

[mcp_servers.missing_bearer]
url = "https://codex2.example.com"
bearer_token_env_var = "DREAM_TEST_MCP_BEARER_MISSING"

[mcp_servers.disabled]
command = "nope"
enabled = false
`,
  );
  await writeFile(
    path.join(home, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        cursorHttp: {
          type: "streamable-http",
          url: "https://cursor.example.com",
        },
        filesystem: { command: "cursor-fs" },
      },
    }),
  );
  await writeFile(
    path.join(project, ".cursor", "mcp.json"),
    "{ this is not json",
  );

  const candidates = await requestCandidates(createApp(), {
    projectPath: project,
  });
  const byName = Object.fromEntries(
    candidates.map((candidate) => [candidate.name, candidate]),
  );

  assert.deepEqual(Object.keys(byName).sort(), [
    "My-Remote",
    "codex_remote",
    "codex_stdio",
    "cursorHttp",
    "filesystem",
    "missing_bearer",
    "projectOnly",
    "scoped",
  ]);

  assert.equal(byName.filesystem.command, "npx");
  assert.deepEqual(byName.filesystem.env, { LOG: "1" });
  assert.deepEqual(
    byName.filesystem.sources.map((source) => source.kind),
    ["claudeUser", "claudeProject", "cursorUser"],
  );

  assert.equal(byName["My-Remote"].transport, "sse");
  assert.equal(byName.scoped.command, "scoped-cmd");
  assert.equal(byName.projectOnly.transport, "http");
  assert.deepEqual(byName.projectOnly.headers, { X: "1" });

  assert.deepEqual(byName.codex_stdio, {
    args: ["server"],
    command: "uvx",
    env: { TOKEN: "t" },
    headers: {},
    name: "codex_stdio",
    sources: [
      { kind: "codexUser", path: path.join(home, ".codex", "config.toml") },
    ],
    transport: "stdio",
    url: "",
    warnings: [],
  });
  assert.deepEqual(byName.codex_remote.headers, {
    Authorization: "Bearer secret-token",
  });
  assert.deepEqual(byName.missing_bearer.headers, {});
  assert.equal(byName.missing_bearer.warnings.length, 1);
  assert.equal(byName.cursorHttp.transport, "http");
});

test("returns an empty list when nothing is configured", async () => {
  const home = await createDirectory("dream-mcp-empty-");
  process.env.DREAM_MCP_IMPORT_HOME = home;
  assert.deepEqual(await requestCandidates(createApp(), {}), []);
  assert.deepEqual(
    await requestCandidates(createApp(), { projectPath: "" }),
    [],
  );
});

test("rejects invalid request bodies", async () => {
  const response = await createApp().request(
    "/api/mcp-servers/import-candidates",
    {
      body: JSON.stringify({ projectPath: 42 }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(response.status, 400);
});

test("mergeMcpImportCandidates keeps first definition and all sources", () => {
  const candidates = mergeMcpImportCandidates([
    {
      kind: "a",
      path: "/a",
      servers: [
        { name: "x", command: "first" },
        { name: "bad name", command: "c" },
      ],
    },
    { kind: "b", path: "/b", servers: [{ name: "x", command: "second" }] },
  ]);
  assert.deepEqual(candidates, [
    {
      command: "first",
      name: "x",
      sources: [
        { kind: "a", path: "/a" },
        { kind: "b", path: "/b" },
      ],
    },
  ]);
});
