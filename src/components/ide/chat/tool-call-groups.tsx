import type { UIMessage } from "ai";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  type LucideIcon,
  PenLineIcon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  CHIP_BUTTON_BASE_CLASSES,
  CHIP_ENTER_ANIMATION_CLASS,
  type ChipTone,
  getChipToneClasses,
  useChipAnimate,
} from "../assistant-message/shared";
import {
  AgentChip,
  ListFilesChip,
  ReadFileChip,
  RunCommandChip,
  SearchInFilesChip,
  TaskOutputChip,
  WebFetchChip,
  WriteFileChip,
} from "../assistant-message-part";
import {
  type ChipToolKind,
  getChipToolKind,
  type ToolLikePart,
} from "../assistant-message-tools";

export type ToolApprovalResponder = (response: {
  id: string;
  approved: boolean;
  reason?: string;
  scope?: "once" | "session";
}) => void;

type ToolChipItem = {
  index: number;
  part: UIMessage["parts"][number];
};

type ToolChipRenderContext = {
  addToolApprovalResponse: ToolApprovalResponder;
  expandToolCalls: boolean;
  messageParts: UIMessage["parts"];
  messageId: string;
  projectPath: string;
};

export const getMessagePartKey = (
  messageId: string,
  part: Record<string, unknown>,
  index: number,
): string => {
  const partId =
    (typeof part.id === "string" && part.id) ||
    (typeof part.toolCallId === "string" && part.toolCallId) ||
    (typeof part.providerExecutedId === "string" && part.providerExecutedId);

  if (partId) {
    return `${messageId}-${part.type ?? "part"}-${partId}-${index}`;
  }

  return `${messageId}-${part.type ?? "part"}-${index}`;
};

const TOOL_GROUP_META: Record<
  ChipToolKind,
  {
    Icon: LucideIcon;
    label: string;
    tone: ChipTone;
  }
> = {
  agent: {
    Icon: BotIcon,
    label: "Agent",
    tone: "slate",
  },
  command: {
    Icon: TerminalIcon,
    label: "Command",
    tone: "lime",
  },
  list: {
    Icon: FolderIcon,
    label: "List",
    tone: "blue",
  },
  read: {
    Icon: EyeIcon,
    label: "Read",
    tone: "emerald",
  },
  search: {
    Icon: SearchIcon,
    label: "Search",
    tone: "blue",
  },
  taskOutput: {
    Icon: FileTextIcon,
    label: "Task output",
    tone: "amber",
  },
  toolSearch: {
    Icon: WrenchIcon,
    label: "Tool search",
    tone: "slate",
  },
  webFetch: {
    Icon: GlobeIcon,
    label: "Web fetch",
    tone: "cyan",
  },
  write: {
    Icon: PenLineIcon,
    label: "Write",
    tone: "violet",
  },
};

const renderToolChip = (
  { index, part }: ToolChipItem,
  {
    addToolApprovalResponse,
    expandToolCalls,
    messageParts,
    messageId,
    projectPath,
  }: ToolChipRenderContext,
) => {
  const key = getMessagePartKey(
    messageId,
    part as Record<string, unknown>,
    index,
  );
  const chipPart = part as ToolLikePart;
  const chipToolKind = getChipToolKind(chipPart);

  if (chipToolKind === "command") {
    return (
      <RunCommandChip
        defaultExpanded={expandToolCalls}
        key={key}
        onToolApproval={addToolApprovalResponse}
        part={chipPart}
      />
    );
  }
  if (chipToolKind === "agent") {
    return (
      <AgentChip defaultExpanded={expandToolCalls} key={key} part={chipPart} />
    );
  }
  if (chipToolKind === "read") {
    return (
      <ReadFileChip
        defaultExpanded={expandToolCalls}
        key={key}
        part={chipPart}
        projectPath={projectPath}
      />
    );
  }
  if (chipToolKind === "list") {
    return (
      <ListFilesChip
        defaultExpanded={expandToolCalls}
        key={key}
        part={chipPart}
        projectPath={projectPath}
      />
    );
  }
  if (chipToolKind === "write") {
    return (
      <WriteFileChip
        defaultExpanded={expandToolCalls}
        key={key}
        messageParts={messageParts}
        onToolApproval={addToolApprovalResponse}
        part={chipPart}
        partIndex={index}
        projectPath={projectPath}
      />
    );
  }
  if (chipToolKind === "taskOutput") {
    return (
      <TaskOutputChip
        defaultExpanded={expandToolCalls}
        key={key}
        part={chipPart}
      />
    );
  }
  if (chipToolKind === "toolSearch") {
    return (
      <SearchInFilesChip
        defaultExpanded={expandToolCalls}
        key={key}
        part={chipPart}
      />
    );
  }
  if (chipToolKind === "webFetch") {
    return (
      <WebFetchChip
        defaultExpanded={expandToolCalls}
        key={key}
        onToolApproval={addToolApprovalResponse}
        part={chipPart}
      />
    );
  }

  return (
    <SearchInFilesChip
      defaultExpanded={expandToolCalls}
      key={key}
      part={chipPart}
    />
  );
};

export const ToolChipRow = ({
  context,
  group,
}: {
  context: ToolChipRenderContext;
  group: ToolChipItem[];
}) => (
  <div className="my-1.5 flex flex-wrap items-start gap-2">
    {group.map((item) => renderToolChip(item, context))}
  </div>
);

type ToolGroupSummary =
  | {
      count: number;
      kind: ChipToolKind;
      type: "tool";
    }
  | {
      count: number;
      type: "error";
    };
type ToolSummary = Extract<ToolGroupSummary, { type: "tool" }>;
type ErrorSummary = Extract<ToolGroupSummary, { type: "error" }>;

const hasToolPartError = (part: ToolLikePart) =>
  Boolean(part.errorText) || part.state === "output-error";

const summarizeToolGroup = (group: ToolChipItem[]) => {
  const summaries: ToolGroupSummary[] = [];
  const summaryByKind = new Map<ChipToolKind, ToolSummary>();
  let errorSummary: ErrorSummary | null = null;

  for (const item of group) {
    const chipPart = item.part as ToolLikePart;
    const kind = getChipToolKind(chipPart);
    if (!kind) {
      continue;
    }

    if (hasToolPartError(chipPart)) {
      if (errorSummary) {
        errorSummary.count += 1;
        continue;
      }

      errorSummary = {
        count: 1,
        type: "error",
      };
      summaries.push(errorSummary);
      continue;
    }

    const existing = summaryByKind.get(kind);
    if (existing) {
      existing.count += 1;
      continue;
    }

    const summary: ToolSummary = {
      count: 1,
      kind,
      type: "tool",
    };
    summaryByKind.set(kind, summary);
    summaries.push(summary);
  }

  return summaries;
};

const isWebFetchOnlyGroup = (group: ToolChipItem[]) =>
  group.length > 0 &&
  group.every((item) => getChipToolKind(item.part) === "webFetch");

export const ToolCallGroup = ({
  context,
  group,
}: {
  context: ToolChipRenderContext;
  group: ToolChipItem[];
}) => {
  const [expanded, setExpanded] = useState(false);
  const animate = useChipAnimate();
  const summaries = summarizeToolGroup(group);

  if (isWebFetchOnlyGroup(group)) {
    return <ToolChipRow context={context} group={group} />;
  }

  if (summaries.length === 0) {
    return <ToolChipRow context={context} group={group} />;
  }

  return (
    <div className="my-1.5 space-y-2">
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${group.length} tool ${group.length === 1 ? "call" : "calls"}`}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-surface-400 dark:focus-visible:ring-surface-500"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {summaries.map((summary) => {
            const isErrorSummary = summary.type === "error";
            const { Icon, label, tone } = isErrorSummary
              ? {
                  Icon: TriangleAlertIcon,
                  label: "Error",
                  tone: "stone" as const,
                }
              : TOOL_GROUP_META[summary.kind];

            return (
              <span
                className={cn(
                  CHIP_BUTTON_BASE_CLASSES,
                  animate && CHIP_ENTER_ANIMATION_CLASS,
                  getChipToneClasses(tone, isErrorSummary),
                  "pointer-events-none font-mono tabular-nums",
                )}
                key={isErrorSummary ? "error" : summary.kind}
                title={`${summary.count} ${label} ${summary.count === 1 ? "call" : "calls"}`}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="font-medium">{summary.count}</span>
              </span>
            );
          })}
        </span>
        {expanded ? (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2 border-border border-l pl-2">
          <ToolChipRow context={context} group={group} />
        </div>
      ) : null}
    </div>
  );
};
