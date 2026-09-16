const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MCP_TRANSPORTS = new Set(["stdio", "http", "sse"]);

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeStringRecord = (raw) => {
  if (!isRecord(raw)) {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length > 0 && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
};

const normalizeStringArray = (raw) =>
  Array.isArray(raw) ? raw.filter((value) => typeof value === "string") : [];

export const normalizeMcpServer = (raw) => {
  if (!isRecord(raw)) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const transport = raw.transport;
  if (
    !id ||
    !MCP_SERVER_NAME_PATTERN.test(name) ||
    !MCP_TRANSPORTS.has(transport)
  ) {
    return null;
  }
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (transport === "stdio" && !command) {
    return null;
  }
  if (transport !== "stdio" && !url) {
    return null;
  }
  return {
    args: transport === "stdio" ? normalizeStringArray(raw.args) : [],
    command: transport === "stdio" ? command : "",
    createdAt:
      typeof raw.createdAt === "string" && raw.createdAt
        ? raw.createdAt
        : new Date(0).toISOString(),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    env: transport === "stdio" ? normalizeStringRecord(raw.env) : {},
    headers: transport === "stdio" ? {} : normalizeStringRecord(raw.headers),
    id,
    name,
    transport,
    url: transport === "stdio" ? "" : url,
  };
};

export const normalizeMcpServerList = (raw) => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const entry of raw) {
    const server = normalizeMcpServer(entry);
    if (!server || seen.has(server.id)) {
      continue;
    }
    seen.add(server.id);
    result.push(server);
  }
  return result;
};

const hasEntries = (record) => Object.keys(record).length > 0;

/**
 * Claude Agent SDK `mcpServers` option shape.
 */
export const toClaudeMcpServers = (servers) => {
  const result = {};
  for (const server of normalizeMcpServerList(servers)) {
    if (server.transport === "stdio") {
      result[server.name] = {
        type: "stdio",
        command: server.command,
        ...(server.args.length > 0 ? { args: server.args } : {}),
        ...(hasEntries(server.env) ? { env: server.env } : {}),
      };
    } else {
      result[server.name] = {
        type: server.transport,
        url: server.url,
        ...(hasEntries(server.headers) ? { headers: server.headers } : {}),
      };
    }
  }
  return result;
};

/**
 * OpenCode config `mcp` key shape (McpLocalConfig / McpRemoteConfig).
 */
export const toOpenCodeMcpConfig = (servers) => {
  const result = {};
  for (const server of normalizeMcpServerList(servers)) {
    if (server.transport === "stdio") {
      result[server.name] = {
        type: "local",
        command: [server.command, ...server.args],
        ...(hasEntries(server.env) ? { environment: server.env } : {}),
        enabled: true,
      };
    } else {
      result[server.name] = {
        type: "remote",
        url: server.url,
        ...(hasEntries(server.headers) ? { headers: server.headers } : {}),
        enabled: true,
      };
    }
  }
  return result;
};

const toNameValueList = (record) =>
  Object.entries(record).map(([name, value]) => ({ name, value }));

/**
 * Agent Client Protocol `session/new` `mcpServers` array shape.
 */
export const toAcpMcpServers = (servers) =>
  normalizeMcpServerList(servers).map((server) =>
    server.transport === "stdio"
      ? {
          name: server.name,
          command: server.command,
          args: server.args,
          env: toNameValueList(server.env),
        }
      : {
          type: server.transport,
          name: server.name,
          url: server.url,
          headers: toNameValueList(server.headers),
        },
  );

const toTomlString = (value) => JSON.stringify(String(value));

const toTomlKey = (key) =>
  /^[A-Za-z0-9_-]+$/.test(key) ? key : toTomlString(key);

const toTomlInlineTable = (record) =>
  `{ ${Object.entries(record)
    .map(([key, value]) => `${toTomlKey(key)} = ${toTomlString(value)}`)
    .join(", ")} }`;

const toTomlStringArray = (values) =>
  `[${values.map((value) => toTomlString(value)).join(", ")}]`;

/**
 * Codex CLI `-c key=value` override pairs for `mcp_servers.<name>.*`.
 */
export const toCodexConfigOverrides = (servers) => {
  const args = [];
  const push = (name, key, value) => {
    args.push("-c", `mcp_servers.${name}.${key}=${value}`);
  };
  for (const server of normalizeMcpServerList(servers)) {
    const name = server.name;
    if (server.transport === "stdio") {
      push(name, "command", toTomlString(server.command));
      if (server.args.length > 0) {
        push(name, "args", toTomlStringArray(server.args));
      }
      if (hasEntries(server.env)) {
        push(name, "env", toTomlInlineTable(server.env));
      }
    } else {
      push(name, "url", toTomlString(server.url));
      if (hasEntries(server.headers)) {
        push(name, "http_headers", toTomlInlineTable(server.headers));
      }
    }
    push(name, "enabled", "true");
  }
  return args;
};

/**
 * Stable identity of the Codex override set, used to decide whether the
 * shared app-server process must be restarted with new arguments.
 */
export const getCodexMcpFingerprint = (servers) =>
  JSON.stringify(
    toCodexConfigOverrides(
      [...normalizeMcpServerList(servers)].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ),
  );

/**
 * Quotes an argument for a Windows command line so it survives both cmd.exe
 * (used when spawning `.cmd` shims with `shell: true`) and the child's
 * CommandLineToArgv parsing. Backslashes directly before a double quote are
 * doubled, embedded quotes are escaped, and the whole value is wrapped.
 */
export const quoteWindowsShellArg = (value) => {
  const text = String(value);
  if (text.length > 0 && !/[\s"]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
};

export const quoteShellArgs = (args, shell) =>
  shell && process.platform === "win32"
    ? args.map((arg) => quoteWindowsShellArg(arg))
    : args;
