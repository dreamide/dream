import { ArrowLeft, Boxes, Plug, Terminal, X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  getConnectedProviders,
  getModelsForProvider,
} from "@/lib/ide-defaults";
import { cn } from "@/lib/utils";
import { useIdeStore } from "./ide-store";
import {
  ALL_PROVIDERS,
  getProviderDescription,
  getProviderLabel,
} from "./ide-types";

export const SettingsDialog = () => {
  const settings = useIdeStore((s) => s.settings);
  const settingsOpen = useIdeStore((s) => s.settingsOpen);
  const settingsSection = useIdeStore((s) => s.settingsSection);
  const providerSetupTarget = useIdeStore((s) => s.providerSetupTarget);
  const modelSearchQuery = useIdeStore((s) => s.modelSearchQuery);
  const codexLoginStatus = useIdeStore((s) => s.codexLoginStatus);
  const providerModels = useIdeStore((s) => s.providerModels);

  const setSettings = useIdeStore((s) => s.setSettings);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);
  const setProviderSetupTarget = useIdeStore((s) => s.setProviderSetupTarget);
  const setModelSearchQuery = useIdeStore((s) => s.setModelSearchQuery);
  const setProviderModels = useIdeStore((s) => s.setProviderModels);
  const disconnectProvider = useIdeStore((s) => s.disconnectProvider);
  const toggleProviderModel = useIdeStore((s) => s.toggleProviderModel);
  const openProviderSetup = useIdeStore((s) => s.openProviderSetup);
  const submitProviderSetup = useIdeStore((s) => s.submitProviderSetup);
  const refreshCodexLoginStatus = useIdeStore((s) => s.refreshCodexLoginStatus);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);

  const connectedProviders = useMemo(
    () => getConnectedProviders(settings),
    [settings],
  );
  const openAiModels = useMemo(
    () => getModelsForProvider("openai", settings),
    [settings],
  );
  const anthropicModels = useMemo(
    () => getModelsForProvider("anthropic", settings),
    [settings],
  );

  const selectedDefaultOpenAiModel = openAiModels.includes(
    settings.defaultOpenAiModel,
  )
    ? settings.defaultOpenAiModel
    : (openAiModels[0] ?? "");
  const selectedDefaultAnthropicModel = anthropicModels.includes(
    settings.defaultAnthropicModel,
  )
    ? settings.defaultAnthropicModel
    : (anthropicModels[0] ?? "");
  const isOpenAiConnected = connectedProviders.includes("openai");
  const isAnthropicConnected = connectedProviders.includes("anthropic");
  const canConnectOpenAi =
    settings.openAiAuthMode === "codex"
      ? codexLoginStatus.loggedIn
      : settings.openAiApiKey.trim().length > 0;
  const canConnectAnthropic = settings.anthropicApiKey.trim().length > 0;
  const availableOpenAiModels = providerModels.openai.models;
  const availableAnthropicModels = providerModels.anthropic.models;
  const normalizedModelSearchQuery = modelSearchQuery.trim().toLowerCase();
  const filteredOpenAiModels = availableOpenAiModels.filter(
    (model) =>
      normalizedModelSearchQuery.length === 0 ||
      model.toLowerCase().includes(normalizedModelSearchQuery),
  );
  const filteredAnthropicModels = availableAnthropicModels.filter(
    (model) =>
      normalizedModelSearchQuery.length === 0 ||
      model.toLowerCase().includes(normalizedModelSearchQuery),
  );
  const popularProviders = useMemo(
    () =>
      ALL_PROVIDERS.filter(
        (provider) => !connectedProviders.includes(provider),
      ),
    [connectedProviders],
  );
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
                  settingsSection === "models"
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSettingsSection("models")}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <Boxes className="size-4" />
                  Models
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

          <ScrollArea className="min-w-0 flex-1">
            <div className="space-y-4 p-5">
              {settingsSection === "providers" ? (
                providerSetupTarget ? (
                  <div className="rounded-xl p-5 sm:p-6">
                    <div className="mb-6 flex items-center justify-between">
                      <Button
                        className="h-9 w-9"
                        onClick={() => setProviderSetupTarget(null)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <ArrowLeft className="size-4" />
                      </Button>
                      <Button
                        className="h-9 w-9"
                        onClick={() => setSettingsOpen(false)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>

                    {providerSetupTarget === "openai" ? (
                      <div className="mx-auto max-w-3xl space-y-5">
                        <div className="space-y-2">
                          <h3 className="font-semibold text-2xl">
                            Connect OpenAI
                          </h3>
                          <p className="text-muted-foreground">
                            OpenAI gives you access to GPT and Codex model
                            families for coding and general chat.
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="openai-auth-mode">
                            Authentication Method
                          </Label>
                          <Select
                            onValueChange={(value) => {
                              const nextMode = value as "apiKey" | "codex";

                              setSettings((previous) => ({
                                ...previous,
                                defaultOpenAiModel: "",
                                openAiAuthMode: nextMode,
                                openAiSelectedModels: [],
                              }));

                              setProviderModels((previous) => ({
                                ...previous,
                                openai: {
                                  ...previous.openai,
                                  error: null,
                                  models: [],
                                  source: "unavailable",
                                },
                              }));

                              void refreshProviderModels({
                                anthropicApiKey: settings.anthropicApiKey,
                                openAiApiKey: settings.openAiApiKey,
                                openAiAuthMode: nextMode,
                              });

                              if (nextMode === "codex") {
                                void refreshCodexLoginStatus();
                              }
                            }}
                            value={settings.openAiAuthMode}
                          >
                            <SelectTrigger id="openai-auth-mode">
                              <SelectValue placeholder="Select method" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="apiKey">API Key</SelectItem>
                              <SelectItem value="codex">Codex Login</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {settings.openAiAuthMode === "apiKey" ? (
                          <div className="space-y-1.5">
                            <Label htmlFor="openai-key">OpenAI API Key</Label>
                            <Input
                              id="openai-key"
                              onChange={(event) =>
                                setSettings((previous) => ({
                                  ...previous,
                                  openAiApiKey: event.currentTarget.value,
                                }))
                              }
                              placeholder="sk-..."
                              type="password"
                              value={settings.openAiApiKey}
                            />
                          </div>
                        ) : (
                          <div className="space-y-2 rounded-md p-3">
                            <p className="font-medium text-sm">Codex Login</p>
                            <p className="text-muted-foreground text-sm">
                              Uses your local Codex session from{" "}
                              <code>~/.codex/auth.json</code>.
                            </p>
                            <p
                              className={cn(
                                "text-sm",
                                codexLoginStatus.loggedIn
                                  ? "text-emerald-700"
                                  : "text-amber-700",
                              )}
                            >
                              {codexLoginStatus.loading
                                ? "Checking status..."
                                : codexLoginStatus.message}
                            </p>
                            <div className="flex items-center gap-2">
                              <Button
                                className="h-8"
                                onClick={() => void refreshCodexLoginStatus()}
                                size="sm"
                                type="button"
                                variant="ghost"
                              >
                                Refresh Status
                              </Button>
                              <Button
                                className="h-8 px-0 text-sm"
                                onClick={() =>
                                  openExternalUrl("https://chatgpt.com")
                                }
                                size="sm"
                                type="button"
                                variant="link"
                              >
                                Open ChatGPT
                              </Button>
                            </div>
                            <Button
                              className="h-7 px-0 text-sm"
                              onClick={() =>
                                openExternalUrl(
                                  "https://platform.openai.com/docs/codex/overview",
                                )
                              }
                              type="button"
                              variant="link"
                            >
                              Run `codex login` in terminal if needed
                            </Button>
                          </div>
                        )}

                        {providerModels.openai.error ? (
                          <p className="text-amber-700 text-sm">
                            {providerModels.openai.error}
                          </p>
                        ) : null}

                        {!canConnectOpenAi ? (
                          <p className="text-muted-foreground text-sm">
                            {settings.openAiAuthMode === "codex"
                              ? "Run `codex login` and refresh status before connecting."
                              : "Add an OpenAI API key before connecting."}
                          </p>
                        ) : null}

                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            disabled={!canConnectOpenAi}
                            onClick={() => submitProviderSetup("openai")}
                            type="button"
                          >
                            {isOpenAiConnected ? "Save" : "Connect"}
                          </Button>
                          {isOpenAiConnected ? (
                            <Button
                              onClick={() => {
                                disconnectProvider("openai");
                                setProviderSetupTarget(null);
                              }}
                              type="button"
                              variant="ghost"
                            >
                              Disconnect
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {providerSetupTarget === "anthropic" ? (
                      <div className="mx-auto max-w-3xl space-y-5">
                        <div className="space-y-2">
                          <h3 className="font-semibold text-2xl">
                            Connect Anthropic
                          </h3>
                          <p className="text-muted-foreground">
                            Anthropic gives you access to Claude models for
                            coding, analysis, and long-context reasoning.
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="anthropic-key">
                            Anthropic API Key
                          </Label>
                          <Input
                            id="anthropic-key"
                            onChange={(event) =>
                              setSettings((previous) => ({
                                ...previous,
                                anthropicApiKey: event.currentTarget.value,
                              }))
                            }
                            placeholder="sk-ant-..."
                            type="password"
                            value={settings.anthropicApiKey}
                          />
                        </div>

                        {providerModels.anthropic.error ? (
                          <p className="text-amber-700 text-sm">
                            {providerModels.anthropic.error}
                          </p>
                        ) : null}

                        {!canConnectAnthropic ? (
                          <p className="text-muted-foreground text-sm">
                            Add an Anthropic API key before connecting.
                          </p>
                        ) : null}

                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            disabled={!canConnectAnthropic}
                            onClick={() => submitProviderSetup("anthropic")}
                            type="button"
                          >
                            {isAnthropicConnected ? "Save" : "Connect"}
                          </Button>
                          {isAnthropicConnected ? (
                            <Button
                              onClick={() => {
                                disconnectProvider("anthropic");
                                setProviderSetupTarget(null);
                              }}
                              type="button"
                              variant="ghost"
                            >
                              Disconnect
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="space-y-2 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">
                          Connected providers
                        </p>
                      </div>
                      {connectedProviders.length === 0 ? (
                        <p className="rounded-md px-3 py-2 text-muted-foreground text-sm">
                          Connect at least one provider before enabling models.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {ALL_PROVIDERS.filter((provider) =>
                            connectedProviders.includes(provider),
                          ).map((provider) => (
                            <div
                              className="flex items-center justify-between rounded-md px-3 py-2"
                              key={provider}
                            >
                              <div>
                                <p className="font-medium text-sm">
                                  {getProviderLabel(provider)}
                                </p>
                                <p className="text-muted-foreground text-sm">
                                  {provider === "openai"
                                    ? `${openAiModels.length} models enabled`
                                    : `${anthropicModels.length} models enabled`}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  className="h-7 px-2 text-sm"
                                  onClick={() => openProviderSetup(provider)}
                                  size="sm"
                                  type="button"
                                  variant="outline"
                                >
                                  Manage
                                </Button>
                                <Button
                                  className="h-7 px-2 text-sm"
                                  onClick={() => disconnectProvider(provider)}
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  Disconnect
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2 rounded-lg p-3">
                      <p className="font-medium text-sm">Popular providers</p>
                      <div className="space-y-2">
                        {popularProviders.length === 0 ? (
                          <p className="rounded-md px-3 py-2 text-muted-foreground text-sm">
                            All available providers are already connected.
                          </p>
                        ) : (
                          popularProviders.map((provider) => (
                            <div
                              className="flex items-center justify-between rounded-md px-3 py-2"
                              key={provider}
                            >
                              <div className="pr-3">
                                <p className="font-medium text-sm">
                                  {getProviderLabel(provider)}
                                </p>
                                <p className="text-muted-foreground text-sm">
                                  {getProviderDescription(provider)}
                                </p>
                              </div>
                              <Button
                                className="h-7 px-2 text-sm"
                                onClick={() => openProviderSetup(provider)}
                                size="sm"
                                type="button"
                                variant="default"
                              >
                                Connect
                              </Button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </>
                )
              ) : null}

              {settingsSection === "models" ? (
                <>
                  <div className="rounded-lg px-3 py-3">
                    <Input
                      onChange={(event) =>
                        setModelSearchQuery(event.currentTarget.value)
                      }
                      placeholder="Search models"
                      value={modelSearchQuery}
                    />
                  </div>

                  {connectedProviders.length === 0 ? (
                    <p className="rounded-md px-3 py-2 text-muted-foreground text-sm">
                      Connect a provider first in the Providers section.
                    </p>
                  ) : null}

                  {connectedProviders.length > 0 && isOpenAiConnected ? (
                    <div className="space-y-3 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">OpenAI</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Enabled OpenAI Models</Label>
                        <p className="text-muted-foreground text-sm">
                          Only enabled models appear in project chat.
                        </p>
                        <div className="space-y-1.5 rounded-md p-1">
                          {availableOpenAiModels.length === 0 ? (
                            <p className="px-2 py-1.5 text-muted-foreground text-sm">
                              No live models available yet. Refresh after
                              connecting.
                            </p>
                          ) : filteredOpenAiModels.length === 0 ? (
                            <p className="px-2 py-1.5 text-muted-foreground text-sm">
                              No models match this search.
                            </p>
                          ) : (
                            filteredOpenAiModels.map((model) => {
                              const isSelected = openAiModels.includes(model);

                              return (
                                <div
                                  className="flex items-center justify-between rounded-sm px-1.5 py-1"
                                  key={model}
                                >
                                  <Label
                                    className={cn(
                                      "truncate text-sm",
                                      isSelected
                                        ? "text-foreground"
                                        : "text-muted-foreground",
                                    )}
                                  >
                                    {model}
                                  </Label>
                                  <Switch
                                    checked={isSelected}
                                    onCheckedChange={(checked) => {
                                      if (checked === isSelected) return;
                                      toggleProviderModel("openai", model);
                                    }}
                                  />
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="openai-model">
                          Default OpenAI Model
                        </Label>
                        <Select
                          onValueChange={(value) =>
                            setSettings((previous) => ({
                              ...previous,
                              defaultOpenAiModel: value as string,
                            }))
                          }
                          value={selectedDefaultOpenAiModel || undefined}
                        >
                          <SelectTrigger
                            className="w-56 max-w-full"
                            disabled={openAiModels.length === 0}
                            id="openai-model"
                          >
                            <SelectValue placeholder="Select model" />
                          </SelectTrigger>
                          <SelectContent className="min-w-56">
                            {openAiModels.map((model) => (
                              <SelectItem key={model} value={model}>
                                {model}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ) : null}

                  {connectedProviders.length > 0 && isAnthropicConnected ? (
                    <div className="space-y-3 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">Anthropic</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Enabled Anthropic Models</Label>
                        <p className="text-muted-foreground text-sm">
                          Only enabled models appear in project chat.
                        </p>
                        <div className="space-y-1.5 rounded-md p-1">
                          {availableAnthropicModels.length === 0 ? (
                            <p className="px-2 py-1.5 text-muted-foreground text-sm">
                              No live models available yet. Refresh after
                              connecting.
                            </p>
                          ) : filteredAnthropicModels.length === 0 ? (
                            <p className="px-2 py-1.5 text-muted-foreground text-sm">
                              No models match this search.
                            </p>
                          ) : (
                            filteredAnthropicModels.map((model) => {
                              const isSelected =
                                anthropicModels.includes(model);

                              return (
                                <div
                                  className="flex items-center justify-between rounded-sm px-1.5 py-1"
                                  key={model}
                                >
                                  <Label
                                    className={cn(
                                      "truncate text-sm",
                                      isSelected
                                        ? "text-foreground"
                                        : "text-muted-foreground",
                                    )}
                                  >
                                    {model}
                                  </Label>
                                  <Switch
                                    checked={isSelected}
                                    onCheckedChange={(checked) => {
                                      if (checked === isSelected) return;
                                      toggleProviderModel("anthropic", model);
                                    }}
                                  />
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="anthropic-model">
                          Default Anthropic Model
                        </Label>
                        <Select
                          onValueChange={(value) =>
                            setSettings((previous) => ({
                              ...previous,
                              defaultAnthropicModel: value as string,
                            }))
                          }
                          value={selectedDefaultAnthropicModel || undefined}
                        >
                          <SelectTrigger
                            className="w-56 max-w-full"
                            disabled={anthropicModels.length === 0}
                            id="anthropic-model"
                          >
                            <SelectValue placeholder="Select model" />
                          </SelectTrigger>
                          <SelectContent className="min-w-56">
                            {anthropicModels.map((model) => (
                              <SelectItem key={model} value={model}>
                                {model}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ) : null}
                </>
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
                    placeholder="/bin/zsh"
                    value={settings.shellPath}
                  />
                  <p className="text-muted-foreground text-sm">
                    Leave empty to use the system default shell.
                  </p>
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
};
