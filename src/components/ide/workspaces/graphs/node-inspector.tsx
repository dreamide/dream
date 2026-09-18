import { ChevronRight, Flag, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentGraph,
  GraphNode,
  GraphNodeType,
} from "@/types/agent-graphs";
import type { AgentMode, AiProvider } from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { ALL_PROVIDERS, getProviderLabel } from "../../ide-types";

const INHERIT = "__inherit__";

export interface NodeInspectorProps {
  graph: AgentGraph;
  node: GraphNode;
  onChange: (updater: (node: GraphNode) => GraphNode) => void;
  onDelete: () => void;
  onSetEntry: () => void;
}

export const NodeInspector = ({
  graph,
  node,
  onChange,
  onDelete,
  onSetEntry,
}: NodeInspectorProps) => {
  const t = useTranslations("graphs");
  const provider = node.agent.provider ?? null;
  const providerModels = useIdeStore((s) =>
    provider ? s.providerModels[provider].models : null,
  );
  const isEntry = graph.entryNodeId === node.id;
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium">{t("tabDefinition")}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            disabled={isEntry}
            onClick={onSetEntry}
            size="icon-xs"
            title={t("setAsEntry")}
            type="button"
            variant="ghost"
          >
            <Flag className="size-3.5" />
          </Button>
          <Button
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

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
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

        <div className="space-y-1.5">
          <Label htmlFor={`node-type-${node.id}`}>{t("nodeType")}</Label>
          <Select
            onValueChange={(value) =>
              value !== null &&
              onChange((current) => ({
                ...current,
                type: value as GraphNodeType,
              }))
            }
            value={node.type}
          >
            <SelectTrigger
              className="w-full min-w-0"
              id={`node-type-${node.id}`}
            >
              <SelectValue>{t(`nodeType_${node.type}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              <SelectItem value="task">{t("nodeType_task")}</SelectItem>
              <SelectItem value="decision">{t("nodeType_decision")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(`nodeTypeHelp_${node.type}`)}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`node-instructions-${node.id}`}>
            {t("instructions")}
          </Label>
          <Textarea
            className="min-h-48 text-sm leading-5"
            id={`node-instructions-${node.id}`}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                instructions: event.target.value,
              }))
            }
            placeholder={t("instructionsPlaceholder")}
            rows={10}
            value={node.instructions}
          />
          <p className="text-xs text-muted-foreground">
            {t("instructionsHelp")}
          </p>
        </div>

        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
            {t("advanced")}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor={`node-provider-${node.id}`}>
                  {t("provider")}
                </Label>
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
                      {provider
                        ? getProviderLabel(provider)
                        : t("inheritProject")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
                    <SelectItem value={INHERIT}>
                      {t("inheritProject")}
                    </SelectItem>
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
                      <SelectItem value={INHERIT}>
                        {t("inheritProject")}
                      </SelectItem>
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
                    <SelectItem value={INHERIT}>
                      {t("agentModeBuild")}
                    </SelectItem>
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
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
};
