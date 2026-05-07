import { create } from "zustand";
import type { BaseColor } from "@/types/ide";
import { getDesktopApi } from "@/lib/electron";

const UI_STORAGE_KEY = "dream-ui-preferences";
const DEFAULT_BASE_COLOR: BaseColor = "zinc";

interface UiState {
  baseColor: BaseColor;
  setBaseColor: (color: BaseColor) => void;
  hydrateUi: () => void;
}

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

export const useUiStore = create<UiState>((set, _get) => ({
  baseColor: DEFAULT_BASE_COLOR,

  setBaseColor: (color) => {
    applyBaseColor(color);
    set({ baseColor: color });
    try {
      localStorage.setItem(
        UI_STORAGE_KEY,
        JSON.stringify({ baseColor: color }),
      );
    } catch {
      // ignore
    }
    void getDesktopApi()?.setBaseColor(color);
  },

  hydrateUi: () => {
    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { baseColor?: BaseColor };
        if (parsed.baseColor) {
          applyBaseColor(parsed.baseColor);
          set({ baseColor: parsed.baseColor });
        }
        return;
      }

      applyBaseColor(DEFAULT_BASE_COLOR);
      set({ baseColor: DEFAULT_BASE_COLOR });
    } catch {
      // ignore
    }
  },
}));
