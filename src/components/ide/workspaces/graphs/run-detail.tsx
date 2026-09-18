import { ArrowLeft, RotateCcw, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { AgentGraph, GraphRun } from "@/types/agent-graphs";
import { useIdeStore } from "../../ide-store";
import { getProviderLabel } from "../../ide-types";
import { describeNodeAgent } from "./graph-agent-display";
import { GraphCanvas } from "./graph-canvas";
import { edgeOutcome } from "./graph-conditions";
import { type GraphSelection, useGraphStore } from "./graph-store";
import { ExecutionDetail, ExecutionList } from "./run-history";

const EMPTY_EXECUTIONS: never[] = [];
const ignoreGraphChange = () => {};

export const RunDetail = ({
  run,
  onBack,
}: {
  run: GraphRun;
  onBack: () => void;
}) => {
  const t = useTranslations("graphs");
  const modelT = useTranslations("models");
  const providerModels = useIdeStore((s) => s.providerModels);
  const [selection, setSelection] = useState<GraphSelection>(null);
  const executions = useGraphStore(
    (s) => s.executionsByRunId[run.id] ?? EMPTY_EXECUTIONS,
  );
  const traversal = useGraphStore((s) => s.traversalByRunId[run.id] ?? null);
  const selectedExecutionId = useGraphStore(
    (s) => s.selectedExecutionIdByRunId[run.id] ?? null,
  );
  const selectExecution = useGraphStore((s) => s.selectExecution);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const resumeRun = useGraphStore((s) => s.resumeRun);
  const graph = useMemo<AgentGraph>(
    () => ({
      ...run.graphSnapshot,
      id: run.graphSnapshot.graphId,
      projectId: run.projectId,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      nodes: run.graphSnapshot.nodes.map((node, index) => ({
        ...node,
        // Earlier snapshots did not store layout. Never consult the live workflow.
        position: node.position ?? { x: 80, y: index * 180 },
      })),
    }),
    [run.graphSnapshot, run.projectId, run.createdAt],
  );
  const nodeNames = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.name])),
    [graph.nodes],
  );
  const node =
    selection?.kind === "node"
      ? graph.nodes.find((entry) => entry.id === selection.id)
      : null;
  const nodeAgent = node
    ? describeNodeAgent(
        node.agent,
        run.graphSnapshot.defaultAgent,
        providerModels,
      )
    : null;
  const edge =
    selection?.kind === "edge"
      ? graph.edges.find((entry) => entry.id === selection.id)
      : null;
  const visibleExecutions = node
    ? executions.filter((execution) => execution.nodeId === node.id)
    : executions;
  const execution = visibleExecutions.find(
    (entry) => entry.id === selectedExecutionId,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeft className="size-3.5" />
          {t("title")}
        </Button>
        <span className="text-sm font-medium">{run.graphSnapshot.name}</span>
        <span className="text-xs text-muted-foreground">
          {new Date(run.createdAt).toLocaleString()}
        </span>
        <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
          {run.status === "running" ? <Spinner className="size-3" /> : null}
          {t(`runStatus_${run.status}`)}
        </Badge>
        <div className="ml-auto flex gap-2">
          {run.status === "running" || run.status === "pending" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void cancelRun(run.id)}
            >
              <Square className="size-3.5" />
              {t("cancelRun")}
            </Button>
          ) : null}
          {run.status === "failed" && run.currentNodeId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void resumeRun(run.id)}
            >
              <RotateCcw className="size-3.5" />
              {t("resumeRun")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <GraphCanvas
            readOnly
            executions={executions}
            graph={graph}
            defaultAgent={run.graphSnapshot.defaultAgent}
            onGraphChange={ignoreGraphChange}
            onSelectionChange={(next) => {
              setSelection(next);
              selectExecution(run.id, null);
            }}
            run={run}
            selection={selection}
            traversal={traversal}
          />
        </div>
        <div className="w-88 shrink-0 space-y-3 overflow-y-auto border-l border-border p-3">
          <div className="text-xs font-medium">{t("runSnapshot")}</div>
          {run.error ? (
            <p className="text-xs text-destructive">{run.error}</p>
          ) : null}
          {node ? (
            <div className="space-y-2 border-b border-border pb-3">
              <div className="text-sm font-medium">{node.name}</div>
              <div className="text-xs text-muted-foreground">
                {t("maxIterations")}: {node.maxIterations}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{t("provider")}</dt>
                <dd>
                  {nodeAgent?.provider
                    ? getProviderLabel(nodeAgent.provider)
                    : t("inheritProject")}
                  {nodeAgent?.isDefault ? ` (${t("defaultBadge")})` : ""}
                </dd>
                <dt className="text-muted-foreground">{t("model")}</dt>
                <dd className="break-words">
                  {nodeAgent?.modelLabel || t("inheritProject")}
                  {[
                    nodeAgent?.effort ? modelT(nodeAgent.effort) : null,
                    nodeAgent?.speed ? modelT(nodeAgent.speed) : null,
                  ]
                    .filter(Boolean)
                    .map((part) => ` · ${part}`)
                    .join("")}
                </dd>
                <dt className="text-muted-foreground">{t("agentMode")}</dt>
                <dd>
                  {node.agent.agentMode === "plan"
                    ? t("agentModePlan")
                    : t("agentModeBuild")}
                </dd>
              </dl>
              <div className="text-xs font-medium">{t("instructions")}</div>
              <pre className="whitespace-pre-wrap break-words text-xs">
                {node.instructions}
              </pre>
            </div>
          ) : null}
          {edge ? (
            <div className="space-y-1 border-b border-border pb-3 text-xs">
              <div>
                {nodeNames.get(edge.sourceNodeId)} →{" "}
                {nodeNames.get(edge.targetNodeId)}
              </div>
              <div>
                {edgeOutcome(edge) === "failure"
                  ? t("outcomeFailure")
                  : t("outcomeSuccess")}
              </div>
            </div>
          ) : null}
          <div className="text-xs font-medium">{t("runExecutions")}</div>
          <ExecutionList
            executions={visibleExecutions}
            nodeNames={nodeNames}
            onSelect={(id) => selectExecution(run.id, id)}
            selectedExecutionId={selectedExecutionId}
            showNodeName
          />
          {execution ? (
            <ExecutionDetail
              execution={execution}
              nodeName={nodeNames.get(execution.nodeId) ?? execution.nodeId}
            />
          ) : null}
          <div className="border-t border-border pt-3">
            <div className="mb-1 text-xs font-medium">{t("sharedState")}</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(run.state, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
