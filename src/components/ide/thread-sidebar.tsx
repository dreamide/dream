import { MessageSquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ProjectConfig } from "@/types/ide";
import { useIdeStore } from "./ide-store";

export const ThreadSidebar = ({ project }: { project: ProjectConfig }) => {
  const threads = useIdeStore((s) => s.getThreadsForProject(project.id));
  const activeThreadId =
    useIdeStore((s) => s.activeThreadIdByProject[project.id]) ?? null;
  const addThread = useIdeStore((s) => s.addThread);
  const closeThread = useIdeStore((s) => s.closeThread);
  const setActiveThreadId = useIdeStore((s) => s.setActiveThreadId);

  return (
    <div className="flex h-full min-h-0 w-[240px] shrink-0 flex-col border-r border-border/60">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">Threads</p>
          <p className="truncate text-muted-foreground text-xs">
            {project.name}
          </p>
        </div>
        <Button
          aria-label="New thread"
          className="h-8 w-8 rounded-md"
          onClick={() => addThread(project.id)}
          size="icon-sm"
          title="New thread"
          variant="ghost"
        >
          <MessageSquarePlus className="size-4" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
        <div className="space-y-1">
          {threads.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-muted-foreground text-xs">
              Create a thread to keep separate conversations for this project.
            </div>
          ) : (
            threads.map((thread) => {
              const isActive = thread.id === activeThreadId;

              return (
                <div
                  className={cn(
                    "group relative rounded-md transition-colors",
                    isActive ? "bg-muted" : "hover:bg-muted/30",
                  )}
                  key={thread.id}
                >
                  <button
                    className="w-full rounded-[inherit] px-3 py-2 text-left"
                    onClick={() => setActiveThreadId(project.id, thread.id)}
                    type="button"
                  >
                    <div className="min-w-0 pr-7">
                      <p className="truncate font-medium text-sm">
                        {thread.title}
                      </p>
                      <p
                        className={cn(
                          "truncate text-xs",
                          isActive
                            ? "text-foreground/70"
                            : "text-muted-foreground",
                        )}
                      >
                        {thread.provider} · {thread.model || "No model"}
                      </p>
                    </div>
                  </button>
                  <button
                    aria-label={`Close ${thread.title}`}
                    className="absolute top-2 right-2 rounded p-0.5 opacity-30 transition-opacity hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeThread(thread.id);
                    }}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
