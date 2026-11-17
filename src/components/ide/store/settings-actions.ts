import { apiClient } from "@/lib/api-client";
import { extractCliVersion, isCliUpdateAvailable } from "@/lib/cli-version";
import {
  areModelSettingsEqual,
  isProviderEnabled,
  settleModelSelection,
} from "@/lib/ide-defaults";
import type { AiProvider, AppSettings } from "@/types/ide";
import {
  ALL_PROVIDERS,
  type CliUpgradeResult,
  type SettingsSection,
} from "../ide-types";
import type {
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";
import { writeCachedProviderModels } from "./provider-model-cache";
import {
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

/**
 * The store's change for new `settings`: the settings, and every open
 * project and chat whose model they settle (settleModelSelection in
 * model-selection.js). Projects and chats appear only when one moved.
 * Every write of settings goes through here, so no project or chat is left
 * on a model that is no longer offered.
 */
export const settleSettings = (
  state: Pick<IdeState, "chats" | "projects">,
  settings: AppSettings,
): Partial<Pick<IdeState, "chats" | "projects" | "settings">> => {
  const settled = settleModelSelection({
    chats: state.chats,
    projects: state.projects,
    settings,
  });
  return {
    settings: settled.settings,
    ...(settled.projects === state.projects
      ? {}
      : { projects: settled.projects }),
    ...(settled.chats === state.chats ? {} : { chats: settled.chats }),
  };
};

type ProviderModels = IdeState["providerModels"];

/** The settings and provider actions in the store (`IdeState`). */
export interface SettingsActions {
  setSettings: (
    updater: AppSettings | ((prev: AppSettings) => AppSettings),
  ) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setModelSearchQuery: (query: string) => void;
  toggleProviderModel: (
    provider: AiProvider,
    model: string,
    enabled?: boolean,
  ) => void;
  refreshProviderModels: (options?: {
    force?: boolean;
    provider?: AiProvider;
  }) => Promise<void>;
  setProviderModels: (
    updater: ProviderModels | ((prev: ProviderModels) => ProviderModels),
  ) => void;
  checkCliUpdates: (options?: {
    force?: boolean;
    provider?: AiProvider;
  }) => Promise<void>;
  upgradeCli: (provider: AiProvider) => Promise<CliUpgradeResult>;
}

export const createSettingsActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  { api = apiClient }: StoreActionDependencies = {},
): SettingsActions => {
  // The newest model fetch started for each provider. Fetches overlap (an
  // all-provider refresh still running when an upgrade re-reads one CLI), and
  // one that started earlier can finish later; only the newest may write a
  // provider's state, so an old answer never replaces a newer one.
  let lastProviderModelsRequest = 0;
  const newestProviderModelsRequest = new Map<AiProvider, number>();

  return {
    setSettings: (updater) => {
      set((state) =>
        settleSettings(
          state,
          typeof updater === "function" ? updater(state.settings) : updater,
        ),
      );
    },

    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setSettingsSection: (section) => set({ settingsSection: section }),
    setModelSearchQuery: (query) => set({ modelSearchQuery: query }),

    toggleProviderModel: (provider, model, enabled) => {
      set((state) =>
        settleSettings(
          state,
          toggleProviderModelInSettings(
            state.settings,
            provider,
            model,
            enabled,
          ),
        ),
      );
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

      const requested = provider ? [provider] : ALL_PROVIDERS;
      lastProviderModelsRequest += 1;
      const request = lastProviderModelsRequest;
      for (const item of requested) {
        newestProviderModelsRequest.set(item, request);
      }
      /** The requested providers no newer fetch has started for. */
      const stillNewest = () =>
        requested.filter(
          (item) => newestProviderModelsRequest.get(item) === request,
        );

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
          const current = stillNewest();
          if (current.length === 0) {
            return;
          }
          const providerModels = getProviderModelsFromResponse(
            {
              ...Object.fromEntries(
                current.map((item) => [item, payload[item]]),
              ),
              fetchedAt: payload.fetchedAt,
            },
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

            if (areModelSettingsEqual(nextSettings, state.settings)) {
              return state;
            }

            return settleSettings(state, nextSettings);
          });

          void get().checkCliUpdates({ force, provider });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          set((state) => ({
            providerModels: stillNewest().reduce(
              (providerModels, item) =>
                getProviderModelsErrorState(providerModels, message, item),
              state.providerModels,
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
          typeof updater === "function"
            ? updater(state.providerModels)
            : updater,
      }));
    },

    // The server caches release lookups, so this is cheap to call often.
    checkCliUpdates: async ({ force = false, provider } = {}) => {
      const { providerModels, settings } = get();
      const providers = (provider ? [provider] : ALL_PROVIDERS).filter(
        (candidate) =>
          providerModels[candidate].installed &&
          isProviderEnabled(candidate, settings),
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
            cliLatestVersions: {
              ...state.cliLatestVersions,
              ...payload.latest,
            },
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
  };
};
