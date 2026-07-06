import { create } from "zustand";
import { getDesktopApi } from "@/lib/electron";
import type { AccentColor, BaseColor } from "@/types/ide";

const UI_STORAGE_KEY = "dream-ui-preferences";
const DEFAULT_BASE_COLOR: BaseColor = "zinc";
const DEFAULT_ACCENT_COLOR: AccentColor = "green";

export const BASE_COLORS = [
  "neutral",
  "slate",
  "gray",
  "zinc",
  "stone",
] as const satisfies readonly BaseColor[];

export const ACCENT_COLORS = [
  "black-white",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const satisfies readonly AccentColor[];

interface UiState {
  accentColor: AccentColor;
  baseColor: BaseColor;
  setAccentColor: (color: AccentColor) => void;
  setBaseColor: (color: BaseColor) => void;
  hydrateUi: () => Promise<void>;
}

const isBaseColor = (value: unknown): value is BaseColor =>
  typeof value === "string" &&
  (BASE_COLORS as readonly string[]).includes(value);

const isAccentColor = (value: unknown): value is AccentColor =>
  typeof value === "string" &&
  (ACCENT_COLORS as readonly string[]).includes(value);

function applyBaseColor(color: BaseColor) {
  if (typeof document === "undefined") {
    return;
  }

  if (color === "neutral") {
    document.documentElement.removeAttribute("data-base-color");
  } else {
    document.documentElement.setAttribute("data-base-color", color);
  }
}

function applyAccentColor(color: AccentColor) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute("data-accent-color", color);
}

function persistUiPreferences(preferences: {
  accentColor: AccentColor;
  baseColor: BaseColor;
}) {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // ignore
  }
}

let uiPreferenceRevision = 0;

function getInitialUiPreferences(): {
  accentColor: AccentColor;
  baseColor: BaseColor;
} {
  const preferences = getDesktopApi()?.initialThemePreferences;
  const baseColor = isBaseColor(preferences?.baseColor)
    ? preferences.baseColor
    : DEFAULT_BASE_COLOR;
  const accentColor = isAccentColor(preferences?.accentColor)
    ? preferences.accentColor
    : DEFAULT_ACCENT_COLOR;

  return { accentColor, baseColor };
}

const INITIAL_UI_PREFERENCES = getInitialUiPreferences();

export const useUiStore = create<UiState>((set, _get) => ({
  accentColor: INITIAL_UI_PREFERENCES.accentColor,
  baseColor: INITIAL_UI_PREFERENCES.baseColor,

  setAccentColor: (color) => {
    uiPreferenceRevision++;
    applyAccentColor(color);
    set({ accentColor: color });
    persistUiPreferences({
      accentColor: color,
      baseColor: useUiStore.getState().baseColor,
    });
    void getDesktopApi()?.setAccentColor(color);
  },

  setBaseColor: (color) => {
    uiPreferenceRevision++;
    applyBaseColor(color);
    set({ baseColor: color });
    persistUiPreferences({
      accentColor: useUiStore.getState().accentColor,
      baseColor: color,
    });
    void getDesktopApi()?.setBaseColor(color);
  },

  hydrateUi: async () => {
    const hydrateRevision = uiPreferenceRevision;
    const initialPreferences = getDesktopApi()?.initialThemePreferences;
    if (initialPreferences) {
      const baseColor = isBaseColor(initialPreferences.baseColor)
        ? initialPreferences.baseColor
        : DEFAULT_BASE_COLOR;
      const accentColor = isAccentColor(initialPreferences.accentColor)
        ? initialPreferences.accentColor
        : DEFAULT_ACCENT_COLOR;

      applyBaseColor(baseColor);
      applyAccentColor(accentColor);
      set({ accentColor, baseColor });
      persistUiPreferences({ accentColor, baseColor });
      return;
    }

    const desktopApi = getDesktopApi();
    if (desktopApi) {
      try {
        const preferences = await desktopApi.getThemePreferences();
        if (hydrateRevision !== uiPreferenceRevision) {
          return;
        }

        const baseColor = isBaseColor(preferences?.baseColor)
          ? preferences.baseColor
          : DEFAULT_BASE_COLOR;
        const accentColor = isAccentColor(preferences?.accentColor)
          ? preferences.accentColor
          : DEFAULT_ACCENT_COLOR;

        applyBaseColor(baseColor);
        applyAccentColor(accentColor);
        set({ accentColor, baseColor });
        persistUiPreferences({ accentColor, baseColor });

        if (!isAccentColor(preferences?.accentColor)) {
          void desktopApi.setAccentColor(accentColor);
        }
        if (!isBaseColor(preferences?.baseColor)) {
          void desktopApi.setBaseColor(baseColor);
        }

        return;
      } catch {
        // fall back to browser storage below
      }
    }

    let hydratedFromLocalStorage = false;

    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          accentColor?: unknown;
          baseColor?: unknown;
        };
        const baseColor = isBaseColor(parsed.baseColor)
          ? parsed.baseColor
          : DEFAULT_BASE_COLOR;
        const accentColor = isAccentColor(parsed.accentColor)
          ? parsed.accentColor
          : DEFAULT_ACCENT_COLOR;

        applyBaseColor(baseColor);
        applyAccentColor(accentColor);
        set({ accentColor, baseColor });
        hydratedFromLocalStorage = true;
      }
    } catch {
      // ignore
    }

    if (!hydratedFromLocalStorage) {
      applyBaseColor(DEFAULT_BASE_COLOR);
      applyAccentColor(DEFAULT_ACCENT_COLOR);
      set({
        accentColor: DEFAULT_ACCENT_COLOR,
        baseColor: DEFAULT_BASE_COLOR,
      });
    }
  },
}));
