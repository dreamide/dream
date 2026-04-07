import {
  Monitor,
  Moon,
  Plug,
  RefreshCw,
  Sun,
  Terminal,
} from "lucide-react";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getModelOptionsForProvider,
  getModelsForProvider,
} from "@/lib/ide-defaults";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { BaseColor } from "@/types/ide";
import { useIdeStore } from "./ide-store";
import { ALL_PROVIDERS, getProviderLabel } from "./ide-types";

const PROVIDER_HELP_URLS = {
  anthropic: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
  openai: "https://developers.openai.com/codex/cli",
} as const;

const ProviderStatusCard = ({
  children,
  error,
  installed,
  label,
  loading,
  modelCount,
  onOpenHelp,
  runtimeLabel,
}: {
  children?: ReactNode;
  error: string | null;
  installed: boolean;
  label: string;
  loading: boolean;
  modelCount: number;
  onOpenHelp: () => void;
  runtimeLabel: string;
}) => {
  return (
    <div className="rounded-lg border border-foreground/10 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="font-medium text-sm">{label}</p>
          <p className="text-muted-foreground text-sm">{runtimeLabel}</p>
          <p
            className={cn(
              "text-sm",
              installed ? "text-emerald-700" : "text-amber-700",
            )}
          >
            {loading
              ? "Checking installation and models…"
              : installed
                ? `${modelCount} model${modelCount === 1 ? "" : "s"} available`
                : "CLI not detected"}
          </p>
        </div>
        <Button onClick={onOpenHelp} size="sm" type="button" variant="outline">
          Help
        </Button>
      </div>

      {error ? (
        <p className="mt-3 rounded-md bg-amber-500/8 px-3 py-2 text-amber-700 text-sm">
          {error}
        </p>
      ) : null}

      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
};

export const SettingsDialog = () => {
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);
  const modelSearchQuery = useIdeStore((s) => s.modelSearchQuery);
  const providerModels = useIdeStore((s) => s.providerModels);

  const setSettings = useIdeStore((s) => s.setSettings);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);
  const setModelSearchQuery = useIdeStore((s) => s.setModelSearchQuery);
  const toggleProviderModel = useIdeStore((s) => s.toggleProviderModel);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);

  const baseColor = useUiStore((s) => s.baseColor);
  const setBaseColor = useUiStore((s) => s.setBaseColor);
  const { setTheme, theme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);

  useEffect(() => {
    setThemeMounted(true);
  }, []);

  const openAiModels = useMemo(
    () => getModelsForProvider("openai", settings),
    [settings],
  );
  const anthropicModels = useMemo(
    () => getModelsForProvider("anthropic", settings),
    [settings],
  );
  const availableOpenAiModels = providerModels.openai.models;
  const availableAnthropicModels = providerModels.anthropic.models;

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

  const groupedDefaultModelOptions = useMemo(
    () =>
      [
        { models: openAiModelOptions, provider: "openai" as const },
        { models: anthropicModelOptions, provider: "anthropic" as const },
      ].filter((group) => group.models.length > 0),
    [anthropicModelOptions, openAiModelOptions],
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

  const normalizedModelSearchQuery = modelSearchQuery.trim().toLowerCase();
  const filteredOpenAiModels = availableOpenAiModels.filter(
    (model) =>
      normalizedModelSearchQuery.length === 0 ||
      model.id.toLowerCase().includes(normalizedModelSearchQuery) ||
      model.label.toLowerCase().includes(normalizedModelSearchQuery),
  );
  const filteredAnthropicModels = availableAnthropicModels.filter(
    (model) =>
      normalizedModelSearchQuery.length === 0 ||
      model.id.toLowerCase().includes(normalizedModelSearchQuery) ||
      model.label.toLowerCase().includes(normalizedModelSearchQuery),
  );

  const installedProviderCount = ALL_PROVIDERS.filter(
    (provider) => providerModels[provider].installed,
  ).length;

  return (
    <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
      <DialogContent className="!flex h-[min(86vh,780px)] w-[95vw] max-w-[1320px] !flex-col gap-0 overflow-hidden p-0 sm:max-w-[1320px] [&_[data-slot=dialog-close]]:right-4 [&_[data-slot=dialog-close]]:top-3.5">
        <DialogHeader className="px-6 py-3.5 text-left">
          <DialogTitle className="text-base leading-6">Settings</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <nav className="w-64 shrink-0 p-3">
            <div className="space-y-1">
              <button
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left font-medium text-sm transition-colors",
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
                  "w-full rounded-md px-3 py-2 text-left font-medium text-sm transition-colors",
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
                  "w-full rounded-md px-3 py-2 text-left font-medium text-sm transition-colors",
                  settingsSection === "terminal"
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSettingsSection("terminal")}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Terminal className="size-4" />
                  Terminal
                </span>
              </button>
            </div>
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="space-y-4 p-5">
              {settingsSection === "appearance" ? (
                <div className="space-y-4 rounded-lg p-3">
                  <div className="space-y-1">
                    <h3 className="font-medium text-sm">Theme</h3>
                    <p className="text-muted-foreground text-sm">
                      Choose how Dream should appear across the app.
                    </p>
                  </div>

                  <div className="max-w-sm">
                    <Tabs
                      onValueChange={(value) => {
                        if (value) {
                          setTheme(value);
                        }
                      }}
                      value={themeMounted ? (theme ?? "system") : "system"}
                    >
                      <TabsList className="w-full justify-start" id="theme-tabs">
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
                  </div>

                  <div className="space-y-1 pt-2">
                    <h3 className="font-medium text-sm">Base color</h3>
                    <p className="text-muted-foreground text-sm">
                      Set the base gray scale used across the interface.
                    </p>
                  </div>

                  <div className="max-w-sm">
                    <Tabs
                      onValueChange={(value) => {
                        if (value) {
                          setBaseColor(value as BaseColor);
                        }
                      }}
                      value={baseColor}
                    >
                      <TabsList
                        className="w-full justify-start"
                        id="base-color-tabs"
                      >
                        {(
                          ["neutral", "slate", "gray", "zinc", "stone"] as const
                        ).map((color) => (
                          <TabsTrigger
                            className="capitalize"
                            key={color}
                            value={color}
                          >
                            {color}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </Tabs>
                  </div>
                </div>
              ) : null}

              {settingsSection === "providers" ? (
                <div className="space-y-4 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <h3 className="font-medium text-sm">CLI Providers</h3>
                      <p className="text-muted-foreground text-sm">
                        Dream only uses locally installed Codex and Claude Code
                        CLIs. API keys and manual provider connection are no
                        longer used.
                      </p>
                      {providerModels.fetchedAt ? (
                        <p className="text-muted-foreground text-xs">
                          Last checked {new Date(providerModels.fetchedAt).toLocaleString()}
                        </p>
                      ) : null}
                    </div>

                    <Button
                      onClick={() => void refreshProviderModels()}
                      type="button"
                      variant="outline"
                    >
                      <RefreshCw className="size-4" />
                      Refresh
                    </Button>
                  </div>

                  <div className="max-w-sm">
                    <Input
                      onChange={(event) =>
                        setModelSearchQuery(event.currentTarget.value)
                      }
                      placeholder="Search models"
                      value={modelSearchQuery}
                    />
                  </div>

                  {installedProviderCount === 0 ? (
                    <p className="rounded-md px-3 py-2 text-muted-foreground text-sm">
                      Install Codex CLI or Claude Code CLI, then refresh this
                      section.
                    </p>
                  ) : null}

                  <div className="grid gap-3 md:grid-cols-2">
                    <ProviderStatusCard
                      error={providerModels.openai.error}
                      installed={providerModels.openai.installed}
                      label="OpenAI"
                      loading={providerModels.openai.loading}
                      modelCount={providerModels.openai.models.length}
                      onOpenHelp={() =>
                        openExternalUrl(PROVIDER_HELP_URLS.openai)
                      }
                      runtimeLabel="Codex CLI"
                    >
                      <div className="space-y-1.5 rounded-md p-1">
                        {!providerModels.openai.installed ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            Install Codex CLI to use OpenAI models.
                          </p>
                        ) : availableOpenAiModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No CLI models available yet. Refresh Providers.
                          </p>
                        ) : filteredOpenAiModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No models match this search.
                          </p>
                        ) : (
                          filteredOpenAiModels.map((model) => {
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
                      error={providerModels.anthropic.error}
                      installed={providerModels.anthropic.installed}
                      label="Anthropic"
                      loading={providerModels.anthropic.loading}
                      modelCount={providerModels.anthropic.models.length}
                      onOpenHelp={() =>
                        openExternalUrl(PROVIDER_HELP_URLS.anthropic)
                      }
                      runtimeLabel="Claude Code CLI"
                    >
                      <div className="space-y-1.5 rounded-md p-1">
                        {!providerModels.anthropic.installed ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            Install Claude Code CLI to use Anthropic models.
                          </p>
                        ) : availableAnthropicModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No CLI models available yet. Refresh Providers.
                          </p>
                        ) : filteredAnthropicModels.length === 0 ? (
                          <p className="px-2 py-1.5 text-muted-foreground text-sm">
                            No models match this search.
                          </p>
                        ) : (
                          filteredAnthropicModels.map((model) => {
                            const isSelected = anthropicModels.includes(model.id);

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
                  </div>

                  <div className="space-y-3 rounded-lg p-4">
                    <div className="space-y-1">
                      <p className="font-medium text-sm">
                        Default model for new threads
                      </p>
                      <p className="text-muted-foreground text-sm">
                        New threads start on this model automatically.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="default-model">Default model</Label>
                      <Select
                        onValueChange={(value) =>
                          setSettings((previous) => ({
                            ...previous,
                            defaultModel: value ?? "",
                          }))
                        }
                        value={selectedDefaultModel}
                      >
                        <SelectTrigger
                          className="w-72 max-w-full"
                          disabled={groupedDefaultModelOptions.length === 0}
                          id="default-model"
                        >
                          <SelectValue placeholder="Enable a model first" />
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
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsSection === "terminal" ? (
                <div className="space-y-1.5 rounded-lg p-3">
                  <Label htmlFor="shell-path">Terminal Shell Path</Label>
                  <Input
                    id="shell-path"
                    onChange={(event) =>
                      setSettings((previous) => ({
                        ...previous,
                        shellPath: event.currentTarget.value,
                      }))
                    }
                    placeholder=""
                    value={settings.shellPath}
                  />
                  <p className="text-muted-foreground text-sm">
                    Leave empty to use the system default shell.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
