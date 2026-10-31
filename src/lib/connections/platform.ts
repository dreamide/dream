/**
 * Which client this is, and the platform services it runs on. Everything
 * that differs between the desktop app and a browser client is chosen
 * here, once, rather than each caller asking for `window.dream`:
 *
 *   desktop  the Electron preload's bridge: the launch token for the local
 *            API, the main process's workspace database, SSH launching
 *   web      a browser page served by a paired host: that host is its home
 *            host (`local`), its credential is the session cookie the host
 *            set, its workspace is in IndexedDB, and it launches no SSH
 *
 * There is no fake desktop bridge in the browser: code that needs a
 * desktop-only service gets `desktop: null` and does without.
 */
import type { DesktopApi, HostRoute } from "@/types/ide";
import {
  LOCAL_ROUTE,
  originRoute,
} from "../../../electron/shared/host-connections.js";
import { getDesktopApi } from "../electron";
import {
  createDesktopWorkspaceStorage,
  createIndexedDbWorkspaceStorage,
  type WorkspaceStorage,
} from "./workspace-storage";

export interface ClientPlatform {
  kind: "desktop" | "web";
  /** How this client reaches its home host, the `local` connection. */
  homeRoute: HostRoute;
  /** What to call the home host in messages. */
  homeLabel: string;
  /** Where this client's own workspace lives. */
  workspace: WorkspaceStorage;
  /** The desktop bridge; null in a browser. */
  desktop: DesktopApi | null;
}

let desktopStorage: { api: DesktopApi; storage: WorkspaceStorage } | null =
  null;
let webStorage: WorkspaceStorage | null = null;

/**
 * The platform this client runs on. Asked each time rather than fixed at
 * import: the development fixture page installs its bridge after modules
 * load.
 */
export const getClientPlatform = (): ClientPlatform => {
  const desktop = getDesktopApi();
  if (desktop) {
    if (desktopStorage?.api !== desktop) {
      desktopStorage = {
        api: desktop,
        storage: createDesktopWorkspaceStorage(desktop),
      };
    }
    return {
      desktop,
      homeLabel: "This computer",
      homeRoute: LOCAL_ROUTE as HostRoute,
      kind: "desktop",
      workspace: desktopStorage.storage,
    };
  }
  webStorage ??= createIndexedDbWorkspaceStorage();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return {
    desktop: null,
    homeLabel:
      typeof window === "undefined" ? "This host" : window.location.host,
    homeRoute: originRoute(origin) as HostRoute,
    kind: "web",
    workspace: webStorage,
  };
};
