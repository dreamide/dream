import { AlertTriangle, ChevronDown, Play, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type {
  AgentGraph,
  GraphNodeType,
  GraphValidationResult,
} from "@/types/agent-graphs";
import { NODE_TYPES } from "./graph-templates";

export interface GraphToolbarProps {
  graph: AgentGraph;
  onAddNode: (type: GraphNodeType) => void;
  onRename: (name: string) => void;
  onStartRun: () => void;
  starting: boolean;
  validation: GraphValidationResult | null;
}

export const GraphToolbar = ({
  graph,
  onAddNode,
  onRename,
  onStartRun,
  starting,
  validation,
}: GraphToolbarProps) => {
  const t = useTranslations("graphs");
  const [draftName, setDraftName] = useState<string | null>(null);
  // An empty workflow is just unfinished, not broken: Run is disabled below,
  // so don't report it as an error.
  const issues = graph.nodes.length === 0 ? null : validation;
  const errorCount = issues?.errors.length ?? 0;
  const warningCount = issues?.warnings.length ?? 0;
  const issueTitle = issues
    ? [...issues.errors, ...issues.warnings]
        .map((issue) => issue.message)
        .join("\n")
    : "";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Input
        aria-label={t("graphName")}
        className="h-8 w-56 text-sm font-medium"
        onBlur={() => {
          if (draftName?.trim() && draftName !== graph.name) {
            onRename(draftName.trim());
          }
          setDraftName(null);
        }}
        onChange={(event) => setDraftName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraftName(null);
            event.currentTarget.blur();
          }
        }}
        value={draftName ?? graph.name}
      />

      {errorCount > 0 || warningCount > 0 ? (
        <span className="flex items-center gap-1 text-xs" title={issueTitle}>
          <AlertTriangle
            className={
              errorCount > 0
                ? "size-3.5 text-destructive"
                : "size-3.5 text-amber-500"
            }
          />
          {errorCount > 0
            ? t("validationErrors", { count: errorCount })
            : t("validationWarnings", { count: warningCount })}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" type="button" variant="outline">
                <Plus className="size-3.5" />
                {t("addNode")}
                <ChevronDown className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-64">
            {NODE_TYPES.map((type) => (
              <DropdownMenuItem
                className="flex-col items-start gap-0"
                key={type}
                onClick={() => onAddNode(type)}
              >
                <span>{t(`nodeType_${type}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`nodeTypeHelp_${type}`)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          disabled={starting || errorCount > 0 || graph.nodes.length === 0}
          onClick={onStartRun}
          size="sm"
          type="button"
          variant="default"
        >
          {starting ? (
            <Spinner className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
          {t("run")}
        </Button>
      </div>
    </div>
  );
};
