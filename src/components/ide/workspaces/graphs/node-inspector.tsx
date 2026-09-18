import { ChevronRight, Flag, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  getConnectedProviders,
  getModelOptionsForProvider,
} from "@/lib/ide-defaults";
import type {
  AgentGraph,
  GraphNode,
  GraphNodeAgent,
  GraphNodeType,
} from "@/types/agent-graphs";
import type { AiProvider, ModelSpeed, ReasoningEffort } from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import {
  getProviderLabel,
  MODEL_SPEED_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from "../../ide-types";
import { describeNodeAgent } from "./graph-agent-display";

const INHERIT = "__inherit__";
const MODEL_VALUE_SEPARATOR = "|";
const toModelValue = (provider: AiProvider, model: string) =>
  `${provider}${MODEL_VALUE_SEPARATOR}${model}`;

export interface NodeInspectorProps {
  /** The project agent a step falls back to when it does not set its own. */
  defaultAgent: GraphNodeAgent;
  graph: AgentGraph;
  node: GraphNode;
  onChange: (updater: (node: GraphNode) => GraphNode) => void;
  onDelete: () => void;
  onSetEntry: () => void;
}

export const NodeInspector = ({
  defaultAgent,
  graph,
  node,
  onChange,
  onDelete,
  onSetEntry,
}: NodeInspectorProps) => {
  const t = useTranslations("graphs");
  const allProviderModels = useIdeStore((s) => s.providerModels);
  const settings = useIdeStore((s) => s.settings);
  // Same enabled-model list, grouped by provider, as the settings picker.
  const modelGroups = useMemo(
    () =>
      getConnectedProviders(settings)
        .map((provider) => ({
          models: getModelOptionsForProvider(
            provider,
            settings,
            allProviderModels[provider].models,
          ),
          provider,
        }))
        .filter((group) => group.models.length > 0),
    [allProviderModels, settings],
  );
  const current = describeNodeAgent(
    node.agent,
    defaultAgent,
    allProviderModels,
  );
  const projectDefault = describeNodeAgent({}, defaultAgent, allProviderModels);
  const modelT = useTranslations("models");
  // Effort and speed choices depend on the model the step will actually use,
  // which may come from the project default.
  const inherited = describeNodeAgent(
    { ...node.agent, modelSpeed: undefined, reasoningEffort: undefined },
    defaultAgent,
    allProviderModels,
  );
  const effortOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    inherited.efforts.includes(option.value),
  );
  const speedOptions = MODEL_SPEED_OPTIONS.filter((option) =>
    inherited.speedTiers.includes(option.value),
  );
  const selectedEffort =
    node.agent.reasoningEffort &&
    inherited.efforts.includes(node.agent.reasoningEffort)
      ? node.agent.reasoningEffort
      : null;
  const selectedSpeed =
    node.agent.modelSpeed &&
    inherited.speedTiers.includes(node.agent.modelSpeed)
      ? node.agent.modelSpeed
      : null;
  const defaultOptionLabel = (value: string | null) =>
    value ? `${t("defaultBadge")} (${modelT(value)})` : t("defaultBadge");
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
        </div>

        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
            {t("advanced")}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label htmlFor={`node-mode-${node.id}`}>{t("agentMode")}</Label>
              <Select
                onValueChange={(value) =>
                  value !== null &&
                  setAgent({
                    agentMode: value === "plan" ? "plan" : undefined,
                  })
                }
                value={node.agent.agentMode === "plan" ? "plan" : "build"}
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
                  <SelectItem value="build">{t("agentModeBuild")}</SelectItem>
                  <SelectItem value="plan">{t("agentModePlan")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`node-model-${node.id}`}>{t("model")}</Label>
              <Select
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  if (value === INHERIT) {
                    setAgent({
                      model: undefined,
                      modelSpeed: undefined,
                      provider: undefined,
                      reasoningEffort: undefined,
                    });
                    return;
                  }
                  const separator = value.indexOf(MODEL_VALUE_SEPARATOR);
                  const nextProvider = value.slice(0, separator) as AiProvider;
                  const nextModel = value.slice(separator + 1);
                  setAgent({
                    model: nextModel,
                    provider: nextProvider,
                    // Effort and speed are model-specific; fall back to the
                    // default until chosen again (unsupported values are
                    // ignored anyway).
                    ...(nextProvider !== node.agent.provider
                      ? { modelSpeed: undefined, reasoningEffort: undefined }
                      : {}),
                  });
                }}
                value={
                  node.agent.provider && node.agent.model
                    ? toModelValue(node.agent.provider, node.agent.model)
                    : INHERIT
                }
              >
                <SelectTrigger
                  className="w-full min-w-0"
                  id={`node-model-${node.id}`}
                >
                  <SelectValue>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {current.provider ? (
                        <ProviderIcon
                          className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400"
                          provider={current.provider}
                        />
                      ) : null}
                      <span className="truncate">
                        {current.isDefault
                          ? `${t("defaultBadge")} (${current.modelLabel || t("inheritProject")})`
                          : current.modelLabel}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  align="start"
                  alignItemWithTrigger={false}
                  className="min-w-72"
                >
                  <SelectItem value={INHERIT}>
                    {`${t("defaultBadge")} (${projectDefault.modelLabel || t("inheritProject")})`}
                  </SelectItem>
                  {modelGroups.map((group) => (
                    <SelectGroup key={group.provider}>
                      <SelectLabel>
                        {getProviderLabel(group.provider)}
                      </SelectLabel>
                      {group.models.map((model) => (
                        <SelectItem
                          key={model.id}
                          value={toModelValue(group.provider, model.id)}
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <ProviderIcon
                              className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400"
                              provider={group.provider}
                            />
                            <span className="truncate">{model.label}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {effortOptions.length > 0 || speedOptions.length > 0 ? (
              <div className="space-y-3">
                {effortOptions.length > 0 ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={`node-effort-${node.id}`}>
                      {t("effort")}
                    </Label>
                    <Select
                      onValueChange={(value) =>
                        value !== null &&
                        setAgent({
                          reasoningEffort:
                            value === INHERIT
                              ? undefined
                              : (value as ReasoningEffort),
                        })
                      }
                      value={selectedEffort ?? INHERIT}
                    >
                      <SelectTrigger
                        className="w-full min-w-0"
                        id={`node-effort-${node.id}`}
                      >
                        <SelectValue>
                          {selectedEffort
                            ? modelT(selectedEffort)
                            : defaultOptionLabel(inherited.effort)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start" alignItemWithTrigger={false}>
                        <SelectItem value={INHERIT}>
                          {defaultOptionLabel(inherited.effort)}
                        </SelectItem>
                        {effortOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {modelT(option.value)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {speedOptions.length > 0 ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={`node-speed-${node.id}`}>
                      {t("speed")}
                    </Label>
                    <Select
                      onValueChange={(value) =>
                        value !== null &&
                        setAgent({
                          modelSpeed:
                            value === INHERIT
                              ? undefined
                              : (value as ModelSpeed),
                        })
                      }
                      value={selectedSpeed ?? INHERIT}
                    >
                      <SelectTrigger
                        className="w-full min-w-0"
                        id={`node-speed-${node.id}`}
                      >
                        <SelectValue>
                          {selectedSpeed
                            ? modelT(selectedSpeed)
                            : defaultOptionLabel(inherited.speed)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start" alignItemWithTrigger={false}>
                        <SelectItem value={INHERIT}>
                          {defaultOptionLabel(inherited.speed)}
                        </SelectItem>
                        {speedOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {modelT(option.value)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
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
