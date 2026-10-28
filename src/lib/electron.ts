import type { DesktopApi } from "@/types/ide";
import type { DesktopMethod } from "../../electron/shared/desktop-channels.js";

// `DesktopApi` and the channel table (shared/desktop-channels.js) name the
// same methods: a method in one and not the other does not compile.
type DesktopApiMethod = Exclude<
  keyof DesktopApi,
  "apiSessionToken" | "hostMode" | "initialThemePreferences" | "isElectron"
>;
type SameKeys<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type Assert<T extends true> = T;
export type DesktopMethodsMatchTheChannelTable = Assert<
  SameKeys<DesktopApiMethod, DesktopMethod>
>;

let developmentApi: DesktopApi | null = null;

/** Fixture pages replace the bridge locally, including a frozen native preload. */
export const setFixtureDesktopApi = (api: DesktopApi) => {
  if (!import.meta.env.DEV || window.location.pathname !== "/__dev/fixtures") {
    throw new Error(
      "A fixture bridge is only available on the development fixture page.",
    );
  }
  developmentApi = api;
};

export const hasDesktopApi = (): boolean => {
  return (
    typeof window !== "undefined" &&
    Boolean(developmentApi?.isElectron || window.dream?.isElectron)
  );
};

export const getDesktopApi = (): DesktopApi | null => {
  if (!hasDesktopApi()) {
    return null;
  }

  return developmentApi ?? window.dream ?? null;
};

// Electron prefixes errors thrown across ipcRenderer.invoke with where they
// came from; the user wants only what went wrong.
const IPC_ERROR_PREFIX =
  /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

/** What went wrong in a desktop call, without Electron's IPC prefix. */
export const desktopErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    IPC_ERROR_PREFIX,
    "",
  );
