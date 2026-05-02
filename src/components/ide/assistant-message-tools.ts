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

export const CHIP_TOOL_NAME_ALIASES = {
  agent: new Set(["agent"]),
  command: new Set([
    "run-command",
    "runcommand",
    "command",
    "exec-command",
    "bash",
  ]),
  list: new Set(["list-files"]),
  read: new Set(["read", "read-file"]),
  search: new Set(["glob", "grep", "search", "search-in-files"]),
  taskOutput: new Set(["task-output", "taskoutput", "task-result"]),
  toolSearch: new Set(["tool-search"]),
  write: new Set(["edit", "patch", "write", "write-file"]),
} as const;

export type ChipToolKind = keyof typeof CHIP_TOOL_NAME_ALIASES;

export const getChipToolKind = (part: MessagePart): ChipToolKind | null => {
  if (!isToolLikePart(part)) {
    return null;
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
