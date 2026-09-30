import type { ChatStatus } from "ai";
import { Inbox } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useMemo, useState } from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { getDefaultModelSelection } from "@/lib/ide-defaults";
import { DEFAULT_SPARKLES_PALETTE } from "@/lib/sparkles-palettes";
import type {
  ChatPermissionMode,
  ModelSpeed,
  ProjectConfig,
  ReasoningEffort,
  StashItem,
} from "@/types/ide";
import { ChatComposer } from "./chat/chat-composer";
import {
  type ChatPanelModelOption,
  getChatModelOptions,
  resolveChatModelSelection,
} from "./chat/chat-model-selection";
import type { ChatTodoSummary } from "./chat/todo-list";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { RightPanelHeaderIconButton } from "./right-panel-header-icon-button";

const EMPTY_TODO_SUMMARY: ChatTodoSummary = {
  completedCount: 0,
  currentCount: 0,
  currentTaskNumber: 0,
  todos: [],
  totalCount: 0,
};

const READY_STATUS: ChatStatus = "ready";

export interface StashPanelProps {
  active?: boolean;
  onClosePanel: () => void;
  project: ProjectConfig;
}

const useStashModelOptions = () => {
  const settings = useIdeStore((state) => state.settings);
  const providerModels = useIdeStore((state) => state.providerModels);
  return useMemo(
    () => getChatModelOptions(settings, providerModels),
    [providerModels, settings],
  );
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
  const selection = resolveChatModelSelection(item, allModelOptions);

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
      chatProvider={item.provider}
      className="px-3 pb-3"
      contextWindow={0}
      contextUsedTokens={0}
      hideUsageAndContext
      isActive={isActive}
      isProcessing={false}
      isProviderInstalled={isProviderInstalled}
      modelId=""
      modelSelection={selection}
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
      onSubmit={handleSubmit}
      permissionMode={item.permissionMode}
      projectPath={projectPath}
      promptDomId={`stash-item-${item.id}`}
      promptInputDomId={`stash-item-input-${item.id}`}
      promptText={item.text}
      sparklesPalette={DEFAULT_SPARKLES_PALETTE}
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
  const settings = useIdeStore((state) => state.settings);
  const providerModels = useIdeStore((state) => state.providerModels);
  const defaultSelection = getDefaultModelSelection(settings);
  const [promptText, setPromptText] = useState("");
  const [permissionMode, setPermissionMode] = useState<ChatPermissionMode>(
    settings.defaultPermissionMode,
  );
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
  const selection = resolveChatModelSelection(
    { model, modelSpeed, provider, reasoningEffort },
    allModelOptions,
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
      chatProvider={provider}
      className="px-3 pb-3"
      contextWindow={0}
      contextUsedTokens={0}
      hideUsageAndContext
      isActive={isActive}
      isProcessing={false}
      isProviderInstalled={isProviderInstalled}
      modelId=""
      modelSelection={selection}
      onModelChange={(nextOption) => {
        setProvider(nextOption.provider);
        setModel(nextOption.id);
        setModelSpeed("standard");
        setReasoningEffort(null);
      }}
      onModelSpeedChange={setModelSpeed}
      onPermissionModeChange={setPermissionMode}
      onPromptTextChange={setPromptText}
      onReasoningEffortChange={(effort) =>
        setReasoningEffort(effort === "medium" ? null : effort)
      }
      onSubmit={handleSubmit}
      permissionMode={permissionMode}
      projectPath={project.path}
      promptDomId="stash-draft"
      promptInputDomId="stash-draft-input"
      promptText={promptText}
      sparklesPalette={DEFAULT_SPARKLES_PALETTE}
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
          <div className="flex flex-col pt-3">
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
