import { useTranslations } from "next-intl";
import { memo } from "react";
import { cn } from "@/lib/utils";
import type { ProjectConfig } from "@/types/ide";
import { areProjectsEqualExceptLastUsedAt } from "../ide-state";

export interface KanbanWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

// Placeholder scaffold: columns only, no data model yet. Headings are
// intentionally untranslated until the real board lands.
const KANBAN_COLUMNS = ["Backlog", "In progress", "Review", "Done"] as const;

const KANBAN_SURFACE_CLASSES =
  "overflow-hidden rounded-lg border border-surface-300 dark:border-surface-700 bg-background text-foreground shadow-md";

const KanbanWorkspaceComponent = ({ project }: KanbanWorkspaceProps) => {
  const t = useTranslations("workspace");

  return (
    <div
      className="flex h-full min-h-0 flex-col p-3"
      data-project-id={project.id}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
        {KANBAN_COLUMNS.map((column) => (
          <section
            className={cn(
              KANBAN_SURFACE_CLASSES,
              "flex w-72 shrink-0 flex-col",
            )}
            key={column}
          >
            <header className="border-b border-surface-300 px-3 py-2 text-sm font-medium dark:border-surface-700">
              {column}
            </header>
            <div className="flex flex-1 items-center justify-center p-3 text-center text-xs text-muted-foreground">
              {t("kanbanPlaceholder")}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export const KanbanWorkspace = memo(
  KanbanWorkspaceComponent,
  (previous, next) =>
    previous.active === next.active &&
    areProjectsEqualExceptLastUsedAt(previous.project, next.project),
);
KanbanWorkspace.displayName = "KanbanWorkspace";
