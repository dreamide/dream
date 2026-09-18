import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { NodeExecution, NodeExecutionStatus } from "@/types/agent-graphs";
import { formatDuration } from "./graph-run-status";

const STATUS_VARIANT: Record<
  NodeExecutionStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  cancelled: "outline",
  completed: "secondary",
  failed: "destructive",
  pending: "outline",
  running: "default",
};

const Section = ({
  children,
  defaultOpen = false,
  title,
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  title: string;
}) => {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="rounded-md border border-border"
    >
      <CollapsibleTrigger
        render={<Button variant="ghost" size="sm" />}
        className="group w-full justify-start text-xs text-muted-foreground"
      >
        <ChevronRight className="size-3.5 group-aria-expanded:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border p-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const JsonBlock = ({ value }: { value: unknown }) => (
  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-foreground">
    {JSON.stringify(value ?? {}, null, 2)}
  </pre>
);

const TextBlock = ({ value }: { value: string }) => (
  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-foreground">
    {value}
  </pre>
);

export interface ExecutionDetailProps {
  execution: NodeExecution;
  nodeName: string;
}

export const ExecutionDetail = ({
  execution,
  nodeName,
}: ExecutionDetailProps) => {
  const t = useTranslations("graphs");
  const duration = formatDuration(execution.startedAt, execution.completedAt);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">
          {t("executionTitle", {
            iteration: execution.iteration,
            node: nodeName,
          })}
        </span>
        <Badge variant={STATUS_VARIANT[execution.status]}>
          {t(`executionStatus_${execution.status}`)}
        </Badge>
        {duration ? (
          <span className="text-muted-foreground">{duration}</span>
        ) : null}
        <span className="text-muted-foreground">#{execution.sequence}</span>
      </div>

      {execution.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive-surface px-2 py-1.5 text-xs text-destructive">
          {execution.error}
        </div>
      ) : null}

      {execution.result?.summary ? (
        <p className="text-xs leading-5">{execution.result.summary}</p>
      ) : null}

      {execution.result ? (
        <Section defaultOpen title={t("resultData")}>
          <JsonBlock value={execution.result.data} />
        </Section>
      ) : null}

      {execution.result?.stateUpdates &&
      Object.keys(execution.result.stateUpdates).length > 0 ? (
        <Section title={t("stateUpdates")}>
          <JsonBlock value={execution.result.stateUpdates} />
        </Section>
      ) : null}

      {execution.result?.artifacts && execution.result.artifacts.length > 0 ? (
        <Section title={t("artifacts")}>
          <ul className="space-y-1 text-xs">
            {execution.result.artifacts.map((artifact) => (
              <li key={`${artifact.kind}:${artifact.path}`}>
                <span className="text-muted-foreground">{artifact.kind}</span>{" "}
                <span className="font-mono">{artifact.path}</span>
                {artifact.description ? ` — ${artifact.description}` : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {execution.outputText ? (
        <Section title={t("agentOutput")}>
          <TextBlock value={execution.outputText} />
        </Section>
      ) : null}

      {execution.input?.prompt ? (
        <Section title={t("prompt")}>
          <TextBlock value={execution.input.prompt} />
        </Section>
      ) : null}

      {execution.input?.stateSnapshot ? (
        <Section title={t("stateSnapshot")}>
          <JsonBlock value={execution.input.stateSnapshot} />
        </Section>
      ) : null}
    </div>
  );
};

export interface ExecutionListProps {
  executions: NodeExecution[];
  nodeNames: Map<string, string>;
  onSelect: (executionId: string | null) => void;
  selectedExecutionId: string | null;
  showNodeName?: boolean;
}

export const ExecutionList = ({
  executions,
  nodeNames,
  onSelect,
  selectedExecutionId,
  showNodeName = false,
}: ExecutionListProps) => {
  const t = useTranslations("graphs");

  if (executions.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        {t("noExecutions")}
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {executions.map((execution) => {
        const selected = execution.id === selectedExecutionId;
        const nodeName = nodeNames.get(execution.nodeId) ?? execution.nodeId;
        return (
          <li key={execution.id}>
            <Button
              variant="ghost"
              aria-pressed={selected}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                selected && "bg-muted",
              )}
              onClick={() => onSelect(selected ? null : execution.id)}
              type="button"
            >
              <span className="w-6 shrink-0 font-mono text-muted-foreground">
                #{execution.sequence}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {showNodeName
                  ? t("executionTitle", {
                      iteration: execution.iteration,
                      node: nodeName,
                    })
                  : t("executionShort", { iteration: execution.iteration })}
              </span>
              <Badge
                className="shrink-0"
                variant={STATUS_VARIANT[execution.status]}
              >
                {t(`executionStatus_${execution.status}`)}
              </Badge>
            </Button>
          </li>
        );
      })}
    </ul>
  );
};
