import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BROWSER_MCP_SERVER_NAME } from "./browser-tools.js";

// OpenAI-compatible APIs reject requests that offer more than 128 tools.
// OpenCode sends every built-in and MCP tool, so a few MCP servers can push a
// turn past the limit before the model sees the prompt.
export const OPENCODE_TOOL_LIMIT = 128;

// OpenCode adds up to three MCP resource tools when a server exposes
// resources. The count is not observable before the turn, so reserve them.
const MCP_RESOURCE_TOOL_RESERVE = 3;
const MCP_LIST_TIMEOUT_MS = 15_000;
const MCP_LIST_MAX_PAGES = 20;
const MCP_TOOL_CACHE_TTL_MS = 10 * 60 * 1000;

// Mirrors McpCatalog.sanitize / toolName in OpenCode.
const sanitize = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "_");

export const getOpenCodeMcpToolKey = (server, tool) =>
  `${sanitize(server)}_${sanitize(tool)}`;

/**
 * Decides which MCP tools to hide so the offered set stays within `limit`.
 *
 * `servers` is in priority order. `tools` is the server's tool names, or null
 * when they could not be listed. Unlisted servers are kept only while nothing
 * has been trimmed; once the budget is exhausted they are hidden whole.
 *
 * Returns the OpenCode tool keys (or `<server>_*` patterns) to disable and a
 * per-server summary of what was hidden.
 */
export const planOpenCodeToolBudget = ({
  limit = OPENCODE_TOOL_LIMIT,
  reservedCount,
  servers,
}) => {
  let remaining = Math.max(0, limit - reservedCount);
  let trimmed = false;
  const disabled = [];
  const hidden = [];

  const known = servers.filter((server) => Array.isArray(server.tools));
  const unknown = servers.filter((server) => !Array.isArray(server.tools));

  for (const server of known) {
    const keys = [
      ...new Set(
        server.tools.map((tool) => getOpenCodeMcpToolKey(server.name, tool)),
      ),
    ];
    const kept = keys.slice(0, remaining);
    const dropped = keys.slice(kept.length);
    remaining -= kept.length;
    if (dropped.length > 0) {
      trimmed = true;
      disabled.push(...dropped);
      hidden.push({ count: dropped.length, server: server.name });
    }
  }

  for (const server of unknown) {
    if (trimmed || remaining <= 0) {
      disabled.push(`${sanitize(server.name)}_*`);
      hidden.push({ count: null, server: server.name });
    }
  }

  return { disabled, hidden };
};

const toError = (value) =>
  value instanceof Error ? value : new Error(String(value));

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms.`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

const listToolNames = async (transport) => {
  const client = new Client({ name: "dream-tool-budget", version: "1.0.0" });
  try {
    await client.connect(transport);
    if (!client.getServerCapabilities()?.tools) {
      return [];
    }
    const names = [];
    let cursor;
    for (let page = 0; page < MCP_LIST_MAX_PAGES; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of result.tools ?? []) {
        if (typeof tool?.name === "string") names.push(tool.name);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return names;
  } finally {
    await client.close().catch(() => {});
  }
};

const listRemoteToolNames = async (entry) => {
  const url = new URL(entry.url);
  const requestInit = entry.headers ? { headers: entry.headers } : undefined;
  try {
    return await listToolNames(
      new StreamableHTTPClientTransport(url, { requestInit }),
    );
  } catch (streamableError) {
    try {
      return await listToolNames(new SSEClientTransport(url, { requestInit }));
    } catch {
      throw toError(streamableError);
    }
  }
};

const listLocalToolNames = (entry, cwd) => {
  const [command, ...args] = entry.command;
  return listToolNames(
    new StdioClientTransport({
      args,
      command,
      cwd,
      env: { ...process.env, ...entry.environment },
      stderr: "ignore",
    }),
  );
};

const getEntryFingerprint = (entry) =>
  JSON.stringify(
    entry.type === "local"
      ? { command: entry.command, env: entry.environment ?? {}, type: "local" }
      : { headers: entry.headers ?? {}, type: "remote", url: entry.url },
  );

const toolNameCache = new Map();

/**
 * Lists one MCP server's tool names from its OpenCode config entry.
 * Successful listings are cached per config for a few minutes; failures are
 * not cached. Resolves to null when the server cannot be listed (for example
 * a remote server that relies on OpenCode's stored OAuth credentials).
 */
export const listOpenCodeMcpToolNames = async (entry, { cwd } = {}) => {
  const valid =
    (entry?.type === "local" &&
      Array.isArray(entry.command) &&
      typeof entry.command[0] === "string" &&
      entry.command[0].length > 0) ||
    (entry?.type === "remote" && typeof entry.url === "string" && entry.url);
  if (!valid) return null;

  const key = getEntryFingerprint(entry);
  const cached = toolNameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.names;
  }

  const names = await withTimeout(
    entry.type === "local"
      ? listLocalToolNames(entry, cwd)
      : listRemoteToolNames(entry),
    MCP_LIST_TIMEOUT_MS,
    "Listing MCP tools",
  ).catch(() => null);

  if (names) {
    toolNameCache.set(key, {
      expiresAt: Date.now() + MCP_TOOL_CACHE_TTL_MS,
      names,
    });
  }
  return names;
};

export const clearOpenCodeMcpToolCache = () => toolNameCache.clear();

/**
 * Orders connected servers: Dream's browser tools first, then the servers
 * Dream passed in (in their configured order), then any other server from
 * OpenCode's own config, alphabetically.
 */
export const orderOpenCodeMcpServers = (connected, preferred = []) => {
  const preferredOrder = [
    BROWSER_MCP_SERVER_NAME,
    ...preferred.filter((name) => name !== BROWSER_MCP_SERVER_NAME),
  ];
  const connectedSet = new Set(connected);
  const ordered = preferredOrder.filter((name) => connectedSet.has(name));
  const rest = connected
    .filter((name) => !preferredOrder.includes(name))
    .sort((left, right) => left.localeCompare(right));
  return [...new Set([...ordered, ...rest])];
};

/**
 * Computes the `tools` map for an OpenCode prompt so the turn offers at most
 * `limit` tools. Returns an empty object when everything fits or when the
 * running OpenCode server cannot be inspected; the turn then proceeds as-is.
 */
export const resolveOpenCodeDisabledTools = async ({
  client,
  directory,
  limit = OPENCODE_TOOL_LIMIT,
  preferredServers = [],
  signal,
}) => {
  try {
    const query = { directory };
    const [statusResult, configResult, idsResult] = await Promise.all([
      client.mcp.status({ query, signal }),
      client.config.get({ query, signal }),
      client.tool.ids({ query, signal }),
    ]);
    const status = statusResult.data ?? {};
    const mcpConfig = configResult.data?.mcp ?? {};
    const builtinIds = Array.isArray(idsResult.data) ? idsResult.data : [];

    const connected = Object.entries(status)
      .filter(
        ([name, value]) =>
          value?.status === "connected" && mcpConfig[name] !== undefined,
      )
      .map(([name]) => name);
    if (connected.length === 0) {
      return {};
    }

    const ordered = orderOpenCodeMcpServers(connected, preferredServers);
    const servers = await Promise.all(
      ordered.map(async (name) => ({
        name,
        tools: await listOpenCodeMcpToolNames(mcpConfig[name], {
          cwd: directory,
        }),
      })),
    );
    if (signal?.aborted) {
      return {};
    }

    const reservedCount =
      builtinIds.filter((id) => id !== "invalid").length +
      MCP_RESOURCE_TOOL_RESERVE;
    const { disabled, hidden } = planOpenCodeToolBudget({
      limit,
      reservedCount,
      servers,
    });
    if (disabled.length === 0) {
      return {};
    }

    console.warn(
      `OpenCode tool limit (${limit}): hiding ${hidden
        .map(({ count, server }) =>
          count === null ? `${server} (all)` : `${count} from ${server}`,
        )
        .join(", ")}.`,
    );
    return Object.fromEntries(disabled.map((key) => [key, false]));
  } catch (error) {
    if (!signal?.aborted) {
      console.warn(
        `Could not check OpenCode's tool count: ${toError(error).message}`,
      );
    }
    return {};
  }
};
