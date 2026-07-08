import { CheckIcon, ListChecks } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import type { ChatTodoItem, ChatTodoSummary } from "./todo-list";

const getTodoStateLabel = (todo: ChatTodoItem) => {
  const normalizedStatus = normalizeTodoStatus(todo.status);

  if (
    normalizedStatus === "completed" ||
    normalizedStatus === "complete" ||
    normalizedStatus === "done"
  ) {
    return "Completed";
  }

  if (
    normalizedStatus === "inprogress" ||
    normalizedStatus === "current" ||
    normalizedStatus === "active" ||
    normalizedStatus === "running"
  ) {
    return "Current";
  }

  return "Pending";
};

const normalizeTodoStatus = (status: ChatTodoItem["status"] | string) =>
  status.replace(/[\s_-]+/g, "").toLowerCase();

const TodoRow = ({ todo }: { todo: ChatTodoItem }) => {
  const normalizedStatus = normalizeTodoStatus(todo.status);
  const completed =
    normalizedStatus === "completed" ||
    normalizedStatus === "complete" ||
    normalizedStatus === "done";
  const inProgress =
    normalizedStatus === "inprogress" ||
    normalizedStatus === "current" ||
    normalizedStatus === "active" ||
    normalizedStatus === "running";
  const stateLabel = getTodoStateLabel(todo);

  return (
    <div className="flex gap-2 rounded-md px-1 py-1.5">
      {inProgress ? (
        <Spinner
          aria-label={`${stateLabel}: ${todo.text}`}
          className="mt-0.5 size-4 shrink-0 text-accent-primary"
        />
      ) : completed ? (
        <span
          aria-label={`${stateLabel}: ${todo.text}`}
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-primary bg-primary text-primary-foreground"
          role="img"
        >
          <CheckIcon className="size-3.5 stroke-[3]" />
        </span>
      ) : (
        <Checkbox
          aria-label={`${stateLabel}: ${todo.text}`}
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
    </div>
  );
};

export const TodoListPopover = ({ summary }: { summary: ChatTodoSummary }) => {
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

  if (summary.totalCount === 0) {
    return null;
  }

  const progressLabel = `${summary.currentTaskNumber} / ${summary.totalCount}`;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <PromptInputButton
            aria-label={`Tasks ${progressLabel}`}
            className="h-8 gap-1.5 px-2 font-mono text-xs tabular-nums"
            size="xs"
            title={`Tasks ${progressLabel}`}
          />
        }
      >
        <ListChecks className="size-4" />
        <span>{progressLabel}</span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 gap-3 rounded-lg bg-popover p-3"
        side="top"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 font-medium text-sm">
            <ListChecks className="size-4 shrink-0" />
            <span className="truncate">Tasks</span>
          </div>
          <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
            {progressLabel}
          </span>
        </div>
        <div
          className={cn(
            "max-h-[min(70vh,32rem)] pr-1",
            isListScrollable ? "overflow-y-auto" : "overflow-y-hidden",
          )}
          ref={handleListRef}
        >
          <div className="space-y-0.5">
            {summary.todos.map((todo) => (
              <TodoRow key={todo.id} todo={todo} />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
