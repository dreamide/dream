import type { UIMessage } from "ai";
import {
  CheckIcon,
  FileIcon,
  FileTextIcon,
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

      current = current.children.get(part)!;
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

const ListFilesOutput = ({ output }: { output: unknown }) => {
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

  if (!files || !root) {
    return <JsonBlock value={output} />;
  }

  if (files.length === 0) {
    return <p className="text-muted-foreground text-sm">No files found.</p>;
  }

  const sortedChildren = [...root.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">{count} file(s) returned</p>
      <div className="max-h-72 overflow-auto">
        <FileTree className="text-xs" defaultExpanded={defaultExpanded}>
          {sortedChildren.map((child) => (
            <FileTreeNodeView key={child.path} node={child} />
          ))}
        </FileTree>
      </div>
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
  const lineRange = start && end ? `L${start}-${end}` : null;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  return (
    <div className={expanded ? "w-full" : undefined}>
      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          expanded
            ? "border-primary/30 bg-primary/5 text-foreground"
            : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          hasError && "border-destructive/30 text-destructive",
          isRunning && "animate-pulse",
        )}
        onClick={() => hasOutput && setExpanded(!expanded)}
        type="button"
      >
        <FileTextIcon className="size-3.5 shrink-0" />
        <span className="max-w-48 truncate font-medium">{filename}</span>
        {lineRange ? (
          <span className="text-muted-foreground">{lineRange}</span>
        ) : null}
        {hasError ? <span className="text-destructive">error</span> : null}
      </button>
      {expanded && content && filePath ? (
        <div className="mt-2 max-h-96 overflow-auto rounded-md border">
          <CodeBlock
            code={content}
            language={inferLanguage(filePath)}
            showLineNumbers
          >
            <CodeBlockHeader>
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
    <div className={expanded ? "w-full" : undefined}>
      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          expanded
            ? "border-primary/30 bg-primary/5 text-foreground"
            : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
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
        {hasOutput ? (
          <span className="text-muted-foreground">
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
  return toolName === "readFile" || toolName === "searchInFiles";
};

const WriteFileOutput = ({ output }: { output: unknown }) => {
  const [showContent, setShowContent] = useState(false);

  if (!isRecord(output)) {
    return <JsonBlock value={output} />;
  }

  const filePath = isString(output.filePath) ? output.filePath : null;
  const mode = isString(output.mode) ? output.mode : null;
  const bytesWritten =
    typeof output.bytesWritten === "number" ? output.bytesWritten : null;
  const status = isString(output.status) ? output.status : null;
  const content = isString(output.content) ? output.content : null;
  const previousContent = isString(output.previousContent)
    ? output.previousContent
    : null;
  const isNewFile = previousContent === null && content !== null;

  if (!filePath && mode === null && bytesWritten === null && status === null) {
    return <JsonBlock value={output} />;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {status ? <Badge variant="secondary">Status: {status}</Badge> : null}
        {filePath ? <Badge variant="outline">{filePath}</Badge> : null}
        {mode ? <Badge variant="secondary">Mode: {mode}</Badge> : null}
        {bytesWritten !== null ? (
          <Badge variant="secondary">
            {bytesWritten.toLocaleString()} bytes
          </Badge>
        ) : null}
        {isNewFile ? <Badge variant="secondary">New file</Badge> : null}
        {content ? (
          <button
            className="text-muted-foreground text-xs underline hover:text-foreground"
            onClick={() => setShowContent(!showContent)}
            type="button"
          >
            {showContent ? "Hide content" : "Show content"}
          </button>
        ) : null}
      </div>
      {showContent && content ? (
        <div className="max-h-96 overflow-auto">
          <CodeBlock
            code={content}
            language={filePath ? inferLanguage(filePath) : "log"}
            showLineNumbers
          >
            <CodeBlockHeader>
              <CodeBlockTitle>
                <FileIcon size={14} />
                <CodeBlockFilename>
                  {filePath?.split(/[\\/]/).pop() ?? "output"}
                </CodeBlockFilename>
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

const renderToolOutput = (part: ToolLikePart) => {
  const toolName = getToolName(part);
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

  const outputContent = (() => {
    switch (toolName) {
      case "listFiles":
        return <ListFilesOutput output={part.output} />;
      case "writeFile":
        return <WriteFileOutput output={part.output} />;
      default:
        return <JsonBlock value={part.output} />;
    }
  })();

  return (
    <div className="space-y-2">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Result
      </h4>
      {outputContent}
    </div>
  );
};

const ToolPartCard = ({
  part,
  onToolApproval,
}: {
  part: ToolLikePart;
  onToolApproval?: ToolApprovalHandler;
}) => {
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
    <Tool defaultOpen={isCompleted || state === "approval-requested"}>
      <ToolHeader title={formatToolName(toolName)} {...toolHeaderProps} />
      <ToolContent>
        {isRecord(part.input) ? (
          <ToolInput input={part.input as ToolPart["input"]} />
        ) : null}
        {part.approval && onToolApproval ? (
          <Confirmation
            approval={
              part.approval as Parameters<typeof Confirmation>[0]["approval"]
            }
            state={state}
          >
            <ConfirmationRequest>
              <span className="text-sm">
                Allow <strong>{formatToolName(toolName)}</strong> to modify{" "}
                {isRecord(part.input) && isString(part.input.filePath) ? (
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    {part.input.filePath}
                  </code>
                ) : (
                  "a file"
                )}
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
                    id: part.approval!.id,
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
                    id: part.approval!.id,
                    approved: true,
                  })
                }
              >
                Approve
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
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
  onToolApproval,
}: {
  part: MessagePart;
  chatMode?: string;
  isStreaming?: boolean;
  onToolApproval?: ToolApprovalHandler;
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
    return (
      <Reasoning className="w-full" isStreaming={isStreaming}>
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
    return <ToolPartCard onToolApproval={onToolApproval} part={part} />;
  }

  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">
      {stringifyPart(part)}
    </pre>
  );
};
