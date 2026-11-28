import { CheckIcon, CircleAlert, ListChecks } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { chatQueues, useIdeStore } from "../ide-store";
import type { ChatTodoItem, ChatTodoSummary } from "./todo-list";

const statusLabels = {
  pending: "chat.taskPending",
  inProgress: "chat.taskCurrent",
  completed: "chat.taskCompleted",
  queued: "chat.queueStatus.queued",
  running: "chat.queueStatus.running",
  waiting: "chat.queueStatus.waiting",
  failed: "chat.queueStatus.failed",
  interrupted: "chat.queueStatus.interrupted",
  cancelled: "assistant.orchestration.cancelled",
} as const satisfies Record<ChatTodoItem["status"], string>;

const TodoRow = ({ todo }: { todo: ChatTodoItem }) => {
  const t = useTranslations();
  const completed = todo.status === "completed";
  const inProgress = todo.status === "inProgress" || todo.status === "running";
  const stopped =
    todo.status === "failed" ||
    todo.status === "interrupted" ||
    todo.status === "cancelled";
  const stateLabel = t(statusLabels[todo.status]);
  const taskLabel = t("chat.taskStateLabel", {
    state: stateLabel,
    task: todo.text,
  });

  return (
    <div className="flex gap-2 rounded-md px-1 py-1.5">
      {inProgress ? (
        <Spinner
          aria-label={taskLabel}
          className="mt-0.5 size-4 shrink-0 text-accent-primary"
        />
      ) : completed ? (
        <span
          aria-label={taskLabel}
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-surface-900 bg-surface-900 text-surface-50 dark:border-surface-200 dark:bg-surface-200 dark:text-surface-900"
          role="img"
        >
          <CheckIcon className="size-3.5 stroke-[3]" />
        </span>
      ) : stopped ? (
        <CircleAlert
          aria-label={taskLabel}
          role="img"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <Checkbox
          aria-label={taskLabel}
          checked={false}
          className="pointer-events-none mt-0.5 data-checked:border-accent-primary data-checked:bg-accent-primary data-checked:text-white dark:data-checked:bg-accent-primary"
          tabIndex={-1}
        />
      )}
      <div className="min-w-0 flex-1">
        {inProgress ? (
          <Shimmer
            as="span"
            className="inline break-words font-medium text-xs leading-snug"
            duration={1.8}
          >
            {todo.text}
          </Shimmer>
        ) : (
          <div
            className={cn(
              "break-words text-xs leading-snug",
              completed ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {todo.text}
          </div>
        )}
        {todo.description ? (
          <div
            className={cn(
              "mt-1 break-words text-[11px] leading-snug",
              completed
                ? "text-surface-400 dark:text-surface-600"
                : "text-muted-foreground",
            )}
          >
            {todo.description}
          </div>
        ) : null}
      </div>
      {!todo.delegated &&
      (stopped || todo.status === "waiting" || todo.status === "queued") ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {stateLabel}
        </span>
      ) : null}
    </div>
  );
};

function DelegatedTodoRow({
  todo,
  number,
}: {
  todo: ChatTodoItem;
  number: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const child = useIdeStore((s) => s.chats.find((chat) => chat.id === todo.id));
  const projectPath = useIdeStore(
    (s) => s.projects.find((project) => project.id === child?.projectId)?.path,
  );
  const run = useStore(chatQueues.views, (views) =>
    views.get(todo.id)?.queue?.runs.find((r) => r.id === todo.id),
  );
  const needsDetails =
    !todo.text ||
    !todo.description ||
    (todo.status === "failed" && !todo.error);
  const childId = child?.id;
  useEffect(() => {
    // Older hosts only return IDs and statuses in a poll. Read the original
    // assignment when its row is opened, even if the launch has been paged out.
    if (needsDetails && childId && !run) void chatQueues.refresh(childId);
  }, [needsDetails, childId, run]);

  const assignment = (run?.text || todo.text || child?.title || "")
    .replace(/^Task: /, "")
    .trim();
  const prefix = `In ${projectPath}, `;
  const instruction =
    projectPath && assignment.startsWith(prefix)
      ? assignment.slice(prefix.length)
      : assignment;
  const firstLine = instruction.split("\n", 1)[0];
  const subject = new Intl.Segmenter(locale, { granularity: "sentence" })
    .segment(firstLine)
    .containing(0)
    ?.segment.trim();
  const title =
    subject && subject !== todo.id
      ? subject
      : `${t("assistant.agent")} ${number}`;
  const model = run?.model || todo.description || child?.model;
  const modelLabel = useIdeStore((s) =>
    child
      ? (s.providerModels[child.provider].models.find(
          (entry) => entry.id === model,
        )?.label ?? model)
      : model,
  );
  const detail = [modelLabel, t(statusLabels[todo.status])]
    .filter(Boolean)
    .join(" · ");
  const error =
    todo.status === "failed" || todo.status === "interrupted"
      ? (todo.error || run?.error)?.split("\n", 1)[0]
      : null;
  return (
    <div title={instruction || undefined}>
      <TodoRow todo={{ ...todo, text: title, description: detail }} />
      {error ? (
        <p className="ml-7 break-words text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

const TodoListContent = ({ summary }: { summary: ChatTodoSummary }) => {
  const chatT = useTranslations("chat");
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [isListScrollable, setIsListScrollable] = useState(false);
  const handleListRef = useCallback((element: HTMLDivElement | null) => {
    setListElement(element);
  }, []);

  useEffect(() => {
    if (!listElement) {
      setIsListScrollable(false);
      return;
    }

    const updateScrollableState = () => {
      setIsListScrollable(
        listElement.scrollHeight > listElement.clientHeight + 1,
      );
    };

    updateScrollableState();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateScrollableState);
      return () => window.removeEventListener("resize", updateScrollableState);
    }

    const resizeObserver = new ResizeObserver(updateScrollableState);
    resizeObserver.observe(listElement);
    if (listElement.firstElementChild) {
      resizeObserver.observe(listElement.firstElementChild);
    }
    window.addEventListener("resize", updateScrollableState);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateScrollableState);
    };
  }, [listElement]);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2 font-medium text-sm">
        <ListChecks className="size-4 shrink-0" />
        <span className="truncate">{chatT("tasks")}</span>
      </div>
      <div
        className={cn(
          "min-h-0 max-h-[min(56vh,34rem)] pr-1",
          isListScrollable ? "overflow-y-auto" : "overflow-y-hidden",
        )}
        ref={handleListRef}
      >
        <div className="space-y-0.5">
          {summary.todos.map((todo, index) =>
            todo.delegated ? (
              <DelegatedTodoRow key={todo.id} todo={todo} number={index + 1} />
            ) : (
              <TodoRow key={todo.id} todo={todo} />
            ),
          )}
        </div>
      </div>
    </div>
  );
};

export const TodoListPopover = ({
  isOpen,
  onOpenChange,
  panelId,
  summary,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  panelId: string;
  summary: ChatTodoSummary;
}) => {
  const chatT = useTranslations("chat");
  if (summary.totalCount === 0) {
    return null;
  }

  const progressLabel = `${summary.currentTaskNumber} / ${summary.totalCount}`;

  return (
    <Popover onOpenChange={onOpenChange} open={isOpen}>
      <PopoverTrigger
        render={
          <PromptInputButton
            aria-controls={panelId}
            aria-label={chatT("tasksProgress", { progress: progressLabel })}
            className="h-8 gap-1.5 px-2 font-mono text-xs tabular-nums aria-expanded:bg-accent aria-expanded:text-foreground"
            size="xs"
            title={chatT("tasksProgress", { progress: progressLabel })}
          />
        }
      >
        <ListChecks className="size-4" />
        <span>{progressLabel}</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="z-[60] w-96 max-w-[calc(100vw-1rem)] gap-0 rounded-lg bg-popover p-3"
        id={panelId}
        side="top"
      >
        <TodoListContent summary={summary} />
      </PopoverContent>
    </Popover>
  );
};
