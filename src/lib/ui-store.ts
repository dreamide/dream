import { create } from "zustand";
import type { BaseColor } from "@/types/ide";

const UI_STORAGE_KEY = "dream-ui-preferences";

interface UiState {
  baseColor: BaseColor;
  setBaseColor: (color: BaseColor) => void;
  hydrateUi: () => void;
}

function applyBaseColor(color: BaseColor) {
  if (color === "neutral") {
    document.documentElement.removeAttribute("data-base-color");
  } else {
    document.documentElement.setAttribute("data-base-color", color);
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  baseColor: "neutral",

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
      }
    } catch {
      // ignore
    }
  },
}));
