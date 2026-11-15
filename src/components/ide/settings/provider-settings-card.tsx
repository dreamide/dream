import { RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getModelsForProvider, isProviderEnabled } from "@/lib/ide-defaults";
import type { ModelOption } from "@/lib/models";
import {
  DEFAULT_OPENCODE_MODEL_GROUP,
  getOpenCodeModelName,
  groupOpenCodeModels,
} from "@/lib/opencode-model-groups";
import type { AiProvider } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { PROVIDER_PRESENTATION } from "../provider-presentation";
import { ProviderModelRow, ProviderStatusCard } from "./settings-shared";

type ModelListProps = {
  models: ModelOption[];
  onSelectedChange: (modelId: string, selected: boolean) => void;
  selectedModels: string[];
};

const ModelList = ({
  models,
  onSelectedChange,
  selectedModels,
}: ModelListProps) => {
  const settingsT = useTranslations("settings");

  if (models.length === 0) {
    return (
      <p className="px-2 py-1.5 text-muted-foreground text-sm">
        {settingsT("noCliModels")}
      </p>
    );
  }

  return models.map((model) => (
    <ProviderModelRow
      key={model.id}
      label={model.label}
      onSelectedChange={(selected) => onSelectedChange(model.id, selected)}
      selected={selectedModels.includes(model.id)}
    />
  ));
};

/** Models in tabs by the provider part of their ids (OpenCode's). */
const GroupedModelList = ({
  group,
  models,
  onGroupChange,
  onSelectedChange,
  selectedModels,
}: ModelListProps & {
  group: string | undefined;
  onGroupChange: (group: string) => void;
}) => {
  const settingsT = useTranslations("settings");
  const groups = useMemo(() => groupOpenCodeModels(models), [models]);
  const chosenGroup = group ?? DEFAULT_OPENCODE_MODEL_GROUP;
  // Fall back to the first tab when the chosen provider is not offered.
  const activeGroup = groups.some((item) => item.id === chosenGroup)
    ? chosenGroup
    : (groups[0]?.id ?? DEFAULT_OPENCODE_MODEL_GROUP);

  if (groups.length === 0) {
    return (
      <p className="px-2 py-1.5 text-muted-foreground text-sm">
        {settingsT("noOpenCodeModels")}
      </p>
    );
  }

  return (
    <Tabs
      onValueChange={(value) => onGroupChange(String(value))}
      value={activeGroup}
    >
      {/* Stays in view while the model list scrolls. */}
      <div className="sticky top-0 z-20 -mx-1 -mt-1 overflow-x-auto bg-white px-1 pt-1 pb-1 dark:bg-surface-950">
        <TabsList>
          {groups.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {groups.map((item) => (
        <TabsContent className="space-y-1" key={item.id} value={item.id}>
          {item.models.map((model) => (
            <ProviderModelRow
              key={model.id}
              label={getOpenCodeModelName(model)}
              onSelectedChange={(selected) =>
                onSelectedChange(model.id, selected)
              }
              selected={selectedModels.includes(model.id)}
            />
          ))}
        </TabsContent>
      ))}
    </Tabs>
  );
};

/**
 * A Provider's card in Settings > Providers: its CLI's status and version,
 * refresh, enable and upgrade, and the models it lists to pick from. What
 * differs between Providers is read from its presentation row.
 */
export const ProviderSettingsCard = ({
  modelGroup,
  onModelGroupChange,
  provider,
}: {
  /** The model tab chosen on a card that groups its models. */
  modelGroup?: string;
  onModelGroupChange: (group: string) => void;
  provider: AiProvider;
}) => {
  const settingsT = useTranslations("settings");
  const uiT = useTranslations("ui");
  const { cardMark, groupsModels, Icon, label, runtimeLabel } =
    PROVIDER_PRESENTATION[provider];
  const settings = useIdeStore((s) => s.settings);
  const state = useIdeStore((s) => s.providerModels[provider]);
  const latestVersion = useIdeStore((s) => s.cliLatestVersions[provider]);
  const upgrading = useIdeStore((s) => s.cliUpgrades[provider] === true);
  const setSettings = useIdeStore((s) => s.setSettings);
  const toggleProviderModel = useIdeStore((s) => s.toggleProviderModel);
  const refreshProviderModels = useIdeStore((s) => s.refreshProviderModels);
  const upgradeCli = useIdeStore((s) => s.upgradeCli);

  const selectedModels = useMemo(
    () => getModelsForProvider(provider, settings),
    [provider, settings],
  );

  const setEnabled = (enabled: boolean) =>
    setSettings((previous) => {
      const disabledProviders = (previous.disabledProviders ?? []).filter(
        (item) => item !== provider,
      );
      return {
        ...previous,
        disabledProviders: enabled
          ? disabledProviders
          : [...disabledProviders, provider],
      };
    });
  const toggleModel = (modelId: string, selected: boolean) =>
    toggleProviderModel(provider, modelId, selected);
  const refreshLabel = settingsT("refreshProvider", { provider: label });

  return (
    <ProviderStatusCard
      action={
        <Button
          aria-label={refreshLabel}
          disabled={state.loading}
          onClick={() => {
            void refreshProviderModels({ force: true, provider });
          }}
          size="icon-xs"
          title={refreshLabel}
          type="button"
          variant="ghost"
        >
          <RotateCw className="size-3.5" />
        </Button>
      }
      enabled={isProviderEnabled(provider, settings)}
      error={state.error ? uiT("unableToFetchModels") : null}
      icon={
        "iconClassName" in cardMark ? (
          <Icon
            aria-hidden="true"
            className={cardMark.iconClassName}
            role="presentation"
          />
        ) : undefined
      }
      installed={state.installed}
      label={label}
      logoSrc={"logoSrc" in cardMark ? cardMark.logoSrc : undefined}
      loading={state.loading}
      onEnabledChange={setEnabled}
      runtimeLabel={runtimeLabel}
      latestVersion={latestVersion}
      onUpgrade={() => upgradeCli(provider)}
      upgrading={upgrading}
      version={state.version}
    >
      <div className="space-y-1 rounded-md p-1">
        {groupsModels ? (
          <GroupedModelList
            group={modelGroup}
            models={state.models}
            onGroupChange={onModelGroupChange}
            onSelectedChange={toggleModel}
            selectedModels={selectedModels}
          />
        ) : (
          <ModelList
            models={state.models}
            onSelectedChange={toggleModel}
            selectedModels={selectedModels}
          />
        )}
      </div>
    </ProviderStatusCard>
  );
};
