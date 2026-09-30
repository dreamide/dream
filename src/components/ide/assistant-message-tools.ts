// Reading tool parts. What a tool call is, and what its raw input and
// output mean, is decided in electron/shared/tool-call.js; this file only
// adapts a message part to it.
import type { UIMessage } from "ai";
import {
  type ChipToolKind,
  getToolKindForName,
  isChipToolKind,
  isDirectWebToolSearch,
  isRecord,
  isToolKind,
  type ToolCallSource,
  type ToolKind,
} from "../../../electron/shared/tool-call.js";

export {
  type AgentToolCall,
  type ChipToolKind,
  type CommandToolCall,
  describeAgent,
  describeCommand,
  describeList,
  describeMcp,
  describeRead,
  describeSearch,
  describeTaskOutput,
  describeWebFetch,
  describeWrite,
  getCommandOutputText,
  type ListToolCall,
  parseMcpToolName,
  type ReadToolCall,
  type SearchMatch,
  type SearchToolCall,
  type ToolKind,
  type WebFetchToolCall,
  type WriteToolCall,
} from "../../../electron/shared/tool-call.js";

export type MessagePart = UIMessage["parts"][number];

export type ToolLikePart = MessagePart & {
  approval?: { id: string; approved?: boolean; reason?: string };
  errorText?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  toolCallId?: string;
  toolMetadata?: unknown;
  toolName?: string;
};

export const isToolLikePart = (part: MessagePart): part is ToolLikePart =>
  typeof part.type === "string" &&
  (part.type.startsWith("tool-") || part.type === "dynamic-tool");

export const getToolName = (part: ToolLikePart): string => {
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
    return part.toolName;
  }

  return part.type.startsWith("tool-") ? part.type.slice(5) : part.type;
};

/** A tool part as the `describe*` readers take it. */
export const getToolCallSource = (part: ToolLikePart): ToolCallSource => ({
  input: part.input,
  output: part.output,
  toolName: getToolName(part),
});

/**
 * What a tool part is: the kind the turn writer stamped on it, or, for a
 * part saved before kinds were stamped, the kind its name implies.
 */
export const getToolKind = (part: MessagePart): ToolKind | null => {
  if (!isToolLikePart(part)) {
    return null;
  }

  const stamped = isRecord(part.toolMetadata)
    ? part.toolMetadata.kind
    : undefined;
  return isToolKind(stamped) ? stamped : getToolKindForName(getToolName(part));
};

/** The chip a tool part renders as, or null for a generic tool call. */
export const getChipToolKind = (part: MessagePart): ChipToolKind | null => {
  const kind = getToolKind(part);
  return isChipToolKind(kind) ? kind : null;
};

export const isChipToolPart = (part: MessagePart): boolean =>
  getChipToolKind(part) !== null;

/**
 * A tool search that only looked up the direct web tools. The web tool's
 * own chip follows it, so the search is not shown.
 */
export const isRedundantDirectWebToolSearchPart = (
  part: MessagePart,
): part is ToolLikePart =>
  isToolLikePart(part) &&
  getToolKind(part) === "toolSearch" &&
  part.state !== "output-error" &&
  !part.errorText &&
  isDirectWebToolSearch(getToolCallSource(part));
