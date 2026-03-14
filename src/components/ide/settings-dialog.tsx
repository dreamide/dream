import {
  ArrowLeft,
  Boxes,
  Monitor,
  Moon,
  Plug,
  Sun,
  Terminal,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getConnectedProviders,
  getModelOptionsForProvider,
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
  const { setTheme, theme } = useTheme();

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
  const geminiModels = useMemo(
    () => getModelsForProvider("gemini", settings),
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
  const selectedDefaultGeminiModel = geminiModels.includes(
    settings.defaultGeminiModel,
  )
    ? settings.defaultGeminiModel
    : (geminiModels[0] ?? "");
  const isOpenAiConnected = connectedProviders.includes("openai");
  const isAnthropicConnected = connectedProviders.includes("anthropic");
  const isGeminiConnected = connectedProviders.includes("gemini");
  const openAiAuthModeLabel =
    settings.openAiAuthMode === "codex" ? "Codex Login" : "API Key";
  const anthropicAuthModeLabel =
    settings.anthropicAuthMode === "claudeProMax"
      ? "Claude Pro/Max Subscription"
      : "API Key";
  const canConnectOpenAi =
    settings.openAiAuthMode === "codex"
      ? codexLoginStatus.loggedIn
      : settings.openAiApiKey.trim().length > 0;
  const isAnthropicProMaxMode = settings.anthropicAuthMode === "claudeProMax";
  const hasAnthropicOauthSession =
    settings.anthropicRefreshToken.trim().length > 0;
  const canConnectAnthropic = isAnthropicProMaxMode
    ? hasAnthropicOauthSession
    : settings.anthropicApiKey.trim().length > 0;
  const canConnectGemini = settings.geminiApiKey.trim().length > 0;
  const availableOpenAiModels = providerModels.openai.models;
  const availableAnthropicModels = providerModels.anthropic.models;
  const availableGeminiModels = providerModels.gemini.models;
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
  const geminiModelOptions = useMemo(
    () => getModelOptionsForProvider("gemini", settings, availableGeminiModels),
    [availableGeminiModels, settings],
  );
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
  const filteredGeminiModels = availableGeminiModels.filter(
    (model) =>
      normalizedModelSearchQuery.length === 0 ||
      model.id.toLowerCase().includes(normalizedModelSearchQuery) ||
      model.label.toLowerCase().includes(normalizedModelSearchQuery),
  );
  const popularProviders = useMemo(
    () =>
      ALL_PROVIDERS.filter(
        (provider) => !connectedProviders.includes(provider),
      ),
    [connectedProviders],
  );
  const [anthropicOauthCode, setAnthropicOauthCode] = useState("");
  const [anthropicOauthError, setAnthropicOauthError] = useState<string | null>(
    null,
  );
  const [anthropicOauthPending, setAnthropicOauthPending] = useState(false);
  const [anthropicOauthUrl, setAnthropicOauthUrl] = useState("");
  const [anthropicOauthVerifier, setAnthropicOauthVerifier] = useState("");
  const [themeMounted, setThemeMounted] = useState(false);

  useEffect(() => {
    setThemeMounted(true);
  }, []);

  const refreshModels = (
    next: Pick<
      typeof settings,
      | "anthropicAccessToken"
      | "anthropicAccessTokenExpiresAt"
      | "anthropicAuthMode"
      | "anthropicApiKey"
      | "anthropicRefreshToken"
      | "geminiApiKey"
      | "openAiApiKey"
      | "openAiAuthMode"
    >,
  ) => {
    void refreshProviderModels({
      anthropicAccessToken: next.anthropicAccessToken,
      anthropicAccessTokenExpiresAt: next.anthropicAccessTokenExpiresAt,
      anthropicAuthMode: next.anthropicAuthMode,
      anthropicApiKey: next.anthropicApiKey,
      anthropicRefreshToken: next.anthropicRefreshToken,
      geminiApiKey: next.geminiApiKey,
      openAiApiKey: next.openAiApiKey,
      openAiAuthMode: next.openAiAuthMode,
    });
  };

  const beginAnthropicProMaxAuth = async (openLink: boolean) => {
    setAnthropicOauthError(null);
    setAnthropicOauthPending(true);

    try {
      const response = await fetch("/api/anthropic-oauth/authorize", {
        body: JSON.stringify({ mode: "max" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(
          `Failed to create authorization link (${response.status}).`,
        );
      }

      const payload = (await response.json()) as {
        url?: string;
        verifier?: string;
      };

      const nextUrl = payload.url?.trim() ?? "";
      const nextVerifier = payload.verifier?.trim() ?? "";

      if (!nextUrl || !nextVerifier) {
        throw new Error(
          "Authorization link response is missing required fields.",
        );
      }

      setAnthropicOauthUrl(nextUrl);
      setAnthropicOauthVerifier(nextVerifier);

      if (openLink) {
        openExternalUrl(nextUrl);
      }
    } catch (error) {
      setAnthropicOauthError(
        error instanceof Error
          ? error.message
          : "Unable to start Claude Pro/Max authorization.",
      );
    } finally {
      setAnthropicOauthPending(false);
    }
  };

  const submitAnthropicProMaxCode = async () => {
    const code = anthropicOauthCode.trim();
    const verifier = anthropicOauthVerifier.trim();

    if (!code) {
      setAnthropicOauthError("Authorization code is required.");
      return;
    }

    if (!verifier) {
      setAnthropicOauthError("Generate an authorization link first.");
      return;
    }

    setAnthropicOauthError(null);
    setAnthropicOauthPending(true);

    try {
      const response = await fetch("/api/anthropic-oauth/exchange", {
        body: JSON.stringify({ code, verifier }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          message || `Authorization failed (${response.status}).`,
        );
      }

      const payload = (await response.json()) as {
        accessToken?: string;
        expiresAt?: number;
        refreshToken?: string;
      };

      const accessToken = payload.accessToken?.trim() ?? "";
      const refreshToken = payload.refreshToken?.trim() ?? "";
      const expiresAt =
        typeof payload.expiresAt === "number" ? payload.expiresAt : null;

      if (!accessToken || !refreshToken || !expiresAt) {
        throw new Error("Authorization response is missing token fields.");
      }

      setSettings((previous) => ({
        ...previous,
        anthropicAccessToken: accessToken,
        anthropicAccessTokenExpiresAt: expiresAt,
        anthropicApiKey: "",
        anthropicAuthMode: "claudeProMax",
        anthropicRefreshToken: refreshToken,
      }));

      refreshModels({
        anthropicAccessToken: accessToken,
        anthropicAccessTokenExpiresAt: expiresAt,
        anthropicApiKey: "",
        anthropicAuthMode: "claudeProMax",
        anthropicRefreshToken: refreshToken,
        geminiApiKey: settings.geminiApiKey,
        openAiApiKey: settings.openAiApiKey,
        openAiAuthMode: settings.openAiAuthMode,
      });

      submitProviderSetup("anthropic");
      setAnthropicOauthCode("");
    } catch (error) {
      setAnthropicOauthError(
        error instanceof Error ? error.message : "Invalid authorization code.",
      );
    } finally {
      setAnthropicOauthPending(false);
    }
  };

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
                  Appearance
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
                        if (!value) {
                          return;
                        }

                        setTheme(value);
                      }}
                      value={themeMounted ? (theme ?? "system") : "system"}
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
                  </div>
                </div>
              ) : null}

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
                      <div className="h-9 w-9" />
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

                              refreshModels({
                                anthropicAccessToken:
                                  settings.anthropicAccessToken,
                                anthropicAccessTokenExpiresAt:
                                  settings.anthropicAccessTokenExpiresAt,
                                anthropicAuthMode: settings.anthropicAuthMode,
                                anthropicApiKey: settings.anthropicApiKey,
                                anthropicRefreshToken:
                                  settings.anthropicRefreshToken,
                                geminiApiKey: settings.geminiApiKey,
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
                              <SelectValue>{openAiAuthModeLabel}</SelectValue>
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
                            {settings.anthropicAuthMode === "claudeProMax"
                              ? "Login with Claude Pro/Max"
                              : "Connect Anthropic"}
                          </h3>
                          <p className="text-muted-foreground">
                            Anthropic gives you access to Claude models for
                            coding, analysis, and long-context reasoning.
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="anthropic-auth-mode">
                            Authentication Method
                          </Label>
                          <Select
                            onValueChange={(value) => {
                              const nextMode = value as
                                | "apiKey"
                                | "claudeProMax";
                              const nextAnthropicSettings = {
                                anthropicAccessToken:
                                  nextMode === "claudeProMax"
                                    ? settings.anthropicAccessToken
                                    : "",
                                anthropicAccessTokenExpiresAt:
                                  nextMode === "claudeProMax"
                                    ? settings.anthropicAccessTokenExpiresAt
                                    : null,
                                anthropicApiKey:
                                  nextMode === "apiKey"
                                    ? settings.anthropicApiKey
                                    : "",
                                anthropicAuthMode: nextMode,
                                anthropicRefreshToken:
                                  nextMode === "claudeProMax"
                                    ? settings.anthropicRefreshToken
                                    : "",
                              } as const;

                              setAnthropicOauthError(null);

                              setSettings((previous) => ({
                                ...previous,
                                ...nextAnthropicSettings,
                                anthropicSelectedModels: [],
                                defaultAnthropicModel: "",
                              }));

                              setProviderModels((previous) => ({
                                ...previous,
                                anthropic: {
                                  ...previous.anthropic,
                                  error: null,
                                  models: [],
                                  source: "unavailable",
                                },
                              }));

                              refreshModels({
                                ...nextAnthropicSettings,
                                geminiApiKey: settings.geminiApiKey,
                                openAiApiKey: settings.openAiApiKey,
                                openAiAuthMode: settings.openAiAuthMode,
                              });

                              if (
                                nextMode === "claudeProMax" &&
                                settings.anthropicRefreshToken.trim().length ===
                                  0 &&
                                anthropicOauthVerifier.trim().length === 0
                              ) {
                                void beginAnthropicProMaxAuth(true);
                              }
                            }}
                            value={settings.anthropicAuthMode}
                          >
                            <SelectTrigger
                              className="w-full sm:w-[320px]"
                              id="anthropic-auth-mode"
                            >
                              <SelectValue>
                                {anthropicAuthModeLabel}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent className="w-auto min-w-[320px]">
                              <SelectItem value="apiKey">API Key</SelectItem>
                              <SelectItem value="claudeProMax">
                                Claude Pro/Max Subscription
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {settings.anthropicAuthMode === "apiKey" ? (
                          <>
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
                          </>
                        ) : (
                          <>
                            <p className="text-muted-foreground">
                              Visit{" "}
                              {anthropicOauthUrl ? (
                                <button
                                  className="font-medium text-foreground underline"
                                  onClick={() =>
                                    openExternalUrl(anthropicOauthUrl)
                                  }
                                  type="button"
                                >
                                  this link
                                </button>
                              ) : (
                                <span className="font-medium text-foreground">
                                  this link
                                </span>
                              )}{" "}
                              to collect your authorization code to connect your
                              account and use Anthropic models.
                            </p>

                            <div className="flex items-center gap-2">
                              <Button
                                disabled={anthropicOauthPending}
                                onClick={() =>
                                  void beginAnthropicProMaxAuth(true)
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                {anthropicOauthUrl
                                  ? "Open authorization link"
                                  : "Generate authorization link"}
                              </Button>
                            </div>

                            <div className="space-y-1.5">
                              <Label htmlFor="anthropic-pro-max-code">
                                Claude Pro/Max authorization code
                              </Label>
                              <Input
                                id="anthropic-pro-max-code"
                                onChange={(event) =>
                                  setAnthropicOauthCode(
                                    event.currentTarget.value,
                                  )
                                }
                                placeholder="Paste authorization code"
                                value={anthropicOauthCode}
                              />
                            </div>

                            {anthropicOauthError ? (
                              <p className="text-amber-700 text-sm">
                                {anthropicOauthError}
                              </p>
                            ) : null}
                            {providerModels.anthropic.error ? (
                              <p className="text-amber-700 text-sm">
                                {providerModels.anthropic.error}
                              </p>
                            ) : null}
                            {hasAnthropicOauthSession ? (
                              <p className="text-emerald-700 text-sm">
                                Claude Pro/Max subscription is connected.
                              </p>
                            ) : null}

                            <div className="flex items-center gap-2 pt-1">
                              <Button
                                disabled={
                                  anthropicOauthPending ||
                                  anthropicOauthCode.trim().length === 0
                                }
                                onClick={() => void submitAnthropicProMaxCode()}
                                type="button"
                              >
                                {anthropicOauthPending
                                  ? "Submitting..."
                                  : "Submit"}
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
                          </>
                        )}
                      </div>
                    ) : null}

                    {providerSetupTarget === "gemini" ? (
                      <div className="mx-auto max-w-3xl space-y-5">
                        <div className="space-y-2">
                          <h3 className="font-semibold text-2xl">
                            Connect Gemini
                          </h3>
                          <p className="text-muted-foreground">
                            Gemini gives you access to Google's Gemini models
                            for chat, coding, and multimodal work.
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor="gemini-key">Gemini API Key</Label>
                          <Input
                            id="gemini-key"
                            onChange={(event) =>
                              setSettings((previous) => ({
                                ...previous,
                                geminiApiKey: event.currentTarget.value,
                              }))
                            }
                            placeholder="AIza..."
                            type="password"
                            value={settings.geminiApiKey}
                          />
                        </div>

                        {providerModels.gemini.error ? (
                          <p className="text-amber-700 text-sm">
                            {providerModels.gemini.error}
                          </p>
                        ) : null}

                        {!canConnectGemini ? (
                          <p className="text-muted-foreground text-sm">
                            Add a Gemini API key before connecting.
                          </p>
                        ) : null}

                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            disabled={!canConnectGemini}
                            onClick={() => submitProviderSetup("gemini")}
                            type="button"
                          >
                            {isGeminiConnected ? "Save" : "Connect"}
                          </Button>
                          {isGeminiConnected ? (
                            <Button
                              onClick={() => {
                                disconnectProvider("gemini");
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
                                    : provider === "anthropic"
                                      ? `${anthropicModels.length} models enabled`
                                      : `${geminiModels.length} models enabled`}
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
                        ) : null}
                        {popularProviders.map((provider) => (
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
                        ))}
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
                              const isSelected = openAiModels.includes(
                                model.id,
                              );

                              return (
                                <div
                                  className="flex items-center justify-between rounded-sm px-1.5 py-1"
                                  key={model.id}
                                >
                                  <Label
                                    className={cn(
                                      "truncate text-sm",
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
                                      if (checked === isSelected) return;
                                      toggleProviderModel("openai", model.id);
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
                          value={selectedDefaultOpenAiModel}
                        >
                          <SelectTrigger
                            className="w-56 max-w-full"
                            disabled={openAiModels.length === 0}
                            id="openai-model"
                          >
                            <SelectValue placeholder="Select model">
                              {openAiModelOptions.find(
                                (model) =>
                                  model.id === selectedDefaultOpenAiModel,
                              )?.label ?? selectedDefaultOpenAiModel}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="min-w-56">
                            {openAiModelOptions.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.label}
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
                              const isSelected = anthropicModels.includes(
                                model.id,
                              );

                              return (
                                <div
                                  className="flex items-center justify-between rounded-sm px-1.5 py-1"
                                  key={model.id}
                                >
                                  <Label
                                    className={cn(
                                      "truncate text-sm",
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
                                      if (checked === isSelected) return;
                                      toggleProviderModel(
                                        "anthropic",
                                        model.id,
                                      );
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
                          value={selectedDefaultAnthropicModel}
                        >
                          <SelectTrigger
                            className="w-56 max-w-full"
                            disabled={anthropicModels.length === 0}
                            id="anthropic-model"
                          >
                            <SelectValue placeholder="Select model">
                              {anthropicModelOptions.find(
                                (model) =>
                                  model.id === selectedDefaultAnthropicModel,
                              )?.label ?? selectedDefaultAnthropicModel}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="min-w-56">
                            {anthropicModelOptions.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ) : null}

                  {connectedProviders.length > 0 && isGeminiConnected ? (
                    <div className="space-y-3 rounded-lg p-4">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">Gemini</p>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Enabled Gemini Models</Label>
                        <p className="text-muted-foreground text-sm">
                          Only enabled models appear in project chat.
                        </p>
                        <div className="space-y-1.5 rounded-md p-1">
                          {availableGeminiModels.length === 0 ? (
                            <p className="px-2 py-1.5 text-muted-foreground text-sm">
                              No live models available yet. Refresh after
                              connecting.
                            </p>
                          ) : filteredGeminiModels.length === 0 ? (
                            <p className="px-2 py-1.5 text-muted-foreground text-sm">
                              No models match this search.
                            </p>
                          ) : (
                            filteredGeminiModels.map((model) => {
                              const isSelected = geminiModels.includes(
                                model.id,
                              );

                              return (
                                <div
                                  className="flex items-center justify-between rounded-sm px-1.5 py-1"
                                  key={model.id}
                                >
                                  <Label
                                    className={cn(
                                      "truncate text-sm",
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
                                      if (checked === isSelected) return;
                                      toggleProviderModel("gemini", model.id);
                                    }}
                                  />
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="gemini-model">
                          Default Gemini Model
                        </Label>
                        <Select
                          onValueChange={(value) =>
                            setSettings((previous) => ({
                              ...previous,
                              defaultGeminiModel: value as string,
                            }))
                          }
                          value={selectedDefaultGeminiModel}
                        >
                          <SelectTrigger
                            className="w-56 max-w-full"
                            disabled={geminiModels.length === 0}
                            id="gemini-model"
                          >
                            <SelectValue placeholder="Select model">
                              {geminiModelOptions.find(
                                (model) =>
                                  model.id === selectedDefaultGeminiModel,
                              )?.label ?? selectedDefaultGeminiModel}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="min-w-56">
                            {geminiModelOptions.map((model) => (
                              <SelectItem key={model.id} value={model.id}>
                                {model.label}
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
