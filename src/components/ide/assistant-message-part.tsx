import type { UIMessage } from "ai";
import {
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  Wrench,
  XCircle,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { stringifyPart } from "./ide-state";

type MessagePart = UIMessage["parts"][number];

type ToolLikePart = MessagePart & {
  errorText?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  toolCallId?: string;
  toolName?: string;
};

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

const ToolStatusBadge = ({ state }: { state?: string }) => {
  const currentState = state ?? "input-streaming";

  const statusMap: Record<
    string,
    {
      icon: React.ComponentType<{ className?: string }>;
      label: string;
      tone: string;
    }
  > = {
    "approval-requested": {
      icon: Clock3,
      label: "Awaiting Approval",
      tone: "text-amber-700",
    },
    "approval-responded": {
      icon: CheckCircle2,
      label: "Approval Received",
      tone: "text-blue-700",
    },
    "input-available": {
      icon: Clock3,
      label: "Running",
      tone: "text-foreground",
    },
    "input-streaming": {
      icon: Circle,
      label: "Pending",
      tone: "text-muted-foreground",
    },
    "output-available": {
      icon: CheckCircle2,
      label: "Completed",
      tone: "text-emerald-700",
    },
    "output-denied": {
      icon: XCircle,
      label: "Denied",
      tone: "text-orange-700",
    },
    "output-error": {
      icon: XCircle,
      label: "Error",
      tone: "text-destructive",
    },
  };

  const status = statusMap[currentState] ?? {
    icon: Circle,
    label: currentState,
    tone: "text-muted-foreground",
  };

  const Icon = status.icon;

  return (
    <Badge
      className={cn("gap-1.5 rounded-full", status.tone)}
      variant="secondary"
    >
      <Icon className="size-3.5" />
      {status.label}
    </Badge>
  );
};

const JsonBlock = ({ value }: { value: unknown }) => (
  <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs">
    {stringifyPart(value)}
  </pre>
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
                className="truncate rounded-sm px-2 py-1 font-mono text-xs hover:bg-muted/40"
                key={file}
                title={file}
              >
                {file}
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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{output.filePath}</Badge>
        {start && end ? (
          <Badge variant="secondary">
            Lines {start}-{end}
          </Badge>
        ) : null}
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs">
        {output.content}
      </pre>
    </div>
  );
};

const renderWriteFileOutput = (output: unknown) => {
  if (!isRecord(output)) {
    return <JsonBlock value={output} />;
  }

  const filePath = isString(output.filePath) ? output.filePath : null;
  const mode = isString(output.mode) ? output.mode : null;
  const bytesWritten =
    typeof output.bytesWritten === "number" ? output.bytesWritten : null;
  const status = isString(output.status) ? output.status : null;

  if (!filePath && mode === null && bytesWritten === null && status === null) {
    return <JsonBlock value={output} />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status ? <Badge variant="secondary">Status: {status}</Badge> : null}
      {filePath ? <Badge variant="outline">{filePath}</Badge> : null}
      {mode ? <Badge variant="secondary">Mode: {mode}</Badge> : null}
      {bytesWritten !== null ? (
        <Badge variant="secondary">{bytesWritten.toLocaleString()} bytes</Badge>
      ) : null}
    </div>
  );
};

const ToolPartCard = ({ part }: { part: ToolLikePart }) => {
  const toolName = getToolName(part);
  const output = part.output;
  const input = part.input;
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  const renderOutput = () => {
    if (hasError) {
      return (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
          {part.errorText}
        </pre>
      );
    }

    switch (toolName) {
      case "listFiles":
        return renderListFilesOutput(output);
      case "readFile":
        return renderReadFileOutput(output);
      case "writeFile":
        return renderWriteFileOutput(output);
      case "searchInFiles":
        return renderSearchInFilesOutput(output);
      default:
        return <JsonBlock value={output} />;
    }
  };

  return (
    <section className="w-full overflow-hidden rounded-md border bg-muted/15">
      <header className="flex items-center justify-between gap-2 border-b bg-background/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Wrench className="size-4 shrink-0 text-muted-foreground" />
          <p className="truncate font-medium text-sm">
            {formatToolName(toolName)}
          </p>
        </div>
        <ToolStatusBadge state={part.state} />
      </header>

      <div className="space-y-3 p-3">
        {isRecord(input) ? (
          <div className="space-y-1.5">
            <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Input
            </p>
            <JsonBlock value={input} />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {hasError ? "Error" : "Output"}
          </p>
          {renderOutput()}
        </div>

        {isString(part.toolCallId) ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Call ID: {part.toolCallId}
          </p>
        ) : null}
      </div>
    </section>
  );
};

export const AssistantMessagePart = ({ part }: { part: MessagePart }) => {
  if (part.type === "text") {
    return <MessageResponse>{part.text}</MessageResponse>;
  }

  if (part.type === "reasoning") {
    return (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">
        {part.text}
      </pre>
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
    return <ToolPartCard part={part} />;
  }

  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">
      {stringifyPart(part)}
    </pre>
  );
};
