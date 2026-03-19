import type { UIMessage } from "ai";
import {
  CheckIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  PenLineIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
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
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/components/ai-elements/plan";
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
import { stringifyPart } from "./ide-state";
import { useIdeStore } from "./ide-store";

type MessagePart = UIMessage["parts"][number];

type ToolLikePart = MessagePart & {
  approval?: { id: string; approved?: boolean; reason?: string };
  errorText?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  toolCallId?: string;
  toolName?: string;
};

type ToolApprovalHandler = (response: {
  id: string;
  approved: boolean;
}) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isToolLikePart = (part: MessagePart): part is ToolLikePart =>
  typeof part.type === "string" &&
  (part.type.startsWith("tool-") || part.type === "dynamic-tool");

const formatToolName = (name: string): string =>
  name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const getToolName = (part: ToolLikePart): string => {
  if (part.type === "dynamic-tool" && isString(part.toolName)) {
    return part.toolName;
  }

  return part.type.startsWith("tool-") ? part.type.slice(5) : part.type;
};

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

export const ListFilesChip = ({ part }: { part: ToolLikePart }) => {
  const [expanded, setExpanded] = useState(false);
  const output = part.output;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  const { files, count } = useMemo(() => {
    if (!isRecord(output) || !Array.isArray(output.files)) {
      return { files: null, count: 0 };
    }
    const filtered = output.files.filter(isString);
    return {
      files: filtered,
      count: typeof output.count === "number" ? output.count : filtered.length,
    };
  }, [output]);

  const { root, defaultExpanded } = useMemo(() => {
    if (!files) return { root: null, defaultExpanded: new Set<string>() };
    return buildFileTree(files);
  }, [files]);

  const hasOutput = files !== null && root !== null;
  const projectPath = useIdeStore((s) => s.getActiveProject()?.path ?? null);
  const rawDirectory =
    isRecord(part.input) && isString(part.input.directory)
      ? part.input.directory
      : null;
  const directory =
    rawDirectory === "." && projectPath ? projectPath : rawDirectory;

  const sortedChildren = useMemo(() => {
    if (!root) return [];
    return [...root.children.values()].sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [root]);

  return (
    <div className={expanded ? "mb-3 w-full" : undefined}>
      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400",
          hasError && "border-destructive/30 text-destructive",
          isRunning && "animate-pulse",
        )}
        onClick={() => hasOutput && setExpanded(!expanded)}
        type="button"
      >
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="font-medium">{directory ?? "files"}</span>
        {hasOutput ? (
          <span className="opacity-70">
            {count} {count === 1 ? "file" : "files"}
          </span>
        ) : null}
        {hasError ? <span className="text-destructive">error</span> : null}
      </button>
      {expanded && hasOutput ? (
        <FileTree className="mt-2 text-xs" defaultExpanded={defaultExpanded}>
          {sortedChildren.map((child) => (
            <FileTreeNodeView key={child.path} node={child} />
          ))}
        </FileTree>
      ) : null}
    </div>
  );
};

// ── Chip-based tool components ─────────────────────────────────────────

export const ReadFileChip = ({ part }: { part: ToolLikePart }) => {
  const [expanded, setExpanded] = useState(false);
  const output = part.output;
  const hasOutput =
    isRecord(output) && isString(output.filePath) && isString(output.content);
  const filePath = hasOutput ? (output.filePath as string) : null;
  const content = hasOutput ? (output.content as string) : null;
  const start =
    hasOutput && typeof output.startLine === "number" ? output.startLine : null;
  const end =
    hasOutput && typeof output.endLine === "number" ? output.endLine : null;
  const filename = filePath?.split(/[\\/]/).pop() ?? "file";
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  return (
    <div className={expanded ? "mb-3 w-full" : undefined}>
      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-400",
          hasError && "border-destructive/30 text-destructive",
          isRunning && "animate-pulse",
        )}
        onClick={() => hasOutput && setExpanded(!expanded)}
        type="button"
      >
        <EyeIcon className="size-3.5 shrink-0" />
        <span className="max-w-48 truncate font-medium">{filename}</span>
        {hasError ? <span className="text-destructive">error</span> : null}
      </button>
      {expanded && content && filePath ? (
        <div className="mt-2">
          <CodeBlock
            className="max-h-96 flex flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
            code={content}
            language={inferLanguage(filePath)}
            showLineNumbers
            style={{ contentVisibility: "visible" }}
          >
            <CodeBlockHeader className="shrink-0">
              <CodeBlockTitle>
                <FileIcon size={14} />
                <CodeBlockFilename>{filename}</CodeBlockFilename>
                {start && end ? (
                  <Badge variant="secondary" className="ml-1 text-[10px]">
                    Lines {start}-{end}
                  </Badge>
                ) : null}
              </CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        </div>
      ) : null}
    </div>
  );
};

export const SearchInFilesChip = ({ part }: { part: ToolLikePart }) => {
  const [expanded, setExpanded] = useState(false);
  const output = part.output;
  const hasOutput = isRecord(output) && Array.isArray(output.matches);
  const matches = hasOutput
    ? (output.matches as Record<string, unknown>[]).filter(isRecord)
    : [];
  const count = hasOutput
    ? typeof output.count === "number"
      ? output.count
      : matches.length
    : 0;
  const query =
    isRecord(part.input) && isString(part.input.query)
      ? part.input.query
      : null;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  return (
    <div className={expanded ? "mb-3 w-full" : undefined}>
      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-400",
          hasError && "border-destructive/30 text-destructive",
          isRunning && "animate-pulse",
        )}
        onClick={() => hasOutput && setExpanded(!expanded)}
        type="button"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        {query ? (
          <span className="max-w-48 truncate font-medium">
            &ldquo;{query}&rdquo;
          </span>
        ) : (
          <span className="font-medium">Search</span>
        )}
        {hasOutput && count > 0 ? (
          <span className="opacity-70">
            {count} {count === 1 ? "match" : "matches"}
          </span>
        ) : null}
        {hasError ? <span className="text-destructive">error</span> : null}
      </button>
      {expanded && hasOutput ? (
        <div className="mt-2 max-h-80 space-y-1 overflow-auto rounded-md border bg-muted/30 p-2">
          {matches.length === 0 ? (
            <p className="text-muted-foreground text-sm">No matches found.</p>
          ) : (
            matches.map((match) => {
              const file = isString(match.file) ? match.file : "unknown";
              const line = typeof match.line === "number" ? match.line : "?";
              const text = isString(match.text) ? match.text : "";
              const key = `${file}:${line}:${text}`;

              return (
                <div
                  className="rounded-sm px-2 py-1.5 hover:bg-muted/40"
                  key={key}
                >
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {file}:{line}
                  </p>
                  <p className="font-mono text-xs">{text || "(empty line)"}</p>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
};

/** Check if a tool part should render as an inline chip */
export const isChipToolPart = (part: MessagePart): boolean => {
  if (!isToolLikePart(part)) return false;
  const toolName = getToolName(part);
  return (
    toolName === "readFile" ||
    toolName === "searchInFiles" ||
    toolName === "listFiles" ||
    toolName === "writeFile"
  );
};

export const WriteFileChip = ({
  part,
  onToolApproval,
}: {
  part: ToolLikePart;
  onToolApproval?: ToolApprovalHandler;
}) => {
  const [expanded, setExpanded] = useState(false);
  const output = part.output;
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";

  const filePath =
    isRecord(part.input) && isString(part.input.filePath)
      ? part.input.filePath
      : isRecord(output) && isString(output.filePath)
        ? output.filePath
        : null;
  const filename = filePath?.split(/[\\/]/).pop() ?? "file";
  const content =
    isRecord(part.input) && isString(part.input.content)
      ? part.input.content
      : isRecord(output) && isString(output.content)
        ? output.content
        : null;
  const mode =
    isRecord(part.input) && isString(part.input.mode)
      ? part.input.mode
      : isRecord(output) && isString(output.mode)
        ? output.mode
        : null;
  const bytesWritten =
    isRecord(output) && typeof output.bytesWritten === "number"
      ? output.bytesWritten
      : null;
  const hasOutput = isRecord(output) && isString(output.status);
  const approvalId = part.approval?.id;

  return (
    <div className={expanded ? "mb-3 w-full" : undefined}>
      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-700 dark:bg-purple-950 dark:text-purple-400",
          hasError && "border-destructive/30 text-destructive",
          isApprovalRequested && "border-yellow-500/50 bg-yellow-500/5",
          isRunning && "animate-pulse",
        )}
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <PenLineIcon className="size-3.5 shrink-0" />
        <span className="max-w-48 truncate font-medium">{filename}</span>
        {mode === "append" ? <span className="opacity-70">append</span> : null}
        {bytesWritten !== null ? (
          <span className="opacity-70">
            {bytesWritten.toLocaleString()} bytes
          </span>
        ) : null}
        {isApprovalRequested ? (
          <span className="text-yellow-600">approval</span>
        ) : null}
        {hasError ? <span className="text-destructive">error</span> : null}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2">
          {/* Approval UI */}
          {approvalId && part.approval && onToolApproval ? (
            <Confirmation
              approval={
                part.approval as Parameters<typeof Confirmation>[0]["approval"]
              }
              state={state}
            >
              <ConfirmationRequest>
                <span className="text-sm">
                  Allow writing to{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    {filePath ?? "file"}
                  </code>
                  ?
                </span>
              </ConfirmationRequest>
              <ConfirmationAccepted>
                <span className="flex items-center gap-1.5 text-sm text-green-700">
                  <CheckIcon className="size-4" />
                  Approved
                </span>
              </ConfirmationAccepted>
              <ConfirmationRejected>
                <span className="flex items-center gap-1.5 text-sm text-red-700">
                  <XIcon className="size-4" />
                  Rejected
                </span>
              </ConfirmationRejected>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() =>
                    onToolApproval({
                      id: approvalId,
                      approved: false,
                    })
                  }
                >
                  Reject
                </ConfirmationAction>
                <ConfirmationAction
                  variant="default"
                  onClick={() =>
                    onToolApproval({
                      id: approvalId,
                      approved: true,
                    })
                  }
                >
                  Approve
                </ConfirmationAction>
              </ConfirmationActions>
            </Confirmation>
          ) : null}
          {/* Error */}
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {/* Content preview */}
          {content && filePath ? (
            <div>
              <CodeBlock
                className="max-h-96 flex flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                code={content}
                language={inferLanguage(filePath)}
                showLineNumbers
                style={{ contentVisibility: "visible" }}
              >
                <CodeBlockHeader className="shrink-0">
                  <CodeBlockTitle>
                    <FileIcon size={14} />
                    <CodeBlockFilename>{filename}</CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <CodeBlockCopyButton />
                  </CodeBlockActions>
                </CodeBlockHeader>
              </CodeBlock>
            </div>
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

const extractPlanTitle = (
  text: string,
): { title: string; description: string } => {
  const lines = text.split("\n");
  const firstLine = lines[0]?.trim() ?? "";

  // Extract title from markdown heading
  const headingMatch = firstLine.match(/^#{1,3}\s+(.+)/);
  if (headingMatch) {
    const remaining = lines.slice(1).join("\n").trim();
    // Extract description from first non-empty paragraph
    const descLines = remaining.split("\n");
    const description =
      descLines.find((l) => l.trim().length > 0)?.trim() ?? "";
    return { title: headingMatch[1], description };
  }

  return { title: "Execution Plan", description: firstLine };
};

export const AssistantMessagePart = ({
  part,
  chatMode,
  isStreaming = false,
}: {
  part: MessagePart;
  chatMode?: string;
  isStreaming?: boolean;
}) => {
  if (part.type === "text") {
    if (chatMode === "plan" && part.text.trim().length > 0) {
      const { title, description } = extractPlanTitle(part.text);
      return (
        <Plan isStreaming={isStreaming} defaultOpen>
          <PlanHeader>
            <div>
              <PlanTitle>{title}</PlanTitle>
              {description ? (
                <PlanDescription>{description}</PlanDescription>
              ) : null}
            </div>
            <PlanAction>
              <PlanTrigger />
            </PlanAction>
          </PlanHeader>
          <PlanContent>
            <MessageResponse>{part.text}</MessageResponse>
          </PlanContent>
        </Plan>
      );
    }
    return <MessageResponse>{part.text}</MessageResponse>;
  }

  if (part.type === "reasoning") {
    const hasReasoningText = part.text.trim().length > 0;

    if (!hasReasoningText && !isStreaming) {
      // No reasoning text available (e.g. OpenAI o-series models hide chain-of-thought)
      // Hide empty thinking blocks entirely — they provide no useful info
      return null;
    }

    return (
      <Reasoning
        className="mb-0 w-full"
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
