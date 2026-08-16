import type { ChatStatus } from "ai";
import { Inbox } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type KeyboardEventHandler,
  memo,
  useCallback,
  useMemo,
  useState,
} from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  getConnectedProviders,
  getDefaultModelSelection,
  getModelOptionsForProvider,
} from "@/lib/ide-defaults";
import { getModelReasoningEfforts, getModelSpeedTiers } from "@/lib/models";
import { DEFAULT_SPARKLES_PALETTE } from "@/lib/sparkles-palettes";
import type {
  AgentMode,
  ChatPermissionMode,
  ModelSpeed,
  ProjectConfig,
  ReasoningEffort,
  StashItem,
} from "@/types/ide";
import {
  ChatComposer,
  type ChatPanelModelOption,
  type ChatPanelReasoningOption,
  type ChatPanelSpeedOption,
} from "./chat/chat-composer";
import type { ChatTodoSummary } from "./chat/todo-list";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import {
  MODEL_SPEED_OPTIONS,
  normalizeModelSpeed,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";
import { RightPanelHeaderIconButton } from "./right-panel-header-icon-button";

const EMPTY_TODO_SUMMARY: ChatTodoSummary = {
  completedCount: 0,
  currentCount: 0,
  currentTaskNumber: 0,
  todos: [],
  totalCount: 0,
};

const READY_STATUS: ChatStatus = "ready";

const noopPromptKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = () => {};

export interface StashPanelProps {
  active?: boolean;
  onClosePanel: () => void;
  project: ProjectConfig;
}

const useStashModelOptions = () => {
  const settings = useIdeStore((state) => state.settings);
  const providerModels = useIdeStore((state) => state.providerModels);
  const connectedProviders = getConnectedProviders(settings);

  return useMemo<ChatPanelModelOption[]>(
    () =>
      connectedProviders.flatMap((provider) =>
        getModelOptionsForProvider(
          provider,
          settings,
          providerModels[provider].models,
        ).map((model) => ({
          contextWindow: model.contextWindow,
          id: model.id,
          label: model.label,
          provider,
          reasoningEfforts: model.reasoningEfforts ?? [],
          speedTiers: model.speedTiers ?? [],
        })),
      ),
    [connectedProviders, providerModels, settings],
  );
};

const resolveComposerSelection = (
  allModelOptions: ChatPanelModelOption[],
  selection: {
    model: string;
    modelSpeed: ModelSpeed;
    provider: StashItem["provider"];
    reasoningEffort: ReasoningEffort | null;
  },
  modelT: (key: string) => string,
) => {
  const selectedModelOption =
    allModelOptions.find(
      (option) =>
        option.provider === selection.provider && option.id === selection.model,
    ) ?? allModelOptions[0];
  const selectedProvider = selectedModelOption?.provider ?? selection.provider;
  const selectedModel = selectedModelOption?.id ?? "";
  const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
  const availableModelSpeedTiers = selectedModelOption?.speedTiers?.length
    ? selectedModelOption.speedTiers
    : getModelSpeedTiers(selectedProvider, selectedModel);
  const speedOptions = MODEL_SPEED_OPTIONS.filter((option) =>
    availableModelSpeedTiers.includes(option.value),
  );
  const normalizedModelSpeed = normalizeModelSpeed(selection.modelSpeed);
  const selectedModelSpeed =
    availableModelSpeedTiers.length === 0
      ? "standard"
      : availableModelSpeedTiers.includes(normalizedModelSpeed)
        ? normalizedModelSpeed
        : "standard";
  const availableReasoningEfforts = selectedModelOption?.reasoningEfforts
    ?.length
    ? selectedModelOption.reasoningEfforts
    : getModelReasoningEfforts(selectedProvider, selectedModel);
  const reasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    availableReasoningEfforts.includes(option.value),
  );
  const normalizedReasoningEffort = normalizeReasoningEffort(
    selection.reasoningEffort,
  );
  const selectedReasoningEffort =
    availableReasoningEfforts.length === 0
      ? null
      : normalizedReasoningEffort &&
          availableReasoningEfforts.includes(normalizedReasoningEffort)
        ? normalizedReasoningEffort
        : availableReasoningEfforts.includes("medium")
          ? "medium"
          : availableReasoningEfforts[0];

  return {
    reasoningEffortOptions,
    selectedModel,
    selectedModelLabel,
    selectedModelSpeed,
    selectedModelSpeedLabel: modelT(selectedModelSpeed),
    selectedModelValue: selectedModelOption?.id,
    selectedProvider,
    selectedReasoningEffort: selectedReasoningEffort ?? "medium",
    selectedReasoningLabel:
      selectedReasoningEffort === null
        ? modelT("reasoning")
        : modelT(selectedReasoningEffort),
    speedOptions,
  };
};

const StashItemComposer = ({
  allModelOptions,
  isActive,
  isProviderInstalled,
  item,
  onDelete,
  onSubmit,
  onUpdate,
  projectPath,
}: {
  allModelOptions: ChatPanelModelOption[];
  isActive: boolean;
  isProviderInstalled: boolean;
  item: StashItem;
  onDelete: () => void;
  onSubmit: () => void;
  onUpdate: (updater: (current: StashItem) => StashItem) => void;
  projectPath: string;
}) => {
  const modelT = useTranslations("models");
  const selection = resolveComposerSelection(allModelOptions, item, modelT);

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      onUpdate((current) => ({
        ...current,
        references: prompt.references ?? [],
        text: prompt.text,
      }));
      onSubmit();
    },
    [onSubmit, onUpdate],
  );

  return (
    <ChatComposer
      agentMode={item.agentMode}
      allModelOptions={allModelOptions}
      chatProvider={item.provider}
      className="px-3 pb-3"
      contextWindow={0}
      contextUsedTokens={0}
      hideUsageAndContext
      isActive={isActive}
      isProcessing={false}
      isProviderInstalled={isProviderInstalled}
      modelId=""
      onAgentModeChange={(agentMode) =>
        onUpdate((current) => ({ ...current, agentMode }))
      }
      onDelete={onDelete}
      onModelChange={(nextOption) =>
        onUpdate((current) => ({
          ...current,
          model: nextOption.id,
          modelSpeed: "standard",
          provider: nextOption.provider,
          reasoningEffort: null,
        }))
      }
      onModelSpeedChange={(modelSpeed) =>
        onUpdate((current) => ({ ...current, modelSpeed }))
      }
      onPermissionModeChange={(permissionMode) =>
        onUpdate((current) => ({ ...current, permissionMode }))
      }
      onPromptKeyDown={noopPromptKeyDown}
      onPromptTextChange={(text) =>
        onUpdate((current) => ({ ...current, text }))
      }
      onReasoningEffortChange={(reasoningEffort) =>
        onUpdate((current) => ({
          ...current,
          reasoningEffort:
            reasoningEffort === "medium" ? null : reasoningEffort,
        }))
      }
      onSparklesPaletteChange={() => {}}
      onStop={() => {}}
      onSubmit={handleSubmit}
      permissionMode={item.permissionMode}
      projectPath={projectPath}
      promptDomId={`stash-item-${item.id}`}
      promptInputDomId={`stash-item-input-${item.id}`}
      promptText={item.text}
      reasoningEffortOptions={
        selection.reasoningEffortOptions as ChatPanelReasoningOption[]
      }
      selectedModel={selection.selectedModel}
      selectedModelLabel={selection.selectedModelLabel}
      selectedModelSpeed={selection.selectedModelSpeed}
      selectedModelSpeedLabel={selection.selectedModelSpeedLabel}
      selectedModelValue={selection.selectedModelValue}
      selectedProvider={selection.selectedProvider}
      selectedReasoningEffort={selection.selectedReasoningEffort}
      selectedReasoningLabel={selection.selectedReasoningLabel}
      sparklesPalette={DEFAULT_SPARKLES_PALETTE}
      speedOptions={selection.speedOptions as ChatPanelSpeedOption[]}
      status={READY_STATUS}
      todoSummary={EMPTY_TODO_SUMMARY}
    />
  );
};

const StashDraftComposer = ({
  allModelOptions,
  isActive,
  onSubmit,
  project,
}: {
  allModelOptions: ChatPanelModelOption[];
  isActive: boolean;
  onSubmit: (item: Omit<StashItem, "createdAt" | "id" | "updatedAt">) => void;
  project: ProjectConfig;
}) => {
  const modelT = useTranslations("models");
  const settings = useIdeStore((state) => state.settings);
  const providerModels = useIdeStore((state) => state.providerModels);
  const defaultSelection = getDefaultModelSelection(settings);
  const [promptText, setPromptText] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>("build");
  const [permissionMode, setPermissionMode] =
    useState<ChatPermissionMode>("full-access");
  const [provider, setProvider] = useState(
    defaultSelection.model ? defaultSelection.provider : project.provider,
  );
  const [model, setModel] = useState(defaultSelection.model || project.model);
  const [modelSpeed, setModelSpeed] = useState<ModelSpeed>(
    defaultSelection.model ? defaultSelection.modelSpeed : project.modelSpeed,
  );
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort | null>(
      defaultSelection.model
        ? defaultSelection.reasoningEffort
        : project.reasoningEffort,
    );
  const selection = resolveComposerSelection(
    allModelOptions,
    { model, modelSpeed, provider, reasoningEffort },
    modelT,
  );
  const isProviderInstalled =
    providerModels[selection.selectedProvider]?.installed ?? false;

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      const text = prompt.text.trim();
      const references = prompt.references ?? [];
      if (!text && references.length === 0) {
        return;
      }

      onSubmit({
        agentMode,
        model: selection.selectedModel,
        modelSpeed: selection.selectedModelSpeed,
        permissionMode,
        provider: selection.selectedProvider,
        reasoningEffort:
          selection.selectedReasoningEffort === "medium"
            ? null
            : selection.selectedReasoningEffort,
        references,
        text,
      });
      setPromptText("");
    },
    [
      agentMode,
      onSubmit,
      permissionMode,
      selection.selectedModel,
      selection.selectedModelSpeed,
      selection.selectedProvider,
      selection.selectedReasoningEffort,
    ],
  );

  return (
    <ChatComposer
      agentMode={agentMode}
      allModelOptions={allModelOptions}
      chatProvider={provider}
      className="px-3 pb-3"
      contextWindow={0}
      contextUsedTokens={0}
      hideUsageAndContext
      isActive={isActive}
      isProcessing={false}
      isProviderInstalled={isProviderInstalled}
      modelId=""
      onAgentModeChange={setAgentMode}
      onModelChange={(nextOption) => {
        setProvider(nextOption.provider);
        setModel(nextOption.id);
        setModelSpeed("standard");
        setReasoningEffort(null);
      }}
      onModelSpeedChange={setModelSpeed}
      onPermissionModeChange={setPermissionMode}
      onPromptKeyDown={noopPromptKeyDown}
      onPromptTextChange={setPromptText}
      onReasoningEffortChange={(effort) =>
        setReasoningEffort(effort === "medium" ? null : effort)
      }
      onSparklesPaletteChange={() => {}}
      onStop={() => {}}
      onSubmit={handleSubmit}
      permissionMode={permissionMode}
      projectPath={project.path}
      promptDomId="stash-draft"
      promptInputDomId="stash-draft-input"
      promptText={promptText}
      reasoningEffortOptions={
        selection.reasoningEffortOptions as ChatPanelReasoningOption[]
      }
      selectedModel={selection.selectedModel}
      selectedModelLabel={selection.selectedModelLabel}
      selectedModelSpeed={selection.selectedModelSpeed}
      selectedModelSpeedLabel={selection.selectedModelSpeedLabel}
      selectedModelValue={selection.selectedModelValue}
      selectedProvider={selection.selectedProvider}
      selectedReasoningEffort={selection.selectedReasoningEffort}
      selectedReasoningLabel={selection.selectedReasoningLabel}
      sparklesPalette={DEFAULT_SPARKLES_PALETTE}
      speedOptions={selection.speedOptions as ChatPanelSpeedOption[]}
      status={READY_STATUS}
      todoSummary={EMPTY_TODO_SUMMARY}
    />
  );
};

const StashPanelImpl = ({
  active = true,
  onClosePanel,
  project,
}: StashPanelProps) => {
  const commonT = useTranslations("common");
  const stashT = useTranslations("stash");
  const allModelOptions = useStashModelOptions();
  const providerModels = useIdeStore((state) => state.providerModels);
  const stashItems = useIdeStore(
    (state) =>
      state.projects.find((entry) => entry.id === project.id)?.ui.stashItems ??
      project.ui.stashItems,
  );
  const addStashItem = useIdeStore((state) => state.addStashItem);
  const updateStashItem = useIdeStore((state) => state.updateStashItem);
  const deleteStashItem = useIdeStore((state) => state.deleteStashItem);
  const executeStashItem = useIdeStore((state) => state.executeStashItem);

  const handleAdd = useCallback(
    (item: Omit<StashItem, "createdAt" | "id" | "updatedAt">) => {
      addStashItem(project.id, item);
    },
    [addStashItem, project.id],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-200 bg-surface-50 px-3 py-2 text-sm font-medium dark:border-surface-800 dark:bg-surface-900">
        <RightPanelHeaderIconButton icon={Inbox} onClose={onClosePanel} />
        <span>{commonT("stash")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {stashItems.length === 0 ? (
          <div className="p-3">
            <AppShellPlaceholder message={stashT("empty")} />
          </div>
        ) : (
          <div className="flex flex-col pt-2">
            {stashItems.map((item) => (
              <StashItemComposer
                allModelOptions={allModelOptions}
                isActive={active}
                isProviderInstalled={
                  providerModels[item.provider]?.installed ?? false
                }
                item={item}
                key={item.id}
                onDelete={() => deleteStashItem(project.id, item.id)}
                onSubmit={() => executeStashItem(project.id, item.id)}
                onUpdate={(updater) =>
                  updateStashItem(project.id, item.id, updater)
                }
                projectPath={project.path}
              />
            ))}
          </div>
        )}
      </div>

      <StashDraftComposer
        allModelOptions={allModelOptions}
        isActive={active}
        onSubmit={handleAdd}
        project={project}
      />
    </div>
  );
};

export const StashPanel = memo(StashPanelImpl);
StashPanel.displayName = "StashPanel";
