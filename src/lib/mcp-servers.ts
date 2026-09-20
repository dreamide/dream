import type {
  AiProvider,
  AppSettings,
  McpServerConfig,
  McpServerTransport,
} from "@/types/ide";

export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const KEY_VALUE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MCP_TRANSPORTS: McpServerTransport[] = ["stdio", "http", "sse"];

export const MCP_PROVIDER_SUPPORT: Record<AiProvider, boolean> = {
  anthropic: true,
  cursor: false,
  grok: true,
  openai: true,
  opencode: true,
};

export const isValidMcpServerName = (name: string): boolean =>
  MCP_SERVER_NAME_PATTERN.test(name);

export const sanitizeMcpServerName = (raw: string): string => {
  const replaced = raw.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
  const stripped = replaced.replace(/^[^A-Za-z0-9]+/, "");
  return stripped.length > 0 ? stripped : "server";
};

export const isMcpServerTransport = (
  value: unknown,
): value is McpServerTransport =>
  typeof value === "string" &&
  MCP_TRANSPORTS.includes(value as McpServerTransport);

const normalizeStringRecord = (raw: unknown): Record<string, string> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      typeof key === "string" &&
      key.length > 0 &&
      typeof value === "string"
    ) {
      result[key] = value;
    }
  }
  return result;
};

const normalizeStringArray = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];

export const normalizeBooleanRecord = (
  raw: unknown,
): Record<string, boolean> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length > 0 && typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
};

export const normalizeMcpServer = (raw: unknown): McpServerConfig | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (
    !id ||
    !isValidMcpServerName(name) ||
    !isMcpServerTransport(record.transport)
  ) {
    return null;
  }
  const transport = record.transport;
  const command =
    typeof record.command === "string" ? record.command.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (transport === "stdio" && !command) {
    return null;
  }
  if (transport !== "stdio" && !url) {
    return null;
  }
  return {
    args: transport === "stdio" ? normalizeStringArray(record.args) : [],
    command: transport === "stdio" ? command : "",
    createdAt:
      typeof record.createdAt === "string" && record.createdAt
        ? record.createdAt
        : new Date(0).toISOString(),
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    env: transport === "stdio" ? normalizeStringRecord(record.env) : {},
    headers: transport === "stdio" ? {} : normalizeStringRecord(record.headers),
    id,
    name,
    transport,
    url: transport === "stdio" ? "" : url,
  };
};

export const normalizeMcpServerList = (raw: unknown): McpServerConfig[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const result: McpServerConfig[] = [];
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

export type McpServerInput = Omit<McpServerConfig, "id" | "createdAt">;

export const createMcpServer = (input: McpServerInput): McpServerConfig => ({
  ...input,
  createdAt: new Date().toISOString(),
  id: crypto.randomUUID(),
});

export const resolveEffectiveMcpServers = (
  settings: Pick<AppSettings, "mcpServers">,
): McpServerConfig[] => settings.mcpServers.filter((server) => server.enabled);

export const parseArgsLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const formatArgsLines = (args: string[]): string => args.join("\n");

export interface KeyValueParseError {
  line: number;
  message: "invalid-format" | "invalid-key";
}

export interface KeyValueParseResult {
  errors: KeyValueParseError[];
  values: Record<string, string>;
}

export const parseKeyValueLines = (text: string): KeyValueParseResult => {
  const values: Record<string, string> = {};
  const errors: KeyValueParseError[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      return;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      errors.push({ line: index + 1, message: "invalid-format" });
      return;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!KEY_VALUE_KEY_PATTERN.test(key)) {
      errors.push({ line: index + 1, message: "invalid-key" });
      return;
    }
    values[key] = value;
  });
  return { errors, values };
};

export const formatKeyValueLines = (record: Record<string, string>): string =>
  Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

export const describeMcpServerTarget = (server: McpServerConfig): string =>
  server.transport === "stdio"
    ? [server.command, ...server.args].join(" ")
    : server.url;
