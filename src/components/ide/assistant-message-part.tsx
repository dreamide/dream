import type { UIMessage } from "ai";
import { CheckIcon, ExternalLink, FileIcon, XIcon } from "lucide-react";
import { useState } from "react";
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

const renderListFilesOutput = (output: unknown) => {
  if (!isRecord(output) || !Array.isArray(output.files)) {
    return <JsonBlock value={output} />;
  }

  const files = output.files.filter(isString);
  const count = typeof output.count === "number" ? output.count : files.length;

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">{count} file(s) returned</p>
      <div className="max-h-72 overflow-auto rounded-md bg-muted/30 p-2">
        {files.length === 0 ? (
          <p className="text-muted-foreground text-sm">No files found.</p>
        ) : (
          <ul className="space-y-1">
            {files.map((file) => (
              <li
                className="rounded-sm px-2 py-1 font-mono text-xs hover:bg-muted/40"
                key={file}
                title={file}
              >
                <span className="block truncate">{file}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const renderSearchInFilesOutput = (output: unknown) => {
  if (!isRecord(output) || !Array.isArray(output.matches)) {
    return <JsonBlock value={output} />;
  }

  const matches = output.matches.filter(isRecord);
  const count =
    typeof output.count === "number" ? output.count : matches.length;

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">{count} match(es)</p>
      <div className="max-h-80 space-y-1 overflow-auto rounded-md bg-muted/30 p-2">
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
    </div>
  );
};

const renderReadFileOutput = (output: unknown) => {
  if (
    !isRecord(output) ||
    !isString(output.filePath) ||
    !isString(output.content)
  ) {
    return <JsonBlock value={output} />;
  }

  const start = typeof output.startLine === "number" ? output.startLine : null;
  const end = typeof output.endLine === "number" ? output.endLine : null;
  const language = inferLanguage(output.filePath);
  const filename = output.filePath.split(/[\\/]/).pop() ?? output.filePath;

  return (
    <div className="max-h-96 overflow-auto">
      <CodeBlock code={output.content} language={language} showLineNumbers>
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
  );
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
        return renderListFilesOutput(part.output);
      case "readFile":
        return renderReadFileOutput(part.output);
      case "writeFile":
        return <WriteFileOutput output={part.output} />;
      case "searchInFiles":
        return renderSearchInFilesOutput(part.output);
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

export const AssistantMessagePart = ({
  part,
  isStreaming = false,
  onToolApproval,
}: {
  part: MessagePart;
  isStreaming?: boolean;
  onToolApproval?: ToolApprovalHandler;
}) => {
  if (part.type === "text") {
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

  if (part.type === "source-url") {
    return (
      <a
        className="inline-flex items-center gap-1.5 text-primary text-sm underline underline-offset-4"
        href={part.url}
        rel="noreferrer"
        target="_blank"
      >
        Source
        <ExternalLink className="size-3.5" />
      </a>
    );
  }

  if (part.type === "source-document") {
    return (
      <Badge variant="outline">
        Source: {part.title ?? part.filename ?? "Document"}
      </Badge>
    );
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
