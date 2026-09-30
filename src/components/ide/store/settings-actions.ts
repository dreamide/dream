import { apiClient } from "@/lib/api-client";
import { extractCliVersion, isCliUpdateAvailable } from "@/lib/cli-version";
import type { AiProvider } from "@/types/ide";
import { ALL_PROVIDERS, type CliUpgradeResult } from "../ide-types";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import type { StoreActionDependencies } from "./project-lifecycle-actions";
import { writeCachedProviderModels } from "./provider-model-cache";
import {
  areSettingsSelectionsEqual,
  getProviderModelsErrorState,
  getProviderModelsFromResponse,
  markProviderModelsLoading,
  reconcileSettingsWithProviderModels,
  toggleProviderModelInSettings,
} from "./provider-model-state";

const PROVIDER_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

const providerModelsRefreshPromises = new Map<string, Promise<void>>();
const cliUpdateCheckPromises = new Map<string, Promise<void>>();
const cliUpgradePromises = new Map<AiProvider, Promise<CliUpgradeResult>>();

const setCliUpgradeRunning = (
  set: IdeStoreSet,
  provider: AiProvider,
  running: boolean,
) => {
  set((state) => ({
    cliUpgrades: { ...state.cliUpgrades, [provider]: running },
  }));
};

const hasFreshProviderModels = (
  providerModels: IdeState["providerModels"],
): boolean => {
  if (!providerModels.fetchedAt) {
    return false;
  }

  const fetchedAt = Date.parse(providerModels.fetchedAt);
  if (Number.isNaN(fetchedAt)) {
    return false;
  }

  return Date.now() - fetchedAt < PROVIDER_MODELS_CACHE_TTL_MS;
};

export const createSettingsActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  { api = apiClient }: StoreActionDependencies = {},
): Pick<
  IdeState,
  | "setSettings"
  | "setSettingsOpen"
  | "setSettingsSection"
  | "setModelSearchQuery"
  | "toggleProviderModel"
  | "refreshProviderModels"
  | "setProviderModels"
  | "checkCliUpdates"
  | "upgradeCli"
> => ({
  setSettings: (updater) => {
    set((state) => {
      const nextSettings =
        typeof updater === "function" ? updater(state.settings) : updater;

      return {
        settings: nextSettings,
      };
    });
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  setModelSearchQuery: (query) => set({ modelSearchQuery: query }),

  toggleProviderModel: (provider, model, enabled) => {
    set((state) => {
      return {
        settings: toggleProviderModelInSettings(
          state.settings,
          provider,
          model,
          enabled,
        ),
      };
    });
  },

  refreshProviderModels: async ({ force = false, provider } = {}) => {
    if (!force && hasFreshProviderModels(get().providerModels)) {
      return;
    }

    const refreshKey = provider ?? "all";
    const existingRefreshPromise =
      providerModelsRefreshPromises.get(refreshKey);
    if (existingRefreshPromise) {
      return existingRefreshPromise;
    }

    const refreshPromise = (async () => {
      if (force || !get().providerModels.fetchedAt) {
        set((state) => ({
          providerModels: markProviderModelsLoading(
            state.providerModels,
            provider,
          ),
        }));
      }

      try {
        const payload = await api.providerModels({ force, provider });
        const providerModels = getProviderModelsFromResponse(
          payload,
          get().providerModels,
        );

        set({ providerModels });
        writeCachedProviderModels(providerModels);

        // Reconcile selected models
        set((state) => {
          const nextSettings = reconcileSettingsWithProviderModels(
            state.settings,
            providerModels,
          );

          if (areSettingsSelectionsEqual(nextSettings, state.settings)) {
            return state;
          }

          return { settings: nextSettings };
        });

        void get().checkCliUpdates({ force, provider });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          providerModels: getProviderModelsErrorState(
            state.providerModels,
            message,
            provider,
          ),
        }));
      } finally {
        providerModelsRefreshPromises.delete(refreshKey);
      }
    })();

    providerModelsRefreshPromises.set(refreshKey, refreshPromise);

    return refreshPromise;
  },

  setProviderModels: (updater) => {
    set((state) => ({
      providerModels:
        typeof updater === "function" ? updater(state.providerModels) : updater,
    }));
  },

  // The server caches release lookups, so this is cheap to call often.
  checkCliUpdates: async ({ force = false, provider } = {}) => {
    const { providerModels } = get();
    const providers = (provider ? [provider] : ALL_PROVIDERS).filter(
      (candidate) => providerModels[candidate].installed,
    );
    if (providers.length === 0) {
      return;
    }

    const checkKey = provider ?? "all";
    const existingCheckPromise = cliUpdateCheckPromises.get(checkKey);
    if (existingCheckPromise) {
      return existingCheckPromise;
    }

    const checkPromise = (async () => {
      try {
        const payload = await api.cliUpdates({ force, providers });
        set((state) => ({
          cliLatestVersions: { ...state.cliLatestVersions, ...payload.latest },
        }));
      } catch {
        // Update hints are best effort; the providers keep working without.
      } finally {
        cliUpdateCheckPromises.delete(checkKey);
      }
    })();

    cliUpdateCheckPromises.set(checkKey, checkPromise);
    return checkPromise;
  },

  upgradeCli: (provider) => {
    const existingUpgradePromise = cliUpgradePromises.get(provider);
    if (existingUpgradePromise) {
      return existingUpgradePromise;
    }

    const upgradePromise = (async (): Promise<CliUpgradeResult> => {
      setCliUpgradeRunning(set, provider, true);
      try {
        const result = await api.cliUpgrade({ provider });
        if (!result.ok) {
          return { error: result.error, status: "failed" };
        }

        // Re-read the installed version so the card (and this result) reflect
        // what the updater actually did.
        await get().refreshProviderModels({ force: true, provider });
        const { cliLatestVersions, providerModels } = get();
        const installedVersion = providerModels[provider].version;
        return {
          status: isCliUpdateAvailable(
            installedVersion,
            cliLatestVersions[provider],
          )
            ? "unchanged"
            : "updated",
          version: extractCliVersion(installedVersion),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        };
      } finally {
        setCliUpgradeRunning(set, provider, false);
        cliUpgradePromises.delete(provider);
      }
    })();

    cliUpgradePromises.set(provider, upgradePromise);
    return upgradePromise;
  },
});
