import { Flag, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentGraph,
  GraphNode,
  GraphRun,
  NodeExecution,
} from "@/types/agent-graphs";
import type { AgentMode, AiProvider } from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { ALL_PROVIDERS, getProviderLabel } from "../../ide-types";
import { ExecutionDetail, ExecutionList } from "./run-history";

const INHERIT = "__inherit__";

export interface NodeInspectorProps {
  executions: NodeExecution[];
  graph: AgentGraph;
  node: GraphNode;
  onChange: (updater: (node: GraphNode) => GraphNode) => void;
  onDelete: () => void;
  onSelectExecution: (executionId: string | null) => void;
  onSetEntry: () => void;
  run: GraphRun | null;
  selectedExecutionId: string | null;
}

export const NodeInspector = ({
  executions,
  graph,
  node,
  onChange,
  onDelete,
  onSelectExecution,
  onSetEntry,
  run,
  selectedExecutionId,
}: NodeInspectorProps) => {
  const t = useTranslations("graphs");
  const provider = node.agent.provider ?? null;
  const providerModels = useIdeStore((s) =>
    provider ? s.providerModels[provider].models : null,
  );
  const nodeExecutions = useMemo(
    () => executions.filter((execution) => execution.nodeId === node.id),
    [executions, node.id],
  );
  const selectedExecution =
    nodeExecutions.find((execution) => execution.id === selectedExecutionId) ??
    null;
  const nodeNames = useMemo(
    () => new Map(graph.nodes.map((entry) => [entry.id, entry.name])),
    [graph.nodes],
  );
  const isEntry = graph.entryNodeId === node.id;
  const isLocked = run?.status === "running";

  const setAgent = (patch: Partial<GraphNode["agent"]>) =>
    onChange((current) => {
      const agent = { ...current.agent, ...patch };
      for (const key of Object.keys(agent) as Array<keyof typeof agent>) {
        if (agent[key] === undefined) {
          delete agent[key];
        }
      }
      return { ...current, agent };
    });

  return (
    <Tabs className="flex h-full min-h-0 flex-col" defaultValue="definition">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <TabsList className="h-8">
          <TabsTrigger className="text-xs" value="definition">
            {t("tabDefinition")}
          </TabsTrigger>
          <TabsTrigger className="text-xs" value="history">
            {t("tabHistory")}
            {nodeExecutions.length > 0 ? ` (${nodeExecutions.length})` : ""}
          </TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-1">
          <Button
            disabled={isEntry || isLocked}
            onClick={onSetEntry}
            size="icon-xs"
            title={t("setAsEntry")}
            type="button"
            variant="ghost"
          >
            <Flag className="size-3.5" />
          </Button>
          <Button
            disabled={isLocked}
            onClick={onDelete}
            size="icon-xs"
            title={t("deleteNode")}
            type="button"
            variant="ghost"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <TabsContent
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
        value="definition"
      >
        <div className="space-y-1.5">
          <Label htmlFor={`node-name-${node.id}`}>{t("nodeName")}</Label>
          <Input
            id={`node-name-${node.id}`}
            onChange={(event) =>
              onChange((current) => ({ ...current, name: event.target.value }))
            }
            value={node.name}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`node-provider-${node.id}`}>{t("provider")}</Label>
            <Select
              onValueChange={(value) => {
                if (value === null) return;
                setAgent({
                  model: undefined,
                  provider:
                    value === INHERIT ? undefined : (value as AiProvider),
                });
              }}
              value={provider ?? INHERIT}
            >
              <SelectTrigger
                className="w-full min-w-0"
                id={`node-provider-${node.id}`}
              >
                <SelectValue>
                  {provider ? getProviderLabel(provider) : t("inheritProject")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectItem value={INHERIT}>{t("inheritProject")}</SelectItem>
                {ALL_PROVIDERS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {getProviderLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`node-model-${node.id}`}>{t("model")}</Label>
            {provider && providerModels && providerModels.length > 0 ? (
              <Select
                onValueChange={(value) =>
                  value !== null &&
                  setAgent({
                    model: value === INHERIT ? undefined : value,
                  })
                }
                value={node.agent.model ?? INHERIT}
              >
                <SelectTrigger
                  className="w-full min-w-0"
                  id={`node-model-${node.id}`}
                >
                  <SelectValue>
                    {providerModels?.find(
                      (model) => model.id === node.agent.model,
                    )?.label ??
                      node.agent.model ??
                      t("inheritProject")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectItem value={INHERIT}>{t("inheritProject")}</SelectItem>
                  {providerModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                disabled={!provider}
                id={`node-model-${node.id}`}
                onChange={(event) =>
                  setAgent({ model: event.target.value || undefined })
                }
                placeholder={t("inheritProject")}
                value={node.agent.model ?? ""}
              />
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`node-mode-${node.id}`}>{t("agentMode")}</Label>
            <Select
              onValueChange={(value) =>
                value !== null &&
                setAgent({
                  agentMode:
                    value === INHERIT ? undefined : (value as AgentMode),
                })
              }
              value={node.agent.agentMode ?? INHERIT}
            >
              <SelectTrigger
                className="w-full min-w-0"
                id={`node-mode-${node.id}`}
              >
                <SelectValue>
                  {node.agent.agentMode === "plan"
                    ? t("agentModePlan")
                    : t("agentModeBuild")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectItem value={INHERIT}>{t("agentModeBuild")}</SelectItem>
                <SelectItem value="build">{t("agentModeBuild")}</SelectItem>
                <SelectItem value="plan">{t("agentModePlan")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`node-iterations-${node.id}`}>
              {t("maxIterations")}
            </Label>
            <Input
              id={`node-iterations-${node.id}`}
              min={1}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                onChange((current) => ({
                  ...current,
                  maxIterations:
                    Number.isFinite(value) && value > 0 ? value : 1,
                }));
              }}
              type="number"
              value={node.maxIterations}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`node-instructions-${node.id}`}>
            {t("instructions")}
          </Label>
          <Textarea
            className="min-h-48 font-mono text-xs leading-5"
            id={`node-instructions-${node.id}`}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                instructions: event.target.value,
              }))
            }
            placeholder={t("instructionsPlaceholder")}
            rows={12}
            value={node.instructions}
          />
          <p className="text-xs text-muted-foreground">
            {t("instructionsHint")}
          </p>
        </div>
      </TabsContent>

      <TabsContent
        className="min-h-0 flex-1 overflow-y-auto p-3"
        value="history"
      >
        {!run ? (
          <p className="text-xs text-muted-foreground">{t("noRunSelected")}</p>
        ) : (
          <div className="space-y-3">
            <ExecutionList
              executions={nodeExecutions}
              nodeNames={nodeNames}
              onSelect={onSelectExecution}
              selectedExecutionId={selectedExecutionId}
            />
            {selectedExecution ? (
              <div className="border-t border-border pt-3">
                <ExecutionDetail
                  execution={selectedExecution}
                  nodeName={node.name}
                />
              </div>
            ) : null}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
};
