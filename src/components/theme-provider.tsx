import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
  useTheme,
} from "next-themes";
import { useEffect } from "react";
import { getDesktopApi } from "@/lib/electron";

const ElectronThemeBridge = () => {
  const { theme } = useTheme();

  useEffect(() => {
    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      return;
    }

    void getDesktopApi()?.setThemePreference(theme);
  }, [theme]);

  return null;
};

export const ThemeProvider = ({ children, ...props }: ThemeProviderProps) => {
  return (
    <NextThemesProvider {...props}>
      <ElectronThemeBridge />
      {children}
    </NextThemesProvider>
  );
};
