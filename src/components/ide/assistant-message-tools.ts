import type { UIMessage } from "ai";

export type MessagePart = UIMessage["parts"][number];

export type ToolLikePart = MessagePart & {
  approval?: { id: string; approved?: boolean; reason?: string };
  errorText?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  toolCallId?: string;
  toolName?: string;
};

const isString = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isToolLikePart = (part: MessagePart): part is ToolLikePart =>
  typeof part.type === "string" &&
  (part.type.startsWith("tool-") || part.type === "dynamic-tool");

export const getToolName = (part: ToolLikePart): string => {
  if (part.type === "dynamic-tool" && isString(part.toolName)) {
    return part.toolName;
  }

  return part.type.startsWith("tool-") ? part.type.slice(5) : part.type;
};

export const normalizeToolName = (name: string): string =>
  name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

const MCP_TOOL_NAME_PATTERN = /^mcp__(.+?)__(.+)$/;

export type McpToolInfo = {
  command: string;
  server: string;
};

export const parseMcpToolName = (name: string): McpToolInfo | null => {
  const match = MCP_TOOL_NAME_PATTERN.exec(name);

  if (!match) {
    return null;
  }

  return {
    command: match[2],
    server: match[1],
  };
};

export const CHIP_TOOL_NAME_ALIASES = {
  agent: new Set(["agent"]),
  command: new Set([
    "run-command",
    "runcommand",
    "command",
    "exec-command",
    "bash",
    "power-shell",
    "powershell",
    "shell-command",
  ]),
  list: new Set(["list-files"]),
  read: new Set(["read", "read-file"]),
  search: new Set(["glob", "grep", "search", "search-in-files"]),
  taskOutput: new Set(["task-output", "taskoutput", "task-result"]),
  toolSearch: new Set(["tool-search"]),
  webFetch: new Set([
    "fetch",
    "web-fetch",
    "webfetch",
    "web-search",
    "websearch",
  ]),
  write: new Set([
    "apply-patch",
    "applypatch",
    "edit",
    "file-change",
    "filechange",
    "multi-edit",
    "multiedit",
    "notebook-edit",
    "notebookedit",
    "patch",
    "write",
    "write-file",
    "writefile",
  ]),
} as const;

export type ChipToolKind = keyof typeof CHIP_TOOL_NAME_ALIASES | "mcp";

export const getChipToolKind = (part: MessagePart): ChipToolKind | null => {
  if (!isToolLikePart(part)) {
    return null;
  }

  if (parseMcpToolName(getToolName(part))) {
    return "mcp";
  }

  const toolName = normalizeToolName(getToolName(part));

  if (CHIP_TOOL_NAME_ALIASES.command.has(toolName)) {
    return "command";
  }
  if (CHIP_TOOL_NAME_ALIASES.agent.has(toolName)) {
    return "agent";
  }
  if (CHIP_TOOL_NAME_ALIASES.read.has(toolName)) {
    return "read";
  }
  if (CHIP_TOOL_NAME_ALIASES.search.has(toolName)) {
    return "search";
  }
  if (CHIP_TOOL_NAME_ALIASES.taskOutput.has(toolName)) {
    return "taskOutput";
  }
  if (CHIP_TOOL_NAME_ALIASES.toolSearch.has(toolName)) {
    return "toolSearch";
  }
  if (CHIP_TOOL_NAME_ALIASES.webFetch.has(toolName)) {
    return "webFetch";
  }
  if (CHIP_TOOL_NAME_ALIASES.list.has(toolName)) {
    return "list";
  }
  if (CHIP_TOOL_NAME_ALIASES.write.has(toolName)) {
    return "write";
  }

  return null;
};

export const isChipToolPart = (part: MessagePart): boolean =>
  getChipToolKind(part) !== null;

const REDUNDANT_DIRECT_WEB_TOOL_NAMES = new Set(["web-fetch", "web-search"]);

const getToolSearchQuery = (input: unknown) => {
  if (isString(input)) {
    return input;
  }

  if (!isRecord(input)) {
    return null;
  }

  const value =
    input.query ??
    input.pattern ??
    input.tool ??
    input.toolName ??
    input.tool_name ??
    input.name;

  return isString(value) ? value : null;
};

const getToolSearchReferences = (output: unknown) => {
  const rawMatches =
    isRecord(output) && Array.isArray(output.matches)
      ? output.matches
      : isRecord(output) && Array.isArray(output.results)
        ? output.results
        : isRecord(output) && Array.isArray(output.files)
          ? output.files
          : Array.isArray(output)
            ? output
            : [];

  return rawMatches
    .map((match) => {
      if (isString(match)) {
        return match;
      }

      if (!isRecord(match)) {
        return null;
      }

      const value = match.tool_name ?? match.toolName ?? match.name;
      return isString(value) ? value : null;
    })
    .filter((toolName): toolName is string => toolName !== null);
};

const isDirectWebToolName = (toolName: string) =>
  REDUNDANT_DIRECT_WEB_TOOL_NAMES.has(normalizeToolName(toolName));

export const isRedundantDirectWebToolSearchPart = (
  part: MessagePart,
): part is ToolLikePart => {
  if (!isToolLikePart(part) || getChipToolKind(part) !== "toolSearch") {
    return false;
  }

  if (part.state === "output-error" || part.errorText) {
    return false;
  }

  const query = getToolSearchQuery(part.input);
  if (query && isDirectWebToolName(query)) {
    return true;
  }

  const references = getToolSearchReferences(part.output);
  return (
    references.length > 0 &&
    references.every((name) => isDirectWebToolName(name))
  );
};
