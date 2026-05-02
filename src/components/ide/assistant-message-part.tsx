import { parsePatchFiles } from "@pierre/diffs";
import {
  BotIcon,
  CheckIcon,
  EyeIcon,
  FolderIcon,
  PenLineIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { motion } from "motion/react";
import {
  type ComponentProps,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
} from "@/components/ai-elements/confirmation";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import type { ToolPart } from "@/components/ai-elements/tool";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  CHIP_TOOL_NAME_ALIASES,
  getToolName,
  isToolLikePart,
  type MessagePart,
  normalizeToolName,
  type ToolLikePart,
} from "./assistant-message-tools";
import { IdeDiffViewer } from "./diff-viewer";
import { stringifyPart } from "./ide-state";
import { useIdeStore } from "./ide-store";
import { MaterialFileIcon } from "./material-file-icon";

type ToolApprovalHandler = (response: {
  id: string;
  approved: boolean;
  reason?: string;
  scope?: "once" | "session";
}) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const ANSI_ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI control sequences in command output
  /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]|(?:[^\u001B\u009B]*)(?:\u0007))/g;

const stripAnsiSequences = (value: string) =>
  value.replaceAll(ANSI_ESCAPE_SEQUENCE, "");

const ActionApproval = ({
  approval,
  approveLabel = "Approve",
  children,
  onToolApproval,
  rejectLabel = "Reject",
  state,
}: {
  approval: NonNullable<ToolLikePart["approval"]>;
  approveLabel?: string;
  children: ReactNode;
  onToolApproval: ToolApprovalHandler;
  rejectLabel?: string;
  state: ToolPart["state"];
}) => {
  const approvalId = approval.id;

  return (
    <Confirmation
      approval={approval as Parameters<typeof Confirmation>[0]["approval"]}
      state={state}
    >
      <ConfirmationRequest>{children}</ConfirmationRequest>
      <ConfirmationAccepted>
        <span className="flex items-center gap-1.5 text-green-700 text-sm">
          <CheckIcon className="size-4" />
          Approved
        </span>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <span className="flex items-center gap-1.5 text-red-700 text-sm">
          <XIcon className="size-4" />
          Rejected
        </span>
      </ConfirmationRejected>
      <ConfirmationActions>
        <ConfirmationAction
          variant="outline"
          onClick={() =>
            onToolApproval({
              approved: false,
              id: approvalId,
            })
          }
        >
          {rejectLabel}
        </ConfirmationAction>
        <ConfirmationAction
          variant="default"
          onClick={() =>
            onToolApproval({
              approved: true,
              id: approvalId,
              scope: "once",
            })
          }
        >
          {approveLabel}
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
};

const unquoteCommandArgument = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  if (
    (quote !== '"' && quote !== "'") ||
    trimmed[trimmed.length - 1] !== quote
  ) {
    return trimmed;
  }

  const unquoted = trimmed.slice(1, -1);
  return quote === '"' ? unquoted.replace(/\\"/g, '"') : unquoted;
};

const readShellToken = (value: string, startIndex: number) => {
  let index = startIndex;
  while (index < value.length && /\s/.test(value[index])) {
    index++;
  }

  if (index >= value.length) {
    return null;
  }

  const quote = value[index];
  if (quote === '"' || quote === "'") {
    let token = "";
    index++;
    while (index < value.length) {
      const char = value[index];
      if (char === quote) {
        return { endIndex: index + 1, token };
      }
      token += char;
      index++;
    }
    return { endIndex: index, token };
  }

  const tokenStart = index;
  while (index < value.length && !/\s/.test(value[index])) {
    index++;
  }

  return { endIndex: index, token: value.slice(tokenStart, index) };
};

const getExecutableName = (value: string) =>
  value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase();

const getCommandWithoutShellPrefix = (command: string) => {
  const executable = readShellToken(command, 0);
  if (!executable) {
    return command;
  }

  const executableName = getExecutableName(executable.token).replace(
    /\.exe$/i,
    "",
  );
  const isPowerShell =
    executableName === "pwsh" || executableName === "powershell";
  const isPosixShell =
    executableName === "sh" ||
    executableName === "bash" ||
    executableName === "zsh";

  if (!(isPowerShell || isPosixShell)) {
    return command;
  }

  let cursor = executable.endIndex;
  while (true) {
    const token = readShellToken(command, cursor);
    if (!token) {
      return command;
    }

    cursor = token.endIndex;
    const normalizedToken = token.token.toLowerCase();
    const isCommandFlag = isPowerShell
      ? normalizedToken === "-command" || normalizedToken === "-c"
      : /^-[a-z]*c[a-z]*$/i.test(token.token);

    if (isCommandFlag) {
      const innerCommand = command.slice(cursor).trim();
      return innerCommand ? unquoteCommandArgument(innerCommand) : command;
    }

    if (!token.token.startsWith("-")) {
      return command;
    }
  }
};

const formatToolName = (name: string): string =>
  name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const TOOL_STATE_LABELS: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const CHIP_ERROR_CLASSES =
  "border-destructive/30 bg-destructive/5 text-destructive dark:bg-destructive/10";
const getChipToneClasses = (defaultClasses: string, hasError: boolean) =>
  hasError ? CHIP_ERROR_CLASSES : defaultClasses;
const getExpandedChipClasses = (
  defaultTextClasses: string,
  hasError: boolean,
) =>
  cn(
    "mt-2 space-y-2 border-l pl-2",
    hasError ? "text-destructive" : defaultTextClasses,
  );
const CHIP_DETAIL_HEADER_CLASSES =
  "shrink-0 border-0 bg-transparent px-3 py-2 text-[12px]";
const RUN_COMMAND_HEADER_CLASSES =
  "shrink-0 border-0 bg-transparent px-3 pt-2 pb-1 text-[12px]";
const CHIP_BUTTON_BASE_CLASSES =
  "animate-[chip-enter_0.3s_ease-out] inline-flex items-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-1 text-xs transition-colors";
const CHIP_SUBTEXT_CLASSES = "opacity-70";
const CHIP_ERROR_SUBTEXT_CLASSES = "text-destructive/70";
const CHIP_LAYOUT_TRANSITION = {
  damping: 32,
  duration: 0.18,
  stiffness: 520,
  type: "spring",
} as const;

const ChipButton = ({
  className,
  ...props
}: ComponentProps<typeof motion.button>) => (
  <motion.button
    className={cn(CHIP_BUTTON_BASE_CLASSES, className)}
    layout="size"
    transition={CHIP_LAYOUT_TRANSITION}
    {...props}
  />
);
const STREAMING_WORD_INTERVAL_MS = 40;
const STREAMING_MIN_INTERVAL_MS = 18;
const STREAMING_BACKLOG_START_CHARS = 120;
const STREAMING_BACKLOG_FULL_SPEED_CHARS = 900;
const STREAMING_BACKLOG_TARGET_TICKS = 18;
const STREAMING_MIN_CHARS_PER_TICK = 24;
const STREAMING_MAX_CHARS_PER_TICK = 140;
const STREAMING_FINISHED_INTERVAL_MS = 8;
const STREAMING_FINISHED_MIN_CHARS_PER_TICK = 240;
const STREAMING_FINISHED_MAX_CHARS_PER_TICK = 1200;

const extToLanguage: Record<string, BundledLanguage> = {
  astro: "astro",
  bash: "bash",
  c: "c",
  coffee: "coffee",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  elm: "elm",
  env: "dotenv",
  erl: "erlang",
  ex: "elixir",
  go: "go",
  graphql: "graphql",
  h: "c",
  hbs: "handlebars",
  hpp: "cpp",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json5",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  prisma: "prisma",
  proto: "proto",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scala: "scala",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "log",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zsh: "bash",
};

const inferLanguage = (filePath: string): BundledLanguage => {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extToLanguage[ext] ?? "log";
};

const getNestedValue = (value: unknown, path: readonly string[]): unknown => {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
};

const getStringFromPaths = (
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
  options?: { allowEmpty?: boolean },
): string | null => {
  for (const path of paths) {
    const candidate = path.length === 0 ? value : getNestedValue(value, path);

    if (!isString(candidate)) {
      continue;
    }
    if (options?.allowEmpty || candidate.length > 0) {
      return candidate;
    }
  }

  return null;
};

const getNumberFromPaths = (
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
): number | null => {
  for (const path of paths) {
    const candidate = path.length === 0 ? value : getNestedValue(value, path);

    if (typeof candidate === "number") {
      return candidate;
    }
  }

  return null;
};

const normalizeEmbeddedLineNumbers = (
  content: string,
  startLine?: number | null,
): {
  code: string;
  hadEmbeddedLineNumbers: boolean;
  startingLineNumber: number;
} => {
  const sanitizedContent = content
    .replace(/\r\n/g, "\n")
    .replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/i, "");
  const lines = sanitizedContent.split("\n");
  if (lines.length < 2) {
    return {
      code: sanitizedContent,
      hadEmbeddedLineNumbers: false,
      startingLineNumber: startLine ?? 1,
    };
  }

  const parsedLines = lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s*(?:\||:|->|→|↦|›)\s?(.*)$/);
    if (!match) {
      return null;
    }

    const lineNumber = Number(match[1]);
    if (!Number.isFinite(lineNumber)) {
      return null;
    }

    return {
      code: match[2] ?? "",
      lineNumber,
    };
  });

  let bestRun: {
    lines: string[];
    startingLineNumber: number;
    startsAtRequestedLine: boolean;
  } | null = null;

  for (let index = 0; index < parsedLines.length; index += 1) {
    const parsedLine = parsedLines[index];
    if (!parsedLine) {
      continue;
    }

    const runLines = [parsedLine.code];
    const runStart = parsedLine.lineNumber;
    let expected = parsedLine.lineNumber + 1;

    for (
      let nextIndex = index + 1;
      nextIndex < parsedLines.length;
      nextIndex += 1
    ) {
      const nextLine = parsedLines[nextIndex];
      if (!nextLine || nextLine.lineNumber !== expected) {
        break;
      }

      runLines.push(nextLine.code);
      expected += 1;
    }

    if (runLines.length < 2) {
      continue;
    }

    const startsAtRequestedLine =
      startLine !== null && startLine !== undefined && runStart === startLine;

    if (
      !bestRun ||
      (startsAtRequestedLine && !bestRun.startsAtRequestedLine) ||
      (startsAtRequestedLine === bestRun.startsAtRequestedLine &&
        runLines.length > bestRun.lines.length)
    ) {
      bestRun = {
        lines: runLines,
        startingLineNumber: runStart,
        startsAtRequestedLine,
      };
    }
  }

  if (!bestRun) {
    return {
      code: sanitizedContent,
      hadEmbeddedLineNumbers: false,
      startingLineNumber: startLine ?? 1,
    };
  }

  return {
    code: bestRun.lines.join("\n"),
    hadEmbeddedLineNumbers: true,
    startingLineNumber: bestRun.startingLineNumber,
  };
};

const getNextStreamingWordToken = (text: string) =>
  text.match(/^(\s+|\S+\s*)/)?.[0] ?? text.slice(0, 1);

const getBacklogPressure = (remainingLength: number) => {
  if (remainingLength <= STREAMING_BACKLOG_START_CHARS) {
    return 0;
  }

  return Math.min(
    1,
    (remainingLength - STREAMING_BACKLOG_START_CHARS) /
      (STREAMING_BACKLOG_FULL_SPEED_CHARS - STREAMING_BACKLOG_START_CHARS),
  );
};

const getNextStreamingChunkText = (
  currentText: string,
  targetText: string,
  targetChunkSize: number,
) => {
  const remainingText = targetText.slice(currentText.length);
  let chunkLength = 0;

  while (chunkLength < remainingText.length && chunkLength < targetChunkSize) {
    chunkLength += getNextStreamingWordToken(
      remainingText.slice(chunkLength),
    ).length;
  }

  return targetText.slice(0, currentText.length + chunkLength);
};

const getNextStreamingFrame = (
  currentText: string,
  targetText: string,
  isStreaming: boolean,
) => {
  const remainingText = targetText.slice(currentText.length);

  if (isStreaming) {
    const pressure = getBacklogPressure(remainingText.length);

    if (pressure === 0) {
      return {
        intervalMs: STREAMING_WORD_INTERVAL_MS,
        nextText: currentText + getNextStreamingWordToken(remainingText),
      };
    }

    const targetChunkSize = Math.min(
      STREAMING_MAX_CHARS_PER_TICK,
      Math.max(
        STREAMING_MIN_CHARS_PER_TICK,
        Math.ceil(remainingText.length / STREAMING_BACKLOG_TARGET_TICKS),
      ),
    );
    const intervalMs = Math.round(
      STREAMING_WORD_INTERVAL_MS -
        pressure * (STREAMING_WORD_INTERVAL_MS - STREAMING_MIN_INTERVAL_MS),
    );

    return {
      intervalMs,
      nextText: getNextStreamingChunkText(
        currentText,
        targetText,
        targetChunkSize,
      ),
    };
  }

  const targetChunkSize = Math.min(
    STREAMING_FINISHED_MAX_CHARS_PER_TICK,
    Math.max(
      STREAMING_FINISHED_MIN_CHARS_PER_TICK,
      Math.ceil(remainingText.length / 4),
    ),
  );

  return {
    intervalMs: STREAMING_FINISHED_INTERVAL_MS,
    nextText: getNextStreamingChunkText(
      currentText,
      targetText,
      targetChunkSize,
    ),
  };
};

const StreamingMessageResponse = ({
  isStreaming,
  text,
}: {
  isStreaming: boolean;
  text: string;
}) => {
  const hasStreamedRef = useRef(isStreaming);
  const isStreamingRef = useRef(isStreaming);
  const targetTextRef = useRef(text);
  const visibleTextRef = useRef(isStreaming ? "" : text);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<() => void>(() => {});
  const [visibleText, setVisibleText] = useState(visibleTextRef.current);

  const scheduleTick = useCallback((delayMs: number) => {
    if (timeoutIdRef.current !== null) {
      return;
    }

    timeoutIdRef.current = setTimeout(() => {
      timeoutIdRef.current = null;
      tickRef.current();
    }, delayMs);
  }, []);

  tickRef.current = () => {
    const targetText = targetTextRef.current;
    const currentText = visibleTextRef.current;

    if (currentText === targetText) {
      return;
    }

    if (!targetText.startsWith(currentText)) {
      visibleTextRef.current = targetText;
      startTransition(() => {
        setVisibleText(targetText);
      });
      return;
    }

    const { intervalMs, nextText } = getNextStreamingFrame(
      currentText,
      targetText,
      isStreamingRef.current,
    );

    if (nextText === currentText) {
      visibleTextRef.current = targetText;
      startTransition(() => {
        setVisibleText(targetText);
      });
      return;
    }

    visibleTextRef.current = nextText;
    startTransition(() => {
      setVisibleText(nextText);
    });

    if (nextText !== targetText) {
      scheduleTick(intervalMs);
    }
  };

  useEffect(() => {
    targetTextRef.current = text;
    isStreamingRef.current = isStreaming;
    if (isStreaming) {
      hasStreamedRef.current = true;
    }
    if (!hasStreamedRef.current) {
      if (visibleTextRef.current !== text) {
        visibleTextRef.current = text;
        setVisibleText(text);
      }
      return;
    }

    if (visibleTextRef.current !== targetTextRef.current) {
      scheduleTick(
        isStreaming
          ? STREAMING_WORD_INTERVAL_MS
          : STREAMING_FINISHED_INTERVAL_MS,
      );
    }
  }, [isStreaming, scheduleTick, text]);

  useEffect(() => {
    return () => {
      if (timeoutIdRef.current !== null) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
    };
  }, []);

  return <MessageResponse>{visibleText}</MessageResponse>;
};

const buildLineDiff = (previousContent: string, nextContent: string) => {
  const previousLines = previousContent.replace(/\r\n/g, "\n").split("\n");
  const nextLines = nextContent.replace(/\r\n/g, "\n").split("\n");
  const lengths = Array.from({ length: previousLines.length + 1 }, () =>
    Array<number>(nextLines.length + 1).fill(0),
  );

  for (let i = previousLines.length - 1; i >= 0; i -= 1) {
    for (let j = nextLines.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        previousLines[i] === nextLines[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let previousIndex = 0;
  let nextIndex = 0;

  while (previousIndex < previousLines.length && nextIndex < nextLines.length) {
    if (previousLines[previousIndex] === nextLines[nextIndex]) {
      lines.push(` ${previousLines[previousIndex]}`);
      previousIndex += 1;
      nextIndex += 1;
    } else if (
      lengths[previousIndex + 1][nextIndex] >=
      lengths[previousIndex][nextIndex + 1]
    ) {
      lines.push(`-${previousLines[previousIndex]}`);
      previousIndex += 1;
    } else {
      lines.push(`+${nextLines[nextIndex]}`);
      nextIndex += 1;
    }
  }

  while (previousIndex < previousLines.length) {
    lines.push(`-${previousLines[previousIndex]}`);
    previousIndex += 1;
  }

  while (nextIndex < nextLines.length) {
    lines.push(`+${nextLines[nextIndex]}`);
    nextIndex += 1;
  }

  return lines.join("\n");
};

const buildWriteDiff = ({
  content,
  filePath,
  mode,
  previousContent,
}: {
  content: string;
  filePath: string;
  mode: string | null;
  previousContent: string;
}) => {
  const nextContent =
    mode === "append" ? `${previousContent}${content}` : content;
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    "@@",
    buildLineDiff(previousContent, nextContent),
  ].join("\n");
};

const parseSingleDiff = (diff: string) => {
  try {
    const parsedPatches = parsePatchFiles(diff);
    if (parsedPatches.length !== 1) {
      return null;
    }

    const files = parsedPatches[0]?.files;
    if (!Array.isArray(files) || files.length !== 1) {
      return null;
    }

    return files[0] ?? null;
  } catch {
    return null;
  }
};

const getDiffStats = (diff: ReturnType<typeof parseSingleDiff>) => {
  if (!diff) {
    return null;
  }

  const additions = diff.hunks.reduce(
    (total, hunk) => total + hunk.additionLines,
    0,
  );
  const deletions = diff.hunks.reduce(
    (total, hunk) => total + hunk.deletionLines,
    0,
  );

  if (additions === 0 && deletions === 0) {
    return null;
  }

  return { additions, deletions };
};

const getWriteFileStateLabel = (
  diff: ReturnType<typeof parseSingleDiff>,
  mode: string | null,
  previousContent: string | null,
) => {
  if (diff) {
    if (diff.type === "new") {
      return "created";
    }
    if (diff.type === "deleted") {
      return "deleted";
    }
    if (diff.type === "rename-pure" || diff.type === "rename-changed") {
      return "renamed";
    }
    return "modified";
  }

  if (mode === "append" || previousContent !== null) {
    return "modified";
  }

  return null;
};

const toRelativeProjectPath = (projectPath: string, filePath: string) => {
  const normalizedProjectPath = projectPath
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
  const normalizedFilePath = filePath.replace(/\\/g, "/");

  if (
    normalizedFilePath
      .toLowerCase()
      .startsWith(`${normalizedProjectPath.toLowerCase()}/`)
  ) {
    return normalizedFilePath.slice(normalizedProjectPath.length + 1);
  }

  return normalizedFilePath;
};

const readResponseText = async (response: Response) => {
  try {
    return await response.text();
  } catch {
    return "Request failed.";
  }
};

const getFilePathFromOutputText = (output: unknown) => {
  if (!isString(output)) {
    return null;
  }

  const match = output.match(
    /(?:^|\b)(?:the\s+)?file\s+(.+?)\s+(?:has\s+been|was)\s+(?:updated|written|created)\b/i,
  );
  const rawPath = match?.[1]?.trim();
  if (!rawPath) {
    return null;
  }

  return rawPath.replace(/^['"`]+|['"`.]+$/g, "");
};

const formatWriteOutputMessage = (output: unknown) => {
  const message = isString(output)
    ? output
    : isRecord(output) && isString(output.message)
      ? output.message
      : null;

  if (!message) {
    return null;
  }

  return message
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\\/g, "/");
};

const getAgentOutputText = (output: unknown): string | null => {
  if (!isString(output) || output.length === 0) {
    return null;
  }

  const withoutUsage = output.replace(/\n*<usage>[\s\S]*?<\/usage>\s*$/i, "");
  const withoutAgentId = withoutUsage.replace(
    /\n*agentId:[^\n]*(?:\n|$)/i,
    "\n",
  );
  const trimmed = withoutAgentId.trim();

  return trimmed.length > 0 ? trimmed : null;
};

const JsonBlock = ({ value }: { value: unknown }) => (
  <CodeBlock code={stringifyPart(value)} language="json" />
);

interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  isFile: boolean;
}

const buildFileTree = (
  paths: string[],
): { root: FileTreeNode; defaultExpanded: Set<string> } => {
  const root: FileTreeNode = {
    name: "",
    path: "",
    children: new Map(),
    isFile: false,
  };

  for (const filePath of paths) {
    const parts = filePath.split(/[\\/]/);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const currentPath = parts.slice(0, i + 1).join("/");
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: currentPath,
          children: new Map(),
          isFile: isLast,
        });
      }

      const nextNode = current.children.get(part);
      if (!nextNode) {
        continue;
      }
      current = nextNode;
    }
  }

  // Auto-expand first level folders
  const defaultExpanded = new Set<string>();
  for (const child of root.children.values()) {
    if (!child.isFile) {
      defaultExpanded.add(child.path);
    }
  }

  return { root, defaultExpanded };
};

const FileTreeNodeView = ({ node }: { node: FileTreeNode }) => {
  const sortedChildren = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  if (node.isFile) {
    return <FileTreeFile name={node.name} path={node.path} />;
  }

  return (
    <FileTreeFolder name={node.name} path={node.path}>
      {sortedChildren.map((child) => (
        <FileTreeNodeView key={child.path} node={child} />
      ))}
    </FileTreeFolder>
  );
};

export const ListFilesChip = ({
  defaultExpanded = false,
  part,
  projectPath,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
  projectPath?: string | null;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  const { files, count } = useMemo(() => {
    if (!isRecord(output)) {
      return { files: null, count: 0 };
    }
    const candidates = [
      output.files,
      output.matches,
      output.paths,
      output.results,
    ].find(Array.isArray);

    if (!Array.isArray(candidates)) {
      return { files: null, count: 0 };
    }

    const filtered = candidates
      .map((item) => {
        if (isString(item)) {
          return item;
        }
        if (isRecord(item) && isString(item.path)) {
          return item.path;
        }
        if (isRecord(item) && isString(item.file)) {
          return item.file;
        }
        return null;
      })
      .filter((item): item is string => item !== null);

    return {
      files: filtered,
      count: typeof output.count === "number" ? output.count : filtered.length,
    };
  }, [output]);

  const { root, defaultExpandedFolders } = useMemo(() => {
    if (!files) {
      return { root: null, defaultExpandedFolders: new Set<string>() };
    }
    const tree = buildFileTree(files);
    return { root: tree.root, defaultExpandedFolders: tree.defaultExpanded };
  }, [files]);

  const hasOutput = files !== null && root !== null;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || hasRawOutput;
  const rawDirectory =
    isRecord(part.input) && isString(part.input.directory)
      ? part.input.directory
      : isRecord(part.input) && isString(part.input.path)
        ? part.input.path
        : null;
  const pattern =
    isRecord(part.input) && isString(part.input.pattern)
      ? part.input.pattern
      : null;
  const directory =
    rawDirectory === "." && projectPath ? projectPath : rawDirectory;
  const label = pattern ?? directory ?? "files";
  const displayLabel = label === "files" && isRunning ? "Listing" : label;
  const Icon = pattern ? SearchIcon : FolderIcon;

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  const sortedChildren = useMemo(() => {
    if (!root) return [];
    return [...root.children.values()].sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [root]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          getChipToneClasses(
            "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400",
            hasError,
          ),
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={displayLabel}
        type="button"
      >
        <Icon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="max-w-56 truncate font-medium">
              {displayLabel}
            </span>
            {hasOutput ? (
              <span className={CHIP_SUBTEXT_CLASSES}>
                {count} {count === 1 ? "file" : "files"}
              </span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses(
            "text-amber-700 dark:text-amber-400",
            hasError,
          )}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {hasOutput ? (
            <FileTree
              className="text-xs"
              defaultExpanded={defaultExpandedFolders}
            >
              {sortedChildren.map((child) => (
                <FileTreeNodeView key={child.path} node={child} />
              ))}
            </FileTree>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// ── Chip-based tool components ─────────────────────────────────────────

export const AgentChip = ({
  defaultExpanded = false,
  part,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const outputText = getAgentOutputText(part.output);
  const hasRawOutput = part.output !== undefined;
  const canExpand = hasError || hasRawOutput;
  const description =
    getStringFromPaths(part.input, [["description"]]) ?? "Agent";
  const displayDescription =
    description === "Agent" && isRunning ? "Running agent" : description;
  const subagentType = getStringFromPaths(part.input, [
    ["subagent_type"],
    ["subagentType"],
    ["type"],
  ]);

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          getChipToneClasses(
            "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300",
            hasError,
          ),
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={displayDescription}
        type="button"
      >
        <BotIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="max-w-56 truncate font-medium">
              {displayDescription}
            </span>
            {subagentType ? (
              <span className={CHIP_SUBTEXT_CLASSES}>{subagentType}</span>
            ) : null}
            <span className={CHIP_SUBTEXT_CLASSES}>
              {formatToolName(state)}
            </span>
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses(
            "text-slate-700 dark:text-slate-300",
            hasError,
          )}
          style={{ borderColor: "currentColor" }}
        >
          {isRecord(part.input) ? (
            <div className="space-y-2 rounded-md bg-muted/20 p-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Parameters
              </h4>
              <div className="rounded-md bg-muted/50">
                <CodeBlock
                  code={JSON.stringify(part.input, null, 2)}
                  language="json"
                />
              </div>
            </div>
          ) : null}
          {hasError ? (
            <div className="space-y-2 rounded-md bg-destructive/5 p-3">
              <h4 className="font-medium text-destructive text-xs uppercase tracking-wide">
                Result
              </h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-destructive text-xs">
                {part.errorText}
              </pre>
            </div>
          ) : outputText ? (
            <div className="space-y-2 rounded-md bg-muted/20 p-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Result
              </h4>
              <div className="rounded-md border bg-background p-3 text-foreground">
                <MessageResponse>{outputText}</MessageResponse>
              </div>
            </div>
          ) : hasRawOutput ? (
            <JsonBlock value={part.output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const ReadFileChip = ({
  defaultExpanded = false,
  part,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const filePath =
    getStringFromPaths(part.input, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["file", "path"],
      ["file", "filePath"],
    ]) ??
    getStringFromPaths(output, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["file"],
      ["file", "path"],
      ["file", "filePath"],
    ]);
  const content =
    getStringFromPaths(
      output,
      [
        [],
        ["content"],
        ["text"],
        ["contents"],
        ["file", "content"],
        ["file", "text"],
      ],
      { allowEmpty: true },
    ) ??
    getStringFromPaths(part.input, [["content"], ["text"]], {
      allowEmpty: true,
    });
  const start =
    getNumberFromPaths(output, [["startLine"], ["start_line"]]) ??
    getNumberFromPaths(part.input, [["startLine"], ["start_line"]]);
  const end =
    getNumberFromPaths(output, [["endLine"], ["end_line"]]) ??
    getNumberFromPaths(part.input, [["endLine"], ["end_line"]]);
  const filename =
    filePath?.split(/[\\/]/).pop() ??
    getStringFromPaths(part.input, [
      ["filename"],
      ["name"],
      ["file", "name"],
    ]) ??
    getStringFromPaths(output, [["filename"], ["name"], ["file", "name"]]) ??
    "file";
  const normalizedContent =
    content !== null ? normalizeEmbeddedLineNumbers(content, start) : null;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || content !== null || hasRawOutput;
  const previewLanguage = inferLanguage(filePath ?? filename);
  const previewCode = normalizedContent?.code ?? content ?? "";
  const previewStartLine = normalizedContent?.startingLineNumber ?? start ?? 1;
  const displayFilename =
    filename === "file" && isRunning ? "Reading" : filename;
  const displayStart = start ?? normalizedContent?.startingLineNumber ?? 1;
  const displayEnd =
    end ??
    (content !== null
      ? displayStart + previewCode.split(/\r?\n/).length - 1
      : null);
  const lineRangeLabel =
    displayEnd !== null
      ? displayStart === displayEnd
        ? `Line ${displayStart}`
        : `Lines ${displayStart}-${displayEnd}`
      : null;

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          getChipToneClasses(
            "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-400",
            hasError,
          ),
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={displayFilename}
        type="button"
      >
        <EyeIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="max-w-48 truncate font-medium">
              {displayFilename}
            </span>
            {lineRangeLabel ? (
              <span className={CHIP_SUBTEXT_CLASSES}>{lineRangeLabel}</span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses(
            "text-green-700 dark:text-green-400",
            hasError,
          )}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {content !== null ? (
            <CodeBlock
              className="max-h-96 flex flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
              code={previewCode}
              language={previewLanguage}
              showLineNumbers
              startingLineNumber={previewStartLine}
              style={{ contentVisibility: "visible" }}
            >
              <CodeBlockHeader className={CHIP_DETAIL_HEADER_CLASSES}>
                <CodeBlockTitle>
                  <MaterialFileIcon
                    className="size-3.5"
                    path={filePath ?? filename}
                  />
                  <CodeBlockFilename>{filename}</CodeBlockFilename>
                  {lineRangeLabel ? (
                    <Badge variant="secondary" className="ml-1 text-sm">
                      {lineRangeLabel}
                    </Badge>
                  ) : null}
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const SearchInFilesChip = ({
  defaultExpanded = false,
  part,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const rawMatches =
    isRecord(output) && Array.isArray(output.matches)
      ? output.matches
      : isRecord(output) && Array.isArray(output.results)
        ? output.results
        : isRecord(output) && Array.isArray(output.files)
          ? output.files
          : Array.isArray(output)
            ? output
            : null;
  const matches = Array.isArray(rawMatches) ? rawMatches.filter(isRecord) : [];
  const textResults = (
    isString(output)
      ? output.split(/\r?\n/)
      : Array.isArray(rawMatches)
        ? rawMatches.filter(isString)
        : []
  ).filter((line) => {
    const trimmedLine = line.trim();
    return (
      trimmedLine.length > 0 && trimmedLine.toLowerCase() !== "no files found"
    );
  });
  const toolReferences = matches
    .map(
      (match) =>
        (isString(match.tool_name) && match.tool_name) ||
        (isString(match.toolName) && match.toolName) ||
        null,
    )
    .filter((toolName): toolName is string => toolName !== null);
  const normalizedToolName = normalizeToolName(getToolName(part));
  const isToolSearch =
    CHIP_TOOL_NAME_ALIASES.toolSearch.has(normalizedToolName);
  const isToolReferenceSearch = isToolSearch || toolReferences.length > 0;
  const hasOutput = rawMatches !== null || textResults.length > 0;
  const count =
    isRecord(output) && typeof output.count === "number"
      ? output.count
      : Array.isArray(rawMatches)
        ? rawMatches.length
        : textResults.length;
  const query =
    isRecord(part.input) && isString(part.input.query)
      ? part.input.query
      : isRecord(part.input) && isString(part.input.pattern)
        ? part.input.pattern
        : null;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || hasRawOutput;
  const label = query ?? "Search";
  const SearchChipIcon = isToolReferenceSearch ? WrenchIcon : SearchIcon;

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          getChipToneClasses(
            isToolReferenceSearch
              ? "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-400"
              : "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-400",
            hasError,
          ),
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={label}
        type="button"
      >
        <SearchChipIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            {isToolReferenceSearch && toolReferences.length > 0 ? (
              <span className="max-w-64 truncate font-medium">
                Tools: {toolReferences.join(", ")}
              </span>
            ) : isToolSearch ? (
              <span className="max-w-48 truncate font-medium">
                {query ? `Tools: ${query}` : "Tools search"}
              </span>
            ) : query ? (
              <span className="max-w-48 truncate font-medium">{label}</span>
            ) : (
              <span className="font-medium">Search</span>
            )}
            {hasOutput && count > 0 ? (
              <span className={CHIP_SUBTEXT_CLASSES}>
                {count}{" "}
                {isToolReferenceSearch
                  ? count === 1
                    ? "tool"
                    : "tools"
                  : textResults.length > 0
                    ? count === 1
                      ? "result"
                      : "results"
                    : count === 1
                      ? "match"
                      : "matches"}
              </span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses(
            isToolReferenceSearch
              ? "text-orange-700 dark:text-orange-400"
              : "text-blue-700 dark:text-blue-400",
            hasError,
          )}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {hasOutput ? (
            <div className="max-h-80 space-y-1 overflow-auto rounded-md border bg-background p-2 text-foreground">
              {isToolReferenceSearch ? (
                <div className="flex flex-wrap gap-1.5">
                  {toolReferences.map((toolName) => (
                    <Badge
                      className="rounded-full font-medium text-xs"
                      key={toolName}
                      variant="secondary"
                    >
                      {toolName}
                    </Badge>
                  ))}
                </div>
              ) : textResults.length > 0 ? (
                <div className="space-y-1">
                  {textResults.map((result) => (
                    <div
                      className="rounded-sm px-2 py-1.5 font-mono text-xs hover:bg-muted/40"
                      key={result}
                    >
                      {result}
                    </div>
                  ))}
                </div>
              ) : matches.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No matches found.
                </p>
              ) : (
                matches.map((match) => {
                  const file =
                    (isString(match.file) && match.file) ||
                    (isString(match.path) && match.path) ||
                    null;
                  const toolName =
                    (isString(match.tool_name) && match.tool_name) ||
                    (isString(match.toolName) && match.toolName) ||
                    null;
                  const line =
                    typeof match.line === "number"
                      ? match.line
                      : typeof match.line_number === "number"
                        ? match.line_number
                        : "?";
                  const text =
                    (isString(match.text) && match.text) ||
                    (isString(match.preview) && match.preview) ||
                    (isString(match.lineText) && match.lineText) ||
                    "";
                  const key = `${file ?? toolName ?? "result"}:${line}:${text}`;

                  return (
                    <div
                      className="rounded-sm px-2 py-1.5 hover:bg-muted/40"
                      key={key}
                    >
                      {file ? (
                        <>
                          <p className="font-mono text-xs text-muted-foreground">
                            {file}:{line}
                          </p>
                          <p className="font-mono text-xs">
                            {text || "(empty line)"}
                          </p>
                        </>
                      ) : toolName ? (
                        <p className="font-medium text-sm">{toolName}</p>
                      ) : (
                        <JsonBlock value={match} />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const RunCommandChip = ({
  defaultExpanded = false,
  onToolApproval,
  part,
}: {
  defaultExpanded?: boolean;
  onToolApproval?: ToolApprovalHandler;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";
  const command =
    isRecord(part.input) && isString(part.input.command)
      ? part.input.command
      : isRecord(output) && isString(output.command)
        ? output.command
        : null;
  const exitCode =
    isRecord(output) && typeof output.exitCode === "number"
      ? output.exitCode
      : null;
  const commandOutput = useMemo(() => {
    if (isString(output)) {
      return stripAnsiSequences(output);
    }

    if (!isRecord(output)) {
      return null;
    }

    const combinedOutput = [output.stdout, output.stderr]
      .filter(isString)
      .join(output.stdout && output.stderr ? "\n" : "");
    const textOutput =
      (isString(output.output) && output.output) ||
      combinedOutput ||
      (isString(output.result) ? output.result : null);

    return textOutput ? stripAnsiSequences(textOutput) : null;
  }, [output]);
  const status =
    isRecord(output) && isString(output.status) ? output.status : null;
  const hasRawOutput = output !== undefined;
  const approvalId = part.approval?.id;
  const canExpand =
    hasError || isApprovalRequested || hasRawOutput || command !== null;

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  const displayCommand = useMemo(() => {
    if (!command) {
      return null;
    }

    return getCommandWithoutShellPrefix(command);
  }, [command]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          getChipToneClasses(
            "border-lime-300 bg-lime-50 text-lime-700 dark:border-lime-700 dark:bg-lime-950 dark:text-lime-300",
            hasError,
          ),
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={displayCommand ?? (isRunning ? "Running" : "Command")}
        type="button"
      >
        <TerminalIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="max-w-64 truncate font-medium">
              {displayCommand ?? "Command"}
            </span>
            {exitCode !== null ? (
              <span className={CHIP_SUBTEXT_CLASSES}>exit {exitCode}</span>
            ) : null}
            {status === "running" ? (
              <span className={CHIP_SUBTEXT_CLASSES}>running</span>
            ) : null}
            {isApprovalRequested ? (
              <span className="text-yellow-600">approval</span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses(
            "text-lime-700 dark:text-lime-300",
            hasError,
          )}
          style={{ borderColor: "currentColor" }}
        >
          {approvalId && part.approval && onToolApproval ? (
            <ActionApproval
              approval={part.approval}
              onToolApproval={onToolApproval}
              state={state}
            >
              <span className="text-sm">
                Allow running{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  {displayCommand ?? command ?? "command"}
                </code>
                ?
              </span>
            </ActionApproval>
          ) : null}
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {command || commandOutput ? (
            <div className="overflow-hidden rounded-md border bg-background">
              {command ? (
                <CodeBlock
                  className="rounded-none border-0 [&_pre]:text-xs"
                  code={displayCommand ?? command}
                  language="bash"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <TerminalIcon size={14} />
                      <CodeBlockFilename>Command</CodeBlockFilename>
                      {exitCode !== null ? (
                        <Badge
                          variant="secondary"
                          className="ml-1 font-mono text-xs"
                        >
                          Exit {exitCode}
                        </Badge>
                      ) : null}
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
              {command && commandOutput ? <div className="border-t" /> : null}
              {commandOutput ? (
                <CodeBlock
                  className="max-h-96 flex flex-col rounded-none border-0 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:text-xs"
                  code={commandOutput}
                  language="log"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <TerminalIcon size={14} />
                      <CodeBlockFilename>Output</CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
            </div>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const TaskOutputChip = ({
  defaultExpanded = false,
  part,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const taskId =
    getStringFromPaths(part.input, [["task_id"], ["taskId"], ["id"]]) ??
    getStringFromPaths(part.output, [["task_id"], ["taskId"], ["id"]]);
  const parametersCode = isRecord(part.input)
    ? JSON.stringify(part.input, null, 2)
    : null;
  const outputText =
    isString(part.output) && part.output.length > 0 ? part.output : null;
  const hasRawOutput = part.output !== undefined;
  const resultCode = hasError
    ? (part.errorText ?? "")
    : outputText !== null
      ? outputText
      : hasRawOutput
        ? stringifyPart(part.output)
        : null;
  const canExpand = parametersCode !== null || resultCode !== null;
  const resultLanguage: BundledLanguage = hasError
    ? "log"
    : outputText?.trimStart().startsWith("<")
      ? "xml"
      : outputText !== null
        ? "log"
        : "json";

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          getChipToneClasses(
            "border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
            hasError,
          ),
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label="Task output"
        type="button"
      >
        <WrenchIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="font-medium">Task output</span>
            {taskId ? (
              <span className={cn("max-w-28 truncate", CHIP_SUBTEXT_CLASSES)}>
                {taskId}
              </span>
            ) : null}
            <span className={CHIP_SUBTEXT_CLASSES}>
              {TOOL_STATE_LABELS[state]}
            </span>
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses(
            "text-cyan-700 dark:text-cyan-300",
            hasError,
          )}
          style={{ borderColor: "currentColor" }}
        >
          {parametersCode !== null || resultCode !== null ? (
            <div className="overflow-hidden rounded-md border bg-background">
              {parametersCode !== null ? (
                <CodeBlock
                  className="max-h-64 flex flex-col rounded-none border-0 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:text-xs"
                  code={parametersCode}
                  language="json"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <WrenchIcon size={14} />
                      <CodeBlockFilename>Parameters</CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
              {parametersCode !== null && resultCode !== null ? (
                <div className="border-t" />
              ) : null}
              {resultCode !== null ? (
                <CodeBlock
                  className="max-h-96 flex flex-col rounded-none border-0 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:text-xs"
                  code={resultCode}
                  language={resultLanguage}
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <WrenchIcon size={14} />
                      <CodeBlockFilename>
                        {hasError ? "Error" : "Result"}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const WriteFileChip = ({
  defaultExpanded = false,
  part,
  projectPath,
  onToolApproval,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
  projectPath?: string | null;
  onToolApproval?: ToolApprovalHandler;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";
  const activeProjectPath = useIdeStore(
    (s) => s.getActiveProject()?.path ?? null,
  );
  const diffProjectPath = projectPath ?? activeProjectPath;
  const [gitDiff, setGitDiff] = useState<string | null>(null);
  const [gitDiffError, setGitDiffError] = useState<string | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);

  const filePath =
    getStringFromPaths(part.input, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["filename"],
      ["name"],
      ["file", "path"],
      ["file", "filePath"],
      ["file", "filename"],
      ["file", "name"],
    ]) ??
    getStringFromPaths(output, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["filename"],
      ["name"],
      ["file"],
      ["file", "path"],
      ["file", "filePath"],
      ["file", "filename"],
      ["file", "name"],
    ]) ??
    getFilePathFromOutputText(output);
  const filename =
    filePath?.split(/[\\/]/).pop() ??
    getStringFromPaths(part.input, [
      ["filename"],
      ["name"],
      ["file", "name"],
    ]) ??
    getStringFromPaths(output, [["filename"], ["name"], ["file", "name"]]) ??
    "file";
  const content =
    getStringFromPaths(
      part.input,
      [
        ["content"],
        ["contents"],
        ["text"],
        ["file", "content"],
        ["file", "text"],
      ],
      { allowEmpty: true },
    ) ??
    getStringFromPaths(
      output,
      [
        ["content"],
        ["contents"],
        ["text"],
        ["file", "content"],
        ["file", "text"],
      ],
      { allowEmpty: true },
    );
  const previousContent = getStringFromPaths(
    output,
    [["previousContent"], ["previous_content"], ["file", "previousContent"]],
    { allowEmpty: true },
  );
  const savedDiff = getStringFromPaths(
    output,
    [["diff"], ["patch"], ["changes", "diff"], ["file", "diff"]],
    { allowEmpty: true },
  );
  const mode =
    getStringFromPaths(part.input, [
      ["mode"],
      ["writeMode"],
      ["file", "mode"],
    ]) ??
    getStringFromPaths(output, [["mode"], ["writeMode"], ["file", "mode"]]);
  const hasOutput = output !== undefined;
  const outputMessage = formatWriteOutputMessage(output);
  const approvalId = part.approval?.id;
  const canExpand =
    hasError ||
    isApprovalRequested ||
    savedDiff !== null ||
    content !== null ||
    hasOutput;
  const previewLanguage = inferLanguage(filePath ?? filename);
  const normalizedContent =
    content !== null ? normalizeEmbeddedLineNumbers(content) : null;
  const previewCode = normalizedContent?.code ?? content ?? "";
  const previewStartLine = normalizedContent?.startingLineNumber ?? 1;
  const diffCode =
    savedDiff ??
    (previousContent !== null && content !== null && filePath
      ? buildWriteDiff({ content, filePath, mode, previousContent })
      : null);
  const displayDiffCode = diffCode ?? gitDiff;
  const displayFilename =
    filename === "file" && isRunning ? "Writing" : filename;
  const parsedDiff = useMemo(
    () =>
      !isRunning && displayDiffCode ? parseSingleDiff(displayDiffCode) : null,
    [displayDiffCode, isRunning],
  );
  const writeFileStateLabel = getWriteFileStateLabel(
    parsedDiff,
    mode,
    previousContent,
  );
  const writeDiffStats = getDiffStats(parsedDiff);
  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  useEffect(() => {
    if (
      isRunning ||
      !expanded ||
      diffCode !== null ||
      !diffProjectPath ||
      !filePath
    ) {
      return;
    }

    const relativeFilePath = toRelativeProjectPath(diffProjectPath, filePath);
    let cancelled = false;

    const loadGitDiff = async () => {
      setGitDiffLoading(true);
      setGitDiffError(null);

      try {
        const statusResponse = await fetch("/api/project-git-status", {
          body: JSON.stringify({ projectPath: diffProjectPath }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        if (!statusResponse.ok) {
          throw new Error(await readResponseText(statusResponse));
        }

        const statusPayload = (await statusResponse.json()) as {
          changes?: Array<{
            path: string;
            previousPath: string | null;
            status: string;
          }>;
        };
        const change = statusPayload.changes?.find((entry) => {
          const normalizedEntryPath = entry.path.replace(/\\/g, "/");
          const normalizedPreviousPath = entry.previousPath?.replace(
            /\\/g,
            "/",
          );
          return (
            normalizedEntryPath.toLowerCase() ===
              relativeFilePath.toLowerCase() ||
            normalizedPreviousPath?.toLowerCase() ===
              relativeFilePath.toLowerCase()
          );
        });

        if (!change) {
          throw new Error("No Git diff is available for this file.");
        }

        const diffResponse = await fetch("/api/project-git-diff", {
          body: JSON.stringify({
            filePath: change.path,
            previousPath: change.previousPath,
            projectPath: diffProjectPath,
            status: change.status,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        if (!diffResponse.ok) {
          throw new Error(await readResponseText(diffResponse));
        }

        const diffPayload = (await diffResponse.json()) as { diff?: string };
        if (!cancelled) {
          setGitDiff(diffPayload.diff?.trim() || null);
        }
      } catch (error) {
        if (!cancelled) {
          setGitDiffError(
            error instanceof Error ? error.message : "Unable to load Git diff.",
          );
        }
      } finally {
        if (!cancelled) {
          setGitDiffLoading(false);
        }
      }
    };

    void loadGitDiff();

    return () => {
      cancelled = true;
    };
  }, [diffCode, diffProjectPath, expanded, filePath, isRunning]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <div
        className={cn(
          "flex items-center gap-2",
          expanded && "w-full justify-between",
        )}
      >
        <ChipButton
          className={cn(
            getChipToneClasses(
              "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-700 dark:bg-purple-950 dark:text-purple-400",
              hasError,
            ),
            isApprovalRequested && "border-yellow-500/50 bg-yellow-500/5",
            canExpand && "cursor-pointer",
            isRunning && "animate-pulse",
          )}
          onClick={() => canExpand && setExpanded(!expanded)}
          aria-label={displayFilename}
          type="button"
        >
          <PenLineIcon className="size-3.5 shrink-0" />
          {!isRunning ? (
            <>
              <span className="max-w-48 truncate font-medium">
                {displayFilename}
              </span>
              {writeFileStateLabel ? (
                <span className={CHIP_SUBTEXT_CLASSES}>
                  {writeFileStateLabel}
                </span>
              ) : null}
              {isApprovalRequested ? (
                <span className="text-yellow-600">approval</span>
              ) : null}
              {hasError ? (
                <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
              ) : null}
            </>
          ) : null}
        </ChipButton>
        {expanded && writeDiffStats ? (
          <span className="flex shrink-0 items-center gap-1 font-medium text-xs">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{writeDiffStats.additions}
            </span>
            <span className="text-red-600 dark:text-red-400">
              -{writeDiffStats.deletions}
            </span>
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div
          className={getExpandedChipClasses(
            "text-purple-700 dark:text-purple-400",
            hasError,
          )}
          style={{ borderColor: "currentColor" }}
        >
          {/* Approval UI */}
          {approvalId && part.approval && onToolApproval ? (
            <ActionApproval
              approval={part.approval}
              onToolApproval={onToolApproval}
              state={state}
            >
              <span className="text-sm">
                Allow writing to{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  {filePath ?? "file"}
                </code>
                ?
              </span>
            </ActionApproval>
          ) : null}
          {/* Error */}
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {/* Content preview */}
          {displayDiffCode !== null && filePath ? (
            <div>
              {parsedDiff ? (
                <div className="max-h-96 overflow-auto rounded-md border bg-background text-xs">
                  <IdeDiffViewer fileDiff={parsedDiff} />
                </div>
              ) : (
                <CodeBlock
                  className="max-h-96 flex flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                  code={displayDiffCode}
                  language="diff"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={CHIP_DETAIL_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <MaterialFileIcon
                        className="size-3.5"
                        path={filePath ?? filename}
                      />
                      <CodeBlockFilename>{filename}</CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              )}
            </div>
          ) : gitDiffLoading ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
              Loading file changes…
            </p>
          ) : gitDiffError && !hasOutput ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
              {gitDiffError}
            </p>
          ) : content !== null && filePath ? (
            <div>
              <CodeBlock
                className="max-h-96 flex flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                code={previewCode}
                language={previewLanguage}
                showLineNumbers
                startingLineNumber={previewStartLine}
                style={{ contentVisibility: "visible" }}
              >
                <CodeBlockHeader className={CHIP_DETAIL_HEADER_CLASSES}>
                  <CodeBlockTitle>
                    <MaterialFileIcon
                      className="size-3.5"
                      path={filePath ?? filename}
                    />
                    <CodeBlockFilename>{filename}</CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <CodeBlockCopyButton />
                  </CodeBlockActions>
                </CodeBlockHeader>
              </CodeBlock>
            </div>
          ) : outputMessage ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
              {outputMessage}
            </p>
          ) : hasOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const renderToolOutput = (part: ToolLikePart) => {
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  if (hasError) {
    return (
      <div className="space-y-2">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Error
        </h4>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
          {part.errorText}
        </pre>
      </div>
    );
  }

  if (part.output === undefined) {
    return null;
  }

  const outputContent = <JsonBlock value={part.output} />;

  return (
    <div className="space-y-2">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Result
      </h4>
      {outputContent}
    </div>
  );
};

const ToolPartCard = ({ part }: { part: ToolLikePart }) => {
  const toolName = getToolName(part);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isCompleted = state === "output-available" || state === "output-error";

  const toolHeaderProps =
    part.type === "dynamic-tool"
      ? {
          type: "dynamic-tool" as const,
          state,
          toolName: isString(part.toolName) ? part.toolName : toolName,
        }
      : {
          type: part.type as `tool-${string}`,
          state,
        };

  return (
    <Tool defaultOpen={isCompleted}>
      <ToolHeader title={formatToolName(toolName)} {...toolHeaderProps} />
      <ToolContent>
        {isRecord(part.input) ? (
          <ToolInput input={part.input as ToolPart["input"]} />
        ) : null}
        {renderToolOutput(part)}
      </ToolContent>
    </Tool>
  );
};

export const AssistantMessagePart = ({
  part,
  isStreaming = false,
  showReasoningSummaries = true,
}: {
  part: MessagePart;
  isStreaming?: boolean;
  showReasoningSummaries?: boolean;
}) => {
  if (part.type === "text") {
    return (
      <StreamingMessageResponse isStreaming={isStreaming} text={part.text} />
    );
  }

  if (part.type === "reasoning") {
    const hasReasoningText = part.text.trim().length > 0;

    // Hide when there's no content to show — the lull indicator in
    // ChatPanel already signals "working" during streaming.
    if (!showReasoningSummaries || !hasReasoningText) {
      return null;
    }

    return (
      <Reasoning
        className="my-3 w-full"
        defaultOpen={showReasoningSummaries}
        isStreaming={isStreaming}
        hasContent={hasReasoningText}
      >
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }

  if (part.type === "file") {
    const label = part.filename ?? part.url ?? "Attached file";

    return <Badge variant="secondary">File: {label}</Badge>;
  }

  if (part.type === "source-url" || part.type === "source-document") {
    // Sources are grouped and rendered at the message level in chat-panel
    return null;
  }

  if (part.type === "step-start") {
    return null;
  }

  if (isToolLikePart(part)) {
    return <ToolPartCard part={part} />;
  }

  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">
      {stringifyPart(part)}
    </pre>
  );
};
