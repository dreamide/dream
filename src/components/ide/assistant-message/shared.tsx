import { parsePatchFiles } from "@pierre/diffs";
import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { motion } from "motion/react";
import {
  type ComponentProps,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { BundledLanguage } from "shiki";
import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
} from "@/components/ai-elements/confirmation";
import {
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../assistant-message-tools";
import { stringifyPart } from "../ide-state";

export { FileTree } from "@/components/ai-elements/file-tree";

export type ToolApprovalHandler = (response: {
  id: string;
  approved: boolean;
  reason?: string;
  scope?: "once" | "session";
}) => void;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string =>
  typeof value === "string";

export const ANSI_ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI control sequences in command output
  /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]|(?:[^\u001B\u009B]*)(?:\u0007))/g;

export const stripAnsiSequences = (value: string) =>
  value.replaceAll(ANSI_ESCAPE_SEQUENCE, "");

export const ActionApproval = ({
  approval,
  approveLabel = "Approve",
  children,
  className,
  onToolApproval,
  rejectLabel = "Reject",
  state,
}: {
  approval: NonNullable<ToolLikePart["approval"]>;
  approveLabel?: string;
  children: ReactNode;
  className?: string;
  onToolApproval: ToolApprovalHandler;
  rejectLabel?: string;
  state: ToolPart["state"];
}) => {
  const approvalId = approval.id;

  if (state !== "approval-requested") {
    return null;
  }

  return (
    <Confirmation
      approval={approval as Parameters<typeof Confirmation>[0]["approval"]}
      className={cn(
        "w-full max-w-full gap-3 border-emerald-500/40 bg-emerald-500/10 shadow-sm text-foreground dark:border-emerald-400/30 dark:bg-emerald-400/10",
        className,
      )}
      state={state}
    >
      <ConfirmationRequest>
        <div className="flex min-w-0 items-start text-sm">
          <TriangleAlertIcon className="mt-0.5 mr-3 size-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </ConfirmationRequest>
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
          className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
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

export const isApprovalResponseState = (state: ToolPart["state"]) =>
  state === "approval-responded" ||
  state === "output-denied" ||
  state === "output-available";

export const ApprovalStatusLabel = ({
  approval,
  state,
}: {
  approval?: ToolLikePart["approval"];
  state: ToolPart["state"];
}) => {
  if (!approval) {
    return null;
  }

  if (state === "approval-requested") {
    return null;
  }

  if (
    !isApprovalResponseState(state) ||
    typeof approval.approved !== "boolean"
  ) {
    return null;
  }

  if (approval.approved) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700 text-xs dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300">
        <CheckIcon className="size-3" />
        Approved
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 font-medium text-red-700 text-xs dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300">
      <XIcon className="size-3" />
      Rejected
    </span>
  );
};

export const unquoteCommandArgument = (value: string) => {
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

export const readShellToken = (value: string, startIndex: number) => {
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

export const getExecutableName = (value: string) =>
  value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase();

export const getCommandWithoutShellPrefix = (command: string) => {
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

export const formatToolName = (name: string): string =>
  name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

export const TOOL_STATE_LABELS: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

export const CHIP_ERROR_CLASSES =
  "border-destructive/30 bg-destructive/5 text-destructive dark:bg-destructive/10";
export const CHIP_TONE_CLASSES = {
  amber: {
    button:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400",
    expanded: "text-amber-700 dark:text-amber-400",
  },
  blue: {
    button:
      "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-400",
    expanded: "text-blue-700 dark:text-blue-400",
  },
  cyan: {
    button:
      "border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
    expanded: "text-cyan-700 dark:text-cyan-300",
  },
  green: {
    button:
      "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-400",
    expanded: "text-green-700 dark:text-green-400",
  },
  lime: {
    button:
      "border-lime-300 bg-lime-50 text-lime-700 dark:border-lime-700 dark:bg-lime-950 dark:text-lime-300",
    expanded: "text-lime-700 dark:text-lime-300",
  },
  orange: {
    button:
      "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-400",
    expanded: "text-orange-700 dark:text-orange-400",
  },
  purple: {
    button:
      "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-700 dark:bg-purple-950 dark:text-purple-400",
    expanded: "text-purple-700 dark:text-purple-400",
  },
  slate: {
    button:
      "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300",
    expanded: "text-slate-700 dark:text-slate-300",
  },
  stone: {
    button:
      "border-stone-300 bg-stone-50 text-stone-700 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300",
    expanded: "text-stone-700 dark:text-stone-300",
  },
} as const;
export type ChipTone = keyof typeof CHIP_TONE_CLASSES;
export const getChipToneClasses = (tone: ChipTone, hasError: boolean) =>
  hasError ? CHIP_ERROR_CLASSES : CHIP_TONE_CLASSES[tone].button;
export const getExpandedChipClasses = (tone: ChipTone, hasError: boolean) =>
  cn(
    "mt-2 space-y-2 border-l pl-2",
    hasError ? "text-destructive" : CHIP_TONE_CLASSES[tone].expanded,
  );
export const CHIP_DETAIL_HEADER_CLASSES =
  "shrink-0 border-0 bg-transparent px-3 py-2 text-[12px]";
export const RUN_COMMAND_HEADER_CLASSES =
  "shrink-0 border-0 bg-transparent px-3 pt-2 pb-1 text-[12px]";
export const CHIP_BUTTON_BASE_CLASSES =
  "animate-[chip-enter_0.3s_ease-out] inline-flex items-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-1 text-xs transition-colors";
export const CHIP_SUBTEXT_CLASSES = "opacity-70";
export const CHIP_ERROR_SUBTEXT_CLASSES = "text-destructive/70";
export const CHIP_LAYOUT_TRANSITION = {
  damping: 32,
  duration: 0.18,
  stiffness: 520,
  type: "spring",
} as const;

export const ChipButton = ({
  className,
  hasError = false,
  tone,
  ...props
}: ComponentProps<typeof motion.button> & {
  hasError?: boolean;
  tone?: ChipTone;
}) => (
  <motion.button
    className={cn(
      CHIP_BUTTON_BASE_CLASSES,
      tone ? getChipToneClasses(tone, hasError) : undefined,
      className,
    )}
    layout="size"
    transition={CHIP_LAYOUT_TRANSITION}
    {...props}
  />
);
export const STREAMING_WORD_INTERVAL_MS = 40;
export const STREAMING_MIN_INTERVAL_MS = 18;
export const STREAMING_BACKLOG_START_CHARS = 120;
export const STREAMING_BACKLOG_FULL_SPEED_CHARS = 900;
export const STREAMING_BACKLOG_TARGET_TICKS = 18;
export const STREAMING_MIN_CHARS_PER_TICK = 24;
export const STREAMING_MAX_CHARS_PER_TICK = 140;
export const STREAMING_FINISHED_INTERVAL_MS = 8;
export const STREAMING_FINISHED_MIN_CHARS_PER_TICK = 240;
export const STREAMING_FINISHED_MAX_CHARS_PER_TICK = 1200;

export const extToLanguage: Record<string, BundledLanguage> = {
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

export const inferLanguage = (filePath: string): BundledLanguage => {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extToLanguage[ext] ?? "log";
};

export const getNestedValue = (
  value: unknown,
  path: readonly string[],
): unknown => {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
};

export const getStringFromPaths = (
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

export const getNumberFromPaths = (
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

export const normalizeEmbeddedLineNumbers = (
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

export const getNextStreamingWordToken = (text: string) =>
  text.match(/^(\s+|\S+\s*)/)?.[0] ?? text.slice(0, 1);

export const getBacklogPressure = (remainingLength: number) => {
  if (remainingLength <= STREAMING_BACKLOG_START_CHARS) {
    return 0;
  }

  return Math.min(
    1,
    (remainingLength - STREAMING_BACKLOG_START_CHARS) /
      (STREAMING_BACKLOG_FULL_SPEED_CHARS - STREAMING_BACKLOG_START_CHARS),
  );
};

export const getNextStreamingChunkText = (
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

export const getNextStreamingFrame = (
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

export const StreamingMessageResponse = ({
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

export const buildLineDiff = (previousContent: string, nextContent: string) => {
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

const getDiffLineCount = (content: string) =>
  content.length === 0 ? 0 : content.split("\n").length;

export const buildWriteDiff = ({
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
  const previousLineCount = getDiffLineCount(previousContent);
  const nextLineCount = getDiffLineCount(nextContent);

  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -1,${previousLineCount} +1,${nextLineCount} @@`,
    buildLineDiff(previousContent, nextContent),
  ].join("\n");
};

export const parseSingleDiff = (diff: string) => {
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

export const getDiffStats = (diff: ReturnType<typeof parseSingleDiff>) => {
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

export const getWriteFileStateLabel = (
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

export const getFilePathFromOutputText = (output: unknown) => {
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

export const formatWriteOutputMessage = (output: unknown) => {
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

export const getAgentOutputText = (output: unknown): string | null => {
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

export const JsonBlock = ({ value }: { value: unknown }) => (
  <CodeBlock code={stringifyPart(value)} language="json" />
);

export interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  isFile: boolean;
}

export const buildFileTree = (
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

export const FileTreeNodeView = ({ node }: { node: FileTreeNode }) => {
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
