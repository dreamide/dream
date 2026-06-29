import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
  useTheme,
} from "next-themes";
import { useEffect, useRef, useState } from "react";
import { getDesktopApi, hasDesktopApi } from "@/lib/electron";

const isThemePreference = (
  theme: unknown,
): theme is "light" | "dark" | "system" =>
  theme === "light" || theme === "dark" || theme === "system";

const getSystemTheme = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

const applyDocumentTheme = (theme: "light" | "dark" | "system") => {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && getSystemTheme() === "dark"),
  );
};

const seedThemeStorage = (
  storageKey: ThemeProviderProps["storageKey"],
  theme: "light" | "dark" | "system",
) => {
  try {
    localStorage.setItem(
      typeof storageKey === "string" ? storageKey : "theme",
      theme,
    );
  } catch {
    // ignore
  }
};

const ElectronThemeBridge = () => {
  const { setTheme, theme } = useTheme();
  const [desktopThemeLoaded, setDesktopThemeLoaded] = useState(false);
  const applyingDesktopThemeRef = useRef<string | null>(null);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      setDesktopThemeLoaded(true);
      return;
    }

    let cancelled = false;

    desktopApi
      .getThemePreferences()
      .then((preferences) => {
        if (cancelled || !isThemePreference(preferences?.theme)) {
          return;
        }

        applyingDesktopThemeRef.current = preferences.theme;
        setTheme(preferences.theme);
      })
      .catch(() => {
        // Keep next-themes' browser fallback if the desktop API is unavailable.
      })
      .finally(() => {
        if (!cancelled) {
          setDesktopThemeLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setTheme]);

  useEffect(() => {
    if (!desktopThemeLoaded || !isThemePreference(theme)) {
      return;
    }

    const applyingDesktopTheme = applyingDesktopThemeRef.current;
    if (applyingDesktopTheme !== null) {
      if (applyingDesktopTheme === theme) {
        applyingDesktopThemeRef.current = null;
      }
      return;
    }

    void getDesktopApi()?.setThemePreference(theme);
  }, [desktopThemeLoaded, theme]);

  return null;
};

export const ThemeProvider = ({ children, ...props }: ThemeProviderProps) => {
  const [desktopInitialTheme, setDesktopInitialTheme] = useState<
    "light" | "dark" | "system" | null
  >(() => (hasDesktopApi() ? null : "dark"));

  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    let cancelled = false;

    desktopApi
      .getThemePreferences()
      .then((preferences) => {
        const theme = isThemePreference(preferences?.theme)
          ? preferences.theme
          : "dark";
        if (cancelled) {
          return;
        }

        applyDocumentTheme(theme);
        seedThemeStorage(props.storageKey, theme);
        setDesktopInitialTheme(theme);
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopInitialTheme("dark");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [props.storageKey]);

  if (desktopInitialTheme === null) {
    return null;
  }

  return (
    <NextThemesProvider {...props} defaultTheme={desktopInitialTheme}>
      <ElectronThemeBridge />
      {children}
    </NextThemesProvider>
  );
};
