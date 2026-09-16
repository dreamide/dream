import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseTomlLite } from "./mcp-servers/toml-lite.js";

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const importCandidatesRequestSchema = z.object({
  projectPath: z.string().optional(),
});

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeMcpServerName = (raw) => {
  const replaced = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const stripped = replaced.replace(/^[^A-Za-z0-9]+/, "");
  return stripped.length > 0 ? stripped : "server";
};

const toStringRecord = (raw) => {
  if (!isRecord(raw)) {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
};

const toStringArray = (raw) =>
  Array.isArray(raw)
    ? raw
        .filter(
          (value) => typeof value === "string" || typeof value === "number",
        )
        .map((value) => String(value))
    : [];

const getHomeDirectory = () =>
  process.env.DREAM_MCP_IMPORT_HOME ||
  process.env.HOME ||
  process.env.USERPROFILE ||
  os.homedir();

const readTextFile = async (filePath) => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
};

const readJsonFile = async (filePath) => {
  const text = await readTextFile(filePath);
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readTomlFile = async (filePath) => {
  const text = await readTextFile(filePath);
  return text === null ? null : parseTomlLite(text);
};

const normalizeTransport = (rawType, hasUrl) => {
  const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
  if (type === "sse") {
    return "sse";
  }
  if (
    type === "http" ||
    type === "streamable-http" ||
    type === "streamablehttp"
  ) {
    return "http";
  }
  if (type === "stdio") {
    return "stdio";
  }
  return hasUrl ? "http" : "stdio";
};

/**
 * Normalizes a JSON-style MCP entry (Claude / Cursor shape).
 */
const normalizeJsonServer = (name, raw) => {
  if (!isRecord(raw)) {
    return null;
  }
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const transport = normalizeTransport(raw.type, url.length > 0);
  if (transport === "stdio" ? !command : !url) {
    return null;
  }
  return {
    args: transport === "stdio" ? toStringArray(raw.args) : [],
    command: transport === "stdio" ? command : "",
    env: transport === "stdio" ? toStringRecord(raw.env) : {},
    headers: transport === "stdio" ? {} : toStringRecord(raw.headers),
    name: sanitizeMcpServerName(name),
    transport,
    url: transport === "stdio" ? "" : url,
    warnings: [],
  };
};

/**
 * Normalizes a Codex `[mcp_servers.<name>]` TOML entry.
 */
const normalizeCodexServer = (name, raw) => {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.enabled === false) {
    return null;
  }
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const warnings = [];
  if (url) {
    const headers = toStringRecord(raw.http_headers);
    const bearerEnvVar =
      typeof raw.bearer_token_env_var === "string"
        ? raw.bearer_token_env_var.trim()
        : "";
    if (bearerEnvVar) {
      const token = process.env[bearerEnvVar];
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      } else {
        warnings.push(`bearer_token_env_var ${bearerEnvVar} is not set`);
      }
    }
    return {
      args: [],
      command: "",
      env: {},
      headers,
      name: sanitizeMcpServerName(name),
      transport: "http",
      url,
      warnings,
    };
  }
  if (!command) {
    return null;
  }
  return {
    args: toStringArray(raw.args),
    command,
    env: toStringRecord(raw.env),
    headers: {},
    name: sanitizeMcpServerName(name),
    transport: "stdio",
    url: "",
    warnings,
  };
};

const collectJsonServers = (record, normalize = normalizeJsonServer) => {
  if (!isRecord(record)) {
    return [];
  }
  return Object.entries(record)
    .map(([name, raw]) => normalize(name, raw))
    .filter(Boolean);
};

const normalizeProjectKey = (value) =>
  path.resolve(value).replace(/[\\/]+$/, "");

const findProjectEntry = (projects, projectPath) => {
  if (!isRecord(projects) || !projectPath) {
    return null;
  }
  const target = normalizeProjectKey(projectPath);
  for (const [key, value] of Object.entries(projects)) {
    if (normalizeProjectKey(key) === target) {
      return value;
    }
  }
  return null;
};

export const collectMcpImportSources = async ({ projectPath } = {}) => {
  const home = getHomeDirectory();
  const sources = [];

  const claudeUserPath = path.join(home, ".claude.json");
  const claudeUser = await readJsonFile(claudeUserPath);
  if (claudeUser) {
    const servers = [
      ...collectJsonServers(claudeUser.mcpServers),
      ...collectJsonServers(
        findProjectEntry(claudeUser.projects, projectPath)?.mcpServers,
      ),
    ];
    sources.push({ kind: "claudeUser", path: claudeUserPath, servers });
  }

  if (projectPath) {
    const claudeProjectPath = path.join(projectPath, ".mcp.json");
    const claudeProject = await readJsonFile(claudeProjectPath);
    if (claudeProject) {
      sources.push({
        kind: "claudeProject",
        path: claudeProjectPath,
        servers: collectJsonServers(claudeProject.mcpServers),
      });
    }
  }

  const codexUserPath = path.join(home, ".codex", "config.toml");
  const codexUser = await readTomlFile(codexUserPath);
  if (codexUser) {
    sources.push({
      kind: "codexUser",
      path: codexUserPath,
      servers: collectJsonServers(codexUser.mcp_servers, normalizeCodexServer),
    });
  }

  const cursorUserPath = path.join(home, ".cursor", "mcp.json");
  const cursorUser = await readJsonFile(cursorUserPath);
  if (cursorUser) {
    sources.push({
      kind: "cursorUser",
      path: cursorUserPath,
      servers: collectJsonServers(cursorUser.mcpServers),
    });
  }

  if (projectPath) {
    const cursorProjectPath = path.join(projectPath, ".cursor", "mcp.json");
    const cursorProject = await readJsonFile(cursorProjectPath);
    if (cursorProject) {
      sources.push({
        kind: "cursorProject",
        path: cursorProjectPath,
        servers: collectJsonServers(cursorProject.mcpServers),
      });
    }
  }

  return sources;
};

/**
 * Merges servers from all sources into one candidate per name. The first
 * source that defines a name wins for field values; every source that
 * mentions the name is listed so the user can see where it came from.
 */
export const mergeMcpImportCandidates = (sources) => {
  const byName = new Map();
  for (const source of sources) {
    for (const server of source.servers) {
      const existing = byName.get(server.name);
      if (existing) {
        existing.sources.push({ kind: source.kind, path: source.path });
        continue;
      }
      byName.set(server.name, {
        ...server,
        sources: [{ kind: source.kind, path: source.path }],
      });
    }
  }
  return [...byName.values()].filter((candidate) =>
    MCP_SERVER_NAME_PATTERN.test(candidate.name),
  );
};

export const registerMcpServerRoutes = (app) => {
  app.post("/api/mcp-servers/import-candidates", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      rawBody = {};
    }

    const parsed = importCandidatesRequestSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return c.text("Invalid MCP import request.", 400);
    }

    const projectPath = parsed.data.projectPath?.trim() || undefined;
    const sources = await collectMcpImportSources({ projectPath });
    return c.json({ candidates: mergeMcpImportCandidates(sources) });
  });
};
