/**
 * Removing a browser client's connection to its home host: what "sign out
 * of this host" does, as opposed to a temporary disconnect.
 *
 *   - The session ends on the host (it clears the HttpOnly cookie this page
 *     cannot touch), so the credential is gone even if this device is not.
 *   - The client's own workspace (IndexedDB: layout, drafts, cached project
 *     rows) is cleared, and the host socket closed.
 *
 * A temporary disconnect does none of this: drafts and cached rows stay
 * readable until the host is back. The desktop's SSH hosts are removed by
 * the store (host-actions.ts removeSshHost), whose credentials live in the
 * main process. Reloading the page afterwards is the caller's choice, and
 * drops what the page holds in memory (transcripts, caches).
 */

import { HOST_ROUTES } from "../../../electron/shared/host-routes.js";
import { LOCAL_HOST_ID } from "../host-routing";
import { forgetHostSocketClient } from "../host-socket";
import { hostFetch } from "./host-endpoint";
import { getClientPlatform } from "./platform";
import { connectionSupervisor } from "./runtime";

/**
 * Signs this browser client out of its home host and clears what it kept.
 * Resolves with whether the host confirmed the sign-out; local data is
 * cleared either way (an unreachable host cannot keep this device signed
 * in once its session expires, and the user asked to forget it).
 */
export const forgetHomeConnection = async (): Promise<boolean> => {
  const platform = getClientPlatform();
  if (platform.kind !== "web") {
    throw new Error("Only a browser client signs out of its home host.");
  }
  let confirmed = false;
  try {
    const { method, path } = HOST_ROUTES.remoteSessionEnd;
    const response = await hostFetch(LOCAL_HOST_ID, path, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method,
    });
    confirmed = response.ok;
  } catch {
    // Unreachable: cleared locally all the same.
  }
  forgetHostSocketClient(LOCAL_HOST_ID);
  await platform.workspace.clear();
  connectionSupervisor.forget(LOCAL_HOST_ID);
  connectionSupervisor.set(LOCAL_HOST_ID, "unauthorized", null);
  return confirmed;
};
