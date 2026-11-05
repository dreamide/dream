/**
 * The client's connection runtime: its one supervisor, started once at
 * startup. A browser client's home host is judged by its own requests and
 * probed whenever the page comes back; a desktop's hosts are judged by
 * their owners (the in-process local host is ready while the app runs; an
 * SSH host follows the main process's status events, host-actions.ts).
 */
import { LOCAL_HOST_ID } from "../host-routing";
import { getClientPlatform } from "./platform";
import { createConnectionRecovery } from "./recovery";
import { createConnectionSupervisor, createPageLifecycle } from "./supervisor";

export const connectionSupervisor = createConnectionSupervisor();
export const connectionRecovery =
  createConnectionRecovery(connectionSupervisor);

let started = false;

/**
 * Starts following the page's lifecycle. `probeHome` asks the home host
 * whether this client's credential is still good (a browser client's
 * session); its outcome is reported like any request's.
 */
export const startConnectionRuntime = ({
  probeHome,
}: {
  probeHome: () => Promise<unknown>;
}) => {
  if (started || typeof window === "undefined") return;
  started = true;
  const platform = getClientPlatform();
  if (platform.kind === "desktop") {
    connectionSupervisor.set(LOCAL_HOST_ID, "ready");
  } else {
    connectionSupervisor.judgeByRequests(LOCAL_HOST_ID);
  }
  connectionRecovery.start({
    lifecycle: createPageLifecycle(),
    probeHome: platform.kind === "web" ? probeHome : undefined,
  });
};
