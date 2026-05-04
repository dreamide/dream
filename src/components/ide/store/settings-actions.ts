import type { ProviderModelsResponse } from "../ide-types";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import {
  areSettingsSelectionsEqual,
  getPermissionModesForAutoAccept,
  getProviderModelsErrorState,
  getProviderModelsFromResponse,
  markProviderModelsLoading,
  reconcileSettingsWithProviderModels,
  toggleProviderModelInSettings,
} from "./provider-model-state";

export const createSettingsActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "setSettings"
  | "setSettingsOpen"
  | "setSettingsSection"
  | "setModelSearchQuery"
  | "toggleProviderModel"
  | "refreshProviderModels"
  | "setProviderModels"
> => ({
  setSettings: (updater) => {
    set((state) => {
      const nextSettings =
        typeof updater === "function" ? updater(state.settings) : updater;
      const autoAcceptChanged =
        nextSettings.autoAcceptPermissions !==
        state.settings.autoAcceptPermissions;

      return {
        settings: nextSettings,
        ...(autoAcceptChanged
          ? getPermissionModesForAutoAccept(nextSettings.autoAcceptPermissions)
          : {}),
      };
    });
    get().persist();
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  setModelSearchQuery: (query) => set({ modelSearchQuery: query }),

  toggleProviderModel: (provider, model) => {
    set((state) => {
      return {
        settings: toggleProviderModelInSettings(
          state.settings,
          provider,
          model,
        ),
      };
    });
  },

  refreshProviderModels: async () => {
    set((state) => ({
      providerModels: markProviderModelsLoading(state.providerModels),
    }));

    try {
      const response = await fetch("/api/provider-models", { method: "POST" });

      if (!response.ok)
        throw new Error(`Model fetch failed (${response.status}).`);

      const payload = (await response.json()) as ProviderModelsResponse;
      const providerModels = getProviderModelsFromResponse(payload);

      set({ providerModels });

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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to fetch models.";
      set((state) => ({
        providerModels: getProviderModelsErrorState(
          state.providerModels,
          message,
        ),
      }));
    }
  },

  setProviderModels: (updater) => {
    set((state) => ({
      providerModels:
        typeof updater === "function" ? updater(state.providerModels) : updater,
    }));
  },
});
