import {
  Archive,
  Monitor,
  Moon,
  Plug,
  RotateCcw,
  RotateCw,
  Sun,
  Trash2,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import anthropicLogo from "@/assets/anthropic.svg";
import openAiLogo from "@/assets/openai.svg";
import openCodeLogo from "@/assets/opencode.svg";
import { CursorIcon } from "@/components/ai-elements/provider-icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDesktopApi } from "@/lib/electron";
import {
  getModelOptionsForProvider,
  getModelsForProvider,
  resolveModelSpeedForModel,
  resolveReasoningEffortForModel,
} from "@/lib/ide-defaults";
import { getModelReasoningEfforts, getModelSpeedTiers } from "@/lib/models";
import { ACCENT_COLORS, BASE_COLORS, useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type {
  AccentColor,
  BaseColor,
  ModelSpeed,
  ReasoningEffort,
} from "@/types/ide";
import packageJson from "../../../package.json";
import { useIdeStore } from "./ide-store";
import {
  ALL_PROVIDERS,
  getProviderLabel,
  MODEL_SPEED_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

import {
  formatDeletedDate,
  ProviderStatusCard,
  SettingsControlRow,
  SettingsGroup,
  SettingsSwitchRow,
} from "./settings";

const getAccentColorLabel = (color: AccentColor) =>
  color === "black-white"
    ? "Black / white"
    : color.charAt(0).toUpperCase() + color.slice(1);

const getAccentColorSwatch = (color: AccentColor) =>
  color === "black-white"
    ? "linear-gradient(135deg, var(--foreground) 0 50%, var(--background) 50% 100%)"
    : `var(--color-${color}-500)`;

const getBaseColorLabel = (color: BaseColor) =>
  color.charAt(0).toUpperCase() + color.slice(1);

const BASE_COLOR_SWATCHES: Record<BaseColor, string> = {
  gray: "oklch(0.551 0.027 264.364)",
  neutral: "oklch(0.556 0 0)",
  slate: "oklch(0.554 0.046 257.417)",
  stone: "oklch(0.553 0.013 58.071)",
  zinc: "oklch(0.552 0.016 285.938)",
};

const getBaseColorSwatch = (color: BaseColor) => BASE_COLOR_SWATCHES[color];
const appVersion = packageJson.version;

export const SettingsDialog = () => {
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);
  const providerModels = useIdeStore((s) => s.providerModels);
  const chats = useIdeStore((s) => s.chats);
  const projects = useIdeStore((s) => s.projects);
  const closedProjects = useIdeStore((s) => s.closedProjects);

  const setSettings = useIdeStore((s) => s.setSettings);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);
  const toggleProviderModel = useIdeStore((s) => s.toggleProviderModel);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);
  const permanentlyDeleteChats = useIdeStore((s) => s.permanentlyDeleteChats);
  const restoreChats = useIdeStore((s) => s.restoreChats);

  const accentColor = useUiStore((s) => s.accentColor);
  const baseColor = useUiStore((s) => s.baseColor);
  const setAccentColor = useUiStore((s) => s.setAccentColor);
  const setBaseColor = useUiStore((s) => s.setBaseColor);
  const { setTheme, theme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  const [defaultShellPlaceholder, setDefaultShellPlaceholder] = useState("");
  const [selectedDeletedChatIds, setSelectedDeletedChatIds] = useState<
    string[]
  >([]);

  useEffect(() => {
    setThemeMounted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadDefaultShell = async () => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) {
        return;
      }

      const shell = await desktopApi.getDefaultTerminalShell();
      if (!cancelled) {
        setDefaultShellPlaceholder(shell);
      }
    };

    void loadDefaultShell();

    return () => {
      cancelled = true;
    };
  }, []);

  const openAiModels = useMemo(
    () => getModelsForProvider("openai", settings),
    [settings],
  );
  const anthropicModels = useMemo(
    () => getModelsForProvider("anthropic", settings),
    [settings],
  );
  const openCodeModels = useMemo(
    () => getModelsForProvider("opencode", settings),
    [settings],
  );
  const cursorModels = useMemo(
    () => getModelsForProvider("cursor", settings),
    [settings],
  );
  const availableOpenAiModels = providerModels.openai.models;
  const availableAnthropicModels = providerModels.anthropic.models;
  const availableOpenCodeModels = providerModels.opencode.models;
  const availableCursorModels = providerModels.cursor.models;

  const openAiModelOptions = useMemo(
    () => getModelOptionsForProvider("openai", settings, availableOpenAiModels),
    [availableOpenAiModels, settings],
  );
  const anthropicModelOptions = useMemo(
    () =>
      getModelOptionsForProvider(
        "anthropic",
        settings,
        availableAnthropicModels,
      ),
    [availableAnthropicModels, settings],
  );
  const openCodeModelOptions = useMemo(
    () =>
      getModelOptionsForProvider("opencode", settings, availableOpenCodeModels),
    [availableOpenCodeModels, settings],
  );
  const cursorModelOptions = useMemo(
    () => getModelOptionsForProvider("cursor", settings, availableCursorModels),
    [availableCursorModels, settings],
  );
  const groupedDefaultModelOptions = useMemo(
    () =>
      [
        { models: openAiModelOptions, provider: "openai" as const },
        { models: anthropicModelOptions, provider: "anthropic" as const },
        { models: openCodeModelOptions, provider: "opencode" as const },
        { models: cursorModelOptions, provider: "cursor" as const },
      ].filter((group) => group.models.length > 0),
    [
      anthropicModelOptions,
      cursorModelOptions,
      openAiModelOptions,
      openCodeModelOptions,
    ],
  );

  const selectedDefaultModel = useMemo(() => {
    const enabledModelIds = groupedDefaultModelOptions.flatMap((group) =>
      group.models.map((model) => model.id),
    );

    if (enabledModelIds.includes(settings.defaultModel)) {
      return settings.defaultModel;
    }

    return enabledModelIds[0] ?? "";
  }, [groupedDefaultModelOptions, settings.defaultModel]);
  const selectedGitGenerationModel = useMemo(() => {
    const enabledModelIds = groupedDefaultModelOptions.flatMap((group) =>
      group.models.map((model) => model.id),
    );

    if (enabledModelIds.includes(settings.defaultGitGenerationModel)) {
      return settings.defaultGitGenerationModel;
    }

    if (enabledModelIds.includes(settings.defaultModel)) {
      return settings.defaultModel;
    }

    return enabledModelIds[0] ?? "";
  }, [
    groupedDefaultModelOptions,
    settings.defaultGitGenerationModel,
    settings.defaultModel,
  ]);

  const getDefaultModelEntry = (modelId: string) => {
    for (const group of groupedDefaultModelOptions) {
      const model = group.models.find((item) => item.id === modelId);
      if (model) {
        return { model, provider: group.provider };
      }
    }

    return null;
  };

  const getDefaultModelCapabilities = (
    entry: ReturnType<typeof getDefaultModelEntry>,
  ) => {
    if (!entry) {
      return {
        reasoningEfforts: [] as ReasoningEffort[],
        speedTiers: [] as ModelSpeed[],
      };
    }

    return {
      reasoningEfforts: entry.model.reasoningEfforts?.length
        ? entry.model.reasoningEfforts
        : getModelReasoningEfforts(entry.provider, entry.model.id),
      speedTiers: entry.model.speedTiers?.length
        ? entry.model.speedTiers
        : getModelSpeedTiers(entry.provider, entry.model.id),
    };
  };

  const selectedDefaultModelEntry = getDefaultModelEntry(selectedDefaultModel);
  const selectedDefaultModelOption = selectedDefaultModelEntry?.model ?? null;
  const selectedGitGenerationModelOption =
    getDefaultModelEntry(selectedGitGenerationModel)?.model ?? null;
  const defaultModelCapabilities = getDefaultModelCapabilities(
    selectedDefaultModelEntry,
  );
  const defaultModelSpeedOptions = MODEL_SPEED_OPTIONS.filter((option) =>
    defaultModelCapabilities.speedTiers.includes(option.value),
  );
  const selectedDefaultModelSpeed = resolveModelSpeedForModel(
    settings.defaultModelSpeed,
    defaultModelCapabilities.speedTiers,
  );
  const selectedDefaultModelSpeedLabel =
    defaultModelSpeedOptions.find(
      (option) => option.value === selectedDefaultModelSpeed,
    )?.label ??
    MODEL_SPEED_OPTIONS.find(
      (option) => option.value === selectedDefaultModelSpeed,
    )?.label ??
    "Speed";
  const defaultReasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter(
    (option) =>
      defaultModelCapabilities.reasoningEfforts.includes(option.value),
  );
  const selectedDefaultReasoningEffort =
    defaultModelCapabilities.reasoningEfforts.length > 0
      ? (resolveReasoningEffortForModel(
          settings.defaultReasoningEffort,
          defaultModelCapabilities.reasoningEfforts,
        ) ?? "medium")
      : null;
  const selectedDefaultReasoningLabel =
    defaultReasoningEffortOptions.find(
      (option) => option.value === selectedDefaultReasoningEffort,
    )?.label ?? "Effort";

  const installedProviderCount = ALL_PROVIDERS.filter(
    (provider) => providerModels[provider].installed,
  ).length;
  const projectsById = useMemo(
    () =>
      new Map(
        [...projects, ...closedProjects].map((project) => [
          project.id,
          project,
        ]),
      ),
    [closedProjects, projects],
  );
  const deletedChats = useMemo(
    () =>
      [...chats]
        .filter((chat) => chat.deletedAt !== null)
        .sort(
          (left, right) =>
            Date.parse(right.deletedAt ?? "") -
            Date.parse(left.deletedAt ?? ""),
        ),
    [chats],
  );
  const selectedDeletedChatIdSet = useMemo(
    () => new Set(selectedDeletedChatIds),
    [selectedDeletedChatIds],
  );
  const allDeletedChatsSelected =
    deletedChats.length > 0 &&
    selectedDeletedChatIds.length === deletedChats.length;
  const someDeletedChatsSelected =
    selectedDeletedChatIds.length > 0 && !allDeletedChatsSelected;

  useEffect(() => {
    setSelectedDeletedChatIds((previous) => {
      const deletedChatIds = new Set(deletedChats.map((chat) => chat.id));
      const next = previous.filter((chatId) => deletedChatIds.has(chatId));
      return next.length === previous.length ? previous : next;
    });
  }, [deletedChats]);

  const toggleDeletedChatSelection = (chatId: string, checked: boolean) => {
    setSelectedDeletedChatIds((previous) => {
      if (checked) {
        return previous.includes(chatId) ? previous : [...previous, chatId];
      }

      return previous.filter((id) => id !== chatId);
    });
  };

  const toggleAllDeletedChatSelection = (checked: boolean) => {
    setSelectedDeletedChatIds(
      checked ? deletedChats.map((chat) => chat.id) : [],
    );
  };

  const handleRestoreSelectedChats = () => {
    restoreChats(selectedDeletedChatIds);
    setSelectedDeletedChatIds([]);
  };

  const handlePermanentlyDeleteSelectedChats = () => {
    permanentlyDeleteChats(selectedDeletedChatIds);
    setSelectedDeletedChatIds([]);
  };
  const handleRefreshOpenAiProvider = () => {
    void refreshProviderModels({ force: true, provider: "openai" });
  };
  const handleRefreshAnthropicProvider = () => {
    void refreshProviderModels({ force: true, provider: "anthropic" });
  };

  const handleRefreshOpenCodeProvider = () => {
    void refreshProviderModels({ force: true, provider: "opencode" });
  };

  const handleRefreshCursorProvider = () => {
    void refreshProviderModels({ force: true, provider: "cursor" });
  };

  return (
    <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
      <DialogContent className="!flex h-[min(86vh,780px)] w-[95vw] max-w-[1320px] !flex-col gap-0 overflow-hidden p-0 sm:max-w-[1320px]">
        <DialogHeader className="px-6 py-3.5 text-left">
          <DialogTitle className="text-base leading-6">Settings</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-64 shrink-0 flex-col p-3">
            <div className="space-y-1">
              <button
                className={cn(
                  "w-full rounded-md border border-transparent px-3 py-2 text-left font-medium text-sm outline-none transition-colors focus-visible:border-ring",
                  settingsSection === "appearance"
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSettingsSection("appearance")}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Monitor className="size-4" />
                  General
                </span>
              </button>
              <button
                className={cn(
                  "w-full rounded-md border border-transparent px-3 py-2 text-left font-medium text-sm outline-none transition-colors focus-visible:border-ring",
                  settingsSection === "providers"
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSettingsSection("providers")}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Plug className="size-4" />
                  Providers
                </span>
              </button>
              <button
                className={cn(
                  "w-full rounded-md border border-transparent px-3 py-2 text-left font-medium text-sm outline-none transition-colors focus-visible:border-ring",
                  settingsSection === "chats"
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSettingsSection("chats")}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Archive className="size-4" />
                  Archived Chats
                </span>
              </button>
            </div>
            <div className="mt-auto px-3 py-2 font-mono text-muted-foreground text-xs">
              v{appVersion}
            </div>
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="space-y-4 p-3">
              {settingsSection === "appearance" ? (
                <div className="space-y-4">
                  <SettingsGroup label="Appearance">
                    <SettingsControlRow
                      description="Controls the interface theme."
                      label="Theme"
                    >
                      <Tabs
                        className="w-full"
                        onValueChange={(value) => {
                          if (value) {
                            setTheme(value);
                          }
                        }}
                        value={themeMounted ? (theme ?? "dark") : "dark"}
                      >
                        <TabsList
                          className="w-full justify-start"
                          id="theme-tabs"
                        >
                          <TabsTrigger value="system">
                            <Monitor className="size-4" />
                            System
                          </TabsTrigger>
                          <TabsTrigger value="light">
                            <Sun className="size-4" />
                            Light
                          </TabsTrigger>
                          <TabsTrigger value="dark">
                            <Moon className="size-4" />
                            Dark
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </SettingsControlRow>

                    <SettingsControlRow
                      controlClassName="md:w-[34rem]"
                      description="Controls the base gray scale."
                      label="Base color"
                    >
                      <div className="flex justify-end gap-2">
                        {BASE_COLORS.map((color) => {
                          const selected = baseColor === color;

                          return (
                            <button
                              aria-label={getBaseColorLabel(color)}
                              aria-pressed={selected}
                              className={cn(
                                "size-6 rounded-full border border-border shadow-xs outline-none transition-all hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                                selected
                                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                                  : "ring-1 ring-transparent",
                              )}
                              key={color}
                              onClick={() => setBaseColor(color)}
                              style={{
                                background: getBaseColorSwatch(color),
                              }}
                              title={getBaseColorLabel(color)}
                              type="button"
                            />
                          );
                        })}
                      </div>
                    </SettingsControlRow>

                    <SettingsControlRow
                      controlClassName="md:w-[34rem]"
                      description="Controls primary actions and active states."
                      label="Accent color"
                    >
                      <div className="grid grid-cols-9 gap-2">
                        {ACCENT_COLORS.map((color) => {
                          const selected = accentColor === color;

                          return (
                            <button
                              aria-label={getAccentColorLabel(color)}
                              aria-pressed={selected}
                              className={cn(
                                "size-6 rounded-full border border-border shadow-xs outline-none transition-all hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                                selected
                                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                                  : "ring-1 ring-transparent",
                              )}
                              key={color}
                              onClick={() => setAccentColor(color)}
                              style={{
                                background: getAccentColorSwatch(color),
                              }}
                              title={getAccentColorLabel(color)}
                              type="button"
                            />
                          );
                        })}
                      </div>
                    </SettingsControlRow>
                  </SettingsGroup>

                  <SettingsControlRow
                    description={
                      <p>Sets the shell used for terminal sessions.</p>
                    }
                    label="Terminal"
                  >
                    <Input
                      aria-label="Terminal shell path"
                      id="shell-path"
                      onChange={(event) =>
                        setSettings((previous) => ({
                          ...previous,
                          shellPath: event.currentTarget.value,
                        }))
                      }
                      placeholder={defaultShellPlaceholder}
                      value={settings.shellPath}
                    />
                  </SettingsControlRow>

                  <SettingsGroup label="Permissions">
                    <SettingsSwitchRow
                      checked={settings.autoAcceptPermissions}
                      description="Agents run with the highest permissions when building"
                      label="Full permissions"
                      onCheckedChange={(checked) =>
                        setSettings((previous) => ({
                          ...previous,
                          autoAcceptPermissions: checked,
                        }))
                      }
                    />
                  </SettingsGroup>

                  <SettingsGroup label="Chat messages">
                    <SettingsSwitchRow
                      checked={settings.autoCompactContext}
                      description="Summarize older messages before the chat runs out of context"
                      label="Auto compact context"
                      onCheckedChange={(checked) =>
                        setSettings((previous) => ({
                          ...previous,
                          autoCompactContext: checked,
                        }))
                      }
                    />
                    <SettingsSwitchRow
                      checked={settings.showReasoningSummaries}
                      description="Display model reasoning summaries"
                      label="Show reasoning summaries"
                      onCheckedChange={(checked) =>
                        setSettings((previous) => ({
                          ...previous,
                          showReasoningSummaries: checked,
                        }))
                      }
                    />
                    <SettingsSwitchRow
                      checked={settings.groupToolCalls}
                      description="Collapse tool calls into compact count chips"
                      label="Group tool calls"
                      onCheckedChange={(checked) =>
                        setSettings((previous) => ({
                          ...previous,
                          groupToolCalls: checked,
                        }))
                      }
                    />
                    <SettingsSwitchRow
                      checked={settings.expandToolCalls}
                      description="Show tool calls expanded by default"
                      label="Expand tool calls"
                      onCheckedChange={(checked) =>
                        setSettings((previous) => ({
                          ...previous,
                          expandToolCalls: checked,
                        }))
                      }
                    />
                  </SettingsGroup>
                </div>
              ) : null}

              {settingsSection === "providers" ? (
                <div className="space-y-4 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <h3 className="font-medium text-sm">Providers</h3>
                      {providerModels.fetchedAt ? (
                        <p className="text-muted-foreground text-xs">
                          Last checked{" "}
                          {new Date(providerModels.fetchedAt).toLocaleString()}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {installedProviderCount === 0 ? (
                    <p className="rounded-md px-3 py-2 text-muted-foreground text-sm">
                      Install Codex CLI, Claude Code CLI, OpenCode CLI, or
                      Cursor Agent CLI, then refresh this section.
                    </p>
                  ) : null}

                  <div className="grid gap-3">
                    <ProviderStatusCard
                      action={
                        <Button
                          aria-label="Refresh OpenAI provider"
                          disabled={providerModels.openai.loading}
                          onClick={handleRefreshOpenAiProvider}
                          size="icon-xs"
                          title="Refresh OpenAI provider"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                      }
                      error={providerModels.openai.error}
                      installed={providerModels.openai.installed}
                      label="OpenAI"
                      logoSrc={openAiLogo}
                      loading={providerModels.openai.loading}
                      runtimeLabel="Codex CLI"
                      version={providerModels.openai.version}
                    >
                      <div className="space-y-1.5 rounded-md p-1">
                        {availableOpenAiModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No CLI models available yet. Refresh Providers.
                          </p>
                        ) : (
                          availableOpenAiModels.map((model) => {
                            const isSelected = openAiModels.includes(model.id);

                            return (
                              <div
                                className="flex items-center justify-between rounded-sm px-1.5 py-1 hover:bg-muted"
                                key={model.id}
                              >
                                <Label
                                  className={cn(
                                    "truncate pr-3 text-sm",
                                    isSelected
                                      ? "text-foreground"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {model.label}
                                </Label>
                                <Switch
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    if (checked !== isSelected) {
                                      toggleProviderModel("openai", model.id);
                                    }
                                  }}
                                />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </ProviderStatusCard>
                    <ProviderStatusCard
                      action={
                        <Button
                          aria-label="Refresh Anthropic provider"
                          disabled={providerModels.anthropic.loading}
                          onClick={handleRefreshAnthropicProvider}
                          size="icon-xs"
                          title="Refresh Anthropic provider"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                      }
                      error={providerModels.anthropic.error}
                      installed={providerModels.anthropic.installed}
                      label="Anthropic"
                      logoSrc={anthropicLogo}
                      loading={providerModels.anthropic.loading}
                      runtimeLabel="Claude Code CLI"
                      version={providerModels.anthropic.version}
                    >
                      <div className="space-y-1.5 rounded-md p-1">
                        {availableAnthropicModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No CLI models available yet. Refresh Providers.
                          </p>
                        ) : (
                          availableAnthropicModels.map((model) => {
                            const isSelected = anthropicModels.includes(
                              model.id,
                            );

                            return (
                              <div
                                className="flex items-center justify-between rounded-sm px-1.5 py-1 hover:bg-muted"
                                key={model.id}
                              >
                                <Label
                                  className={cn(
                                    "truncate pr-3 text-sm",
                                    isSelected
                                      ? "text-foreground"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {model.label}
                                </Label>
                                <Switch
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    if (checked !== isSelected) {
                                      toggleProviderModel(
                                        "anthropic",
                                        model.id,
                                      );
                                    }
                                  }}
                                />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </ProviderStatusCard>
                    <ProviderStatusCard
                      action={
                        <Button
                          aria-label="Refresh OpenCode provider"
                          disabled={providerModels.opencode.loading}
                          onClick={handleRefreshOpenCodeProvider}
                          size="icon-xs"
                          title="Refresh OpenCode provider"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                      }
                      error={providerModels.opencode.error}
                      installed={providerModels.opencode.installed}
                      label="OpenCode"
                      logoSrc={openCodeLogo}
                      loading={providerModels.opencode.loading}
                      runtimeLabel="OpenCode CLI"
                      version={providerModels.opencode.version}
                    >
                      <div className="space-y-1.5 rounded-md p-1">
                        {availableOpenCodeModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No CLI models available yet. Run opencode auth login
                            or configure opencode.json, then refresh Providers.
                          </p>
                        ) : (
                          availableOpenCodeModels.map((model) => {
                            const isSelected = openCodeModels.includes(
                              model.id,
                            );

                            return (
                              <div
                                className="flex items-center justify-between rounded-sm px-1.5 py-1 hover:bg-muted"
                                key={model.id}
                              >
                                <Label
                                  className={cn(
                                    "truncate pr-3 text-sm",
                                    isSelected
                                      ? "text-foreground"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {model.label}
                                </Label>
                                <Switch
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    if (checked !== isSelected) {
                                      toggleProviderModel("opencode", model.id);
                                    }
                                  }}
                                />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </ProviderStatusCard>
                    <ProviderStatusCard
                      action={
                        <Button
                          aria-label="Refresh Cursor provider"
                          disabled={providerModels.cursor.loading}
                          onClick={handleRefreshCursorProvider}
                          size="icon-xs"
                          title="Refresh Cursor provider"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                      }
                      error={providerModels.cursor.error}
                      icon={
                        <CursorIcon
                          aria-hidden="true"
                          className="size-4 text-foreground"
                          role="presentation"
                        />
                      }
                      installed={providerModels.cursor.installed}
                      label="Cursor"
                      loading={providerModels.cursor.loading}
                      runtimeLabel="Cursor Agent CLI"
                      version={providerModels.cursor.version}
                    >
                      <div className="space-y-1.5 rounded-md p-1">
                        {availableCursorModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No CLI models available yet. Refresh Providers.
                          </p>
                        ) : (
                          availableCursorModels.map((model) => {
                            const isSelected = cursorModels.includes(model.id);

                            return (
                              <div
                                className="flex items-center justify-between rounded-sm px-1.5 py-1 hover:bg-muted"
                                key={model.id}
                              >
                                <Label
                                  className={cn(
                                    "truncate pr-3 text-sm",
                                    isSelected
                                      ? "text-foreground"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {model.label}
                                </Label>
                                <Switch
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    if (checked !== isSelected) {
                                      toggleProviderModel("cursor", model.id);
                                    }
                                  }}
                                />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </ProviderStatusCard>
                  </div>

                  <div className="rounded-lg p-4">
                    <div className="space-y-4">
                      <SettingsControlRow
                        controlClassName="md:w-[34rem]"
                        description="You can switch models after a chat starts."
                        label="Default model for new chats"
                      >
                        <div className="grid w-full gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                          <Select
                            onValueChange={(value) => {
                              const defaultModel = value ?? "";
                              const capabilities = getDefaultModelCapabilities(
                                getDefaultModelEntry(defaultModel),
                              );

                              setSettings((previous) => ({
                                ...previous,
                                defaultModel,
                                defaultModelSpeed: resolveModelSpeedForModel(
                                  previous.defaultModelSpeed,
                                  capabilities.speedTiers,
                                ),
                                defaultReasoningEffort:
                                  resolveReasoningEffortForModel(
                                    previous.defaultReasoningEffort,
                                    capabilities.reasoningEfforts,
                                  ),
                              }));
                            }}
                            value={selectedDefaultModel}
                          >
                            <SelectTrigger
                              className="w-full"
                              disabled={groupedDefaultModelOptions.length === 0}
                              id="default-model"
                            >
                              <SelectValue placeholder="Enable a model first">
                                {selectedDefaultModelOption?.label}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent className="min-w-72">
                              {groupedDefaultModelOptions.map((group) => (
                                <SelectGroup key={group.provider}>
                                  {groupedDefaultModelOptions.length > 1 ? (
                                    <SelectLabel>
                                      {getProviderLabel(group.provider)}
                                    </SelectLabel>
                                  ) : null}
                                  {group.models.map((model) => (
                                    <SelectItem key={model.id} value={model.id}>
                                      {model.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              ))}
                            </SelectContent>
                          </Select>

                          {defaultReasoningEffortOptions.length > 0 &&
                          selectedDefaultReasoningEffort ? (
                            <Select
                              onValueChange={(value) =>
                                setSettings((previous) => ({
                                  ...previous,
                                  defaultReasoningEffort:
                                    value === "medium"
                                      ? null
                                      : (value as ReasoningEffort),
                                }))
                              }
                              value={selectedDefaultReasoningEffort}
                            >
                              <SelectTrigger
                                aria-label="Default reasoning effort"
                                className="w-full sm:w-32"
                              >
                                <SelectValue>
                                  {selectedDefaultReasoningLabel}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectLabel>Effort</SelectLabel>
                                  {defaultReasoningEffortOptions.map(
                                    (option) => (
                                      <SelectItem
                                        key={option.value}
                                        value={option.value}
                                      >
                                        {option.label}
                                      </SelectItem>
                                    ),
                                  )}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          ) : null}

                          {defaultModelSpeedOptions.length > 0 ? (
                            <Select
                              onValueChange={(value) =>
                                setSettings((previous) => ({
                                  ...previous,
                                  defaultModelSpeed: value as ModelSpeed,
                                }))
                              }
                              value={selectedDefaultModelSpeed}
                            >
                              <SelectTrigger
                                aria-label="Default model speed"
                                className="w-full sm:w-32"
                              >
                                <SelectValue>
                                  {selectedDefaultModelSpeedLabel}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectLabel>Speed</SelectLabel>
                                  {defaultModelSpeedOptions.map((option) => (
                                    <SelectItem
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          ) : null}
                        </div>
                      </SettingsControlRow>

                      <SettingsControlRow
                        controlClassName="md:w-[34rem] md:justify-end"
                        description="Used to draft commit messages and PR text."
                        label="Default model for commits and PRs"
                      >
                        <Select
                          onValueChange={(value) =>
                            setSettings((previous) => ({
                              ...previous,
                              defaultGitGenerationModel: value ?? "",
                            }))
                          }
                          value={selectedGitGenerationModel}
                        >
                          <SelectTrigger
                            className="w-full md:w-72"
                            disabled={groupedDefaultModelOptions.length === 0}
                            id="default-git-generation-model"
                          >
                            <SelectValue placeholder="Enable a model first">
                              {selectedGitGenerationModelOption?.label}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="min-w-72">
                            {groupedDefaultModelOptions.map((group) => (
                              <SelectGroup key={group.provider}>
                                {groupedDefaultModelOptions.length > 1 ? (
                                  <SelectLabel>
                                    {getProviderLabel(group.provider)}
                                  </SelectLabel>
                                ) : null}
                                {group.models.map((model) => (
                                  <SelectItem key={model.id} value={model.id}>
                                    {model.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </SettingsControlRow>
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsSection === "chats" ? (
                <div className="space-y-4 rounded-lg p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <h3 className="font-medium text-sm">Archived Chats</h3>
                      <p className="text-muted-foreground text-sm">
                        {deletedChats.length} archived{" "}
                        {deletedChats.length === 1 ? "chat" : "chats"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        disabled={selectedDeletedChatIds.length === 0}
                        onClick={handleRestoreSelectedChats}
                        type="button"
                        variant="outline"
                      >
                        <RotateCcw className="size-4" />
                        Restore
                      </Button>
                      <Button
                        disabled={selectedDeletedChatIds.length === 0}
                        onClick={handlePermanentlyDeleteSelectedChats}
                        type="button"
                        variant="destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    </div>
                  </div>

                  {deletedChats.length === 0 ? (
                    <div className="flex min-h-[280px] items-center justify-center rounded-md border border-surface-200 dark:border-surface-800">
                      <p className="text-muted-foreground text-sm">
                        No archived chats.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-md border border-surface-200 dark:border-surface-800">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10">
                              <Checkbox
                                aria-label="Select all archived chats"
                                checked={allDeletedChatsSelected}
                                indeterminate={someDeletedChatsSelected}
                                onCheckedChange={(checked) =>
                                  toggleAllDeletedChatSelection(checked)
                                }
                              />
                            </TableHead>
                            <TableHead>Chat</TableHead>
                            <TableHead>Project</TableHead>
                            <TableHead className="text-right">
                              Archived
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {deletedChats.map((chat) => {
                            const project = projectsById.get(chat.projectId);
                            const checked = selectedDeletedChatIdSet.has(
                              chat.id,
                            );

                            return (
                              <TableRow key={chat.id}>
                                <TableCell>
                                  <Checkbox
                                    aria-label={`Select ${chat.title}`}
                                    checked={checked}
                                    onCheckedChange={(nextChecked) =>
                                      toggleDeletedChatSelection(
                                        chat.id,
                                        nextChecked === true,
                                      )
                                    }
                                  />
                                </TableCell>
                                <TableCell className="max-w-[320px] truncate font-medium">
                                  {chat.title}
                                </TableCell>
                                <TableCell className="max-w-[280px] truncate text-muted-foreground">
                                  {project?.name ?? "Unknown project"}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                  {formatDeletedDate(chat.deletedAt ?? "")}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
