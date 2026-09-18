import { FilePlus2, History, LayoutTemplate, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentGraphSummary, GraphRun } from "@/types/agent-graphs";
import { WorkspaceNavButton } from "../../workspace/nav-button";
import { WorkspaceNavRail } from "../../workspace/side-nav";

export interface GraphSidebarProps {
  graphs: AgentGraphSummary[];
  creating: boolean;
  loading: boolean;
  historyOpen: boolean;
  onToggleHistory: () => void;
  runs: GraphRun[];
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onCreateBlank: () => void;
  onCreateFromTemplate: () => void;
  onDelete: (graphId: string) => void;
  onSelect: (graphId: string) => void;
  selectedGraphId: string | null;
}

export const GraphSidebar = ({
  graphs,
  creating,
  loading,
  historyOpen,
  onToggleHistory,
  runs,
  selectedRunId,
  onSelectRun,
  onCreateBlank,
  onCreateFromTemplate,
  onDelete,
  onSelect,
  selectedGraphId,
}: GraphSidebarProps) => {
  const t = useTranslations("graphs");
  return (
    <>
      <WorkspaceNavRail>
        <WorkspaceNavButton
          active={historyOpen}
          aria-expanded={historyOpen}
          onClick={onToggleHistory}
          title={t("runHistory")}
        >
          <History className="size-4" />
        </WorkspaceNavButton>
        <WorkspaceNavButton
          disabled={creating}
          onClick={onCreateBlank}
          title={t("newGraph")}
        >
          <FilePlus2 className="size-4" />
        </WorkspaceNavButton>
        <WorkspaceNavButton
          disabled={creating}
          onClick={onCreateFromTemplate}
          title={t("newFromTemplate")}
        >
          <LayoutTemplate className="size-4" />
        </WorkspaceNavButton>
      </WorkspaceNavRail>
      <div className="flex h-full min-h-0 w-56 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-3 py-3 text-xs font-medium text-muted-foreground">
          {t("title")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {graphs.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {loading ? t("loading") : t("emptyGraphs")}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {graphs.map((graph) => (
                <li className="group relative" key={graph.id}>
                  <Button
                    aria-pressed={graph.id === selectedGraphId}
                    className={cn(
                      "w-full justify-start pr-8 text-left font-normal",
                      graph.id === selectedGraphId && "bg-muted font-medium",
                    )}
                    onClick={() => onSelect(graph.id)}
                    title={graph.description || graph.name}
                    size="sm"
                    variant="ghost"
                  >
                    <span className="truncate">{graph.name}</span>
                  </Button>
                  <Button
                    aria-label={t("deleteGraph")}
                    className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => onDelete(graph.id)}
                    size="icon-xs"
                    title={t("deleteGraph")}
                    variant="ghost"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {historyOpen ? (
          <section
            aria-label={t("runHistory")}
            className="flex min-h-0 flex-1 flex-col border-t border-border"
          >
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
              {t("runHistory")}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {!selectedGraphId || runs.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {selectedGraphId ? t("noRuns") : t("noGraphSelected")}
                </p>
              ) : (
                <ul className="space-y-1">
                  <li>
                    <Button
                      className="w-full justify-start text-xs"
                      onClick={() => onSelectRun(null)}
                      size="sm"
                      variant="ghost"
                      aria-pressed={!selectedRunId}
                    >
                      {t("noRunSelected")}
                    </Button>
                  </li>
                  {runs.map((run) => (
                    <li key={run.id}>
                      <Button
                        aria-pressed={selectedRunId === run.id}
                        className={cn(
                          "h-auto w-full flex-col items-start gap-1 px-2 py-2 text-xs font-normal",
                          selectedRunId === run.id && "bg-muted",
                        )}
                        onClick={() => onSelectRun(run.id)}
                        variant="ghost"
                      >
                        <span>{new Date(run.createdAt).toLocaleString()}</span>
                        <span className="text-muted-foreground">
                          {t(`runStatus_${run.status}`)}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
};
