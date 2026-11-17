// What a remote access status means to its readers (the settings view and
// `dream-host remote`): where it is, the address to show, the start-up
// options that lock it, and whether its saved settings can be turned on.
// A host answers these itself (host/remote-access/remote-access.js). A host
// older than those fields does not, so they are derived here from the
// fields it did send; nothing else derives them.

/** @typedef {"off" | "checking" | "ready" | "notReady"} RemoteAccessPhase */

/**
 * @param {{
 *   enabled: boolean,
 *   ready: boolean,
 *   mode: string,
 *   origin: string | null,
 *   requestedOrigin: string | null,
 *   problem: { refused?: boolean } | null,
 *   override?: { sources: Record<string, string> },
 *   configured?: boolean,
 *   phase?: RemoteAccessPhase,
 *   address?: string | null,
 *   lockedBy?: string[] | null,
 * }} status
 * @returns {{
 *   phase: RemoteAccessPhase,
 *   address: string | null,
 *   lockedBy: string[] | null,
 *   configured: boolean,
 * }}
 */
export const readRemoteAccess = (status) => {
  // A host older than `configured` was set up if it is on.
  const configured = status.configured ?? status.enabled;
  if (status.phase) {
    return {
      phase: status.phase,
      address: status.address ?? null,
      lockedBy: status.lockedBy ?? null,
      configured,
    };
  }
  const sources = Object.values(status.override?.sources ?? {});
  return {
    phase: !status.enabled
      ? "off"
      : status.ready
        ? "ready"
        : status.problem && !status.problem.refused
          ? "notReady"
          : "checking",
    address: (status.ready ? status.origin : status.requestedOrigin) ?? null,
    lockedBy:
      status.mode === "proxy"
        ? sources.length
          ? sources
          : ["--remote-port"]
        : null,
    configured,
  };
};
