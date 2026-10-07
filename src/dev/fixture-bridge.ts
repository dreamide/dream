import { setFixtureDesktopApi } from "@/lib/electron";
import type { DesktopApi } from "@/types/ide";

// This bridge is installed before importing any feature modules. It replaces
// even a real Electron preload on the fixture page and never calls IPC.
const screenshots = new Set<() => void>();
const calls: { operation: string; value: unknown }[] = [];
const preferences = { theme: "dark" as "dark" | "light" | "system" };
const supported = {
  isElectron: true,
  apiSessionToken: "fixture-no-api-access",
  initialThemePreferences: preferences,
  getThemePreferences: async () => ({ ...preferences }),
  setThemePreference: async (theme) => {
    preferences.theme = theme;
    return true;
  },
  captureAppScreenshot: async () => ({
    status: "saved",
    filePath: "/fixture/screenshot.png",
  }),
  showScreenshotInFolder: async (value) => {
    calls.push({ operation: "showScreenshotInFolder", value });
    return true;
  },
  onAppScreenshotRequested: (listener) => {
    screenshots.add(listener);
    return () => {
      screenshots.delete(listener);
    };
  },
} satisfies Pick<
  DesktopApi,
  | "isElectron"
  | "apiSessionToken"
  | "initialThemePreferences"
  | "getThemePreferences"
  | "setThemePreference"
  | "captureAppScreenshot"
  | "showScreenshotInFolder"
  | "onAppScreenshotRequested"
>;

export const installFixtureBridge = () => {
  // Unsupported DesktopApi methods deliberately throw through the proxy.
  setFixtureDesktopApi(
    new Proxy(supported as DesktopApi, {
      get(target, property) {
        if (Reflect.has(target, property)) return Reflect.get(target, property);
        throw new Error(
          `Desktop operation ${String(property)} is unavailable in fixtures.`,
        );
      },
    }),
  );
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    );
    if (/^\/api(?:\/|$)/.test(url.pathname)) {
      return Promise.reject(
        new Error("Live API requests are blocked in fixtures."),
      );
    }
    return originalFetch(input, init);
  };
};

export const fixtureDesktop = {
  calls,
  screenshot: () => {
    for (const listener of screenshots) listener();
  },
};
