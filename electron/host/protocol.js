// What a client checks before talking to a host. The app version only names
// the folder a host runtime is installed in; compatibility is this integer
// plus the capabilities. Bump the version for a change an older client or
// host cannot handle; add a capability for one it can simply ignore.
//
// Pure (no Node built-ins): the renderer checks a host descriptor with it too.

export const HOST_PROTOCOL_VERSION = 1;

/**
 * `host-socket`: the multiplexed host socket.
 * `host-identity`: host-info and the catalog name the host's persistent
 * identity (`hostId`, `fingerprint`); older hosts do not.
 * `terminal-discovery`: a fresh client can discover surviving terminals.
 */
export const HOST_CAPABILITIES = Object.freeze([
  "host-socket",
  "host-identity",
  "terminal-discovery",
]);

/** The host protocol versions this app can talk to, as a client. */
export const SUPPORTED_HOST_PROTOCOLS = Object.freeze({ min: 1, max: 1 });

/**
 * Why this app cannot talk to a host speaking `version`, as something the
 * user can act on, or null when it can.
 * @param {unknown} version
 * @returns {string | null}
 */
export function hostProtocolProblem(version) {
  const supported =
    SUPPORTED_HOST_PROTOCOLS.min === SUPPORTED_HOST_PROTOCOLS.max
      ? `${SUPPORTED_HOST_PROTOCOLS.min}`
      : `${SUPPORTED_HOST_PROTOCOLS.min}–${SUPPORTED_HOST_PROTOCOLS.max}`;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return "The host did not say which protocol it speaks. Update dream-host there.";
  }
  if (version > SUPPORTED_HOST_PROTOCOLS.max) {
    return `The host speaks protocol ${version}, newer than this app supports (${supported}). Update Dream on this computer.`;
  }
  if (version < SUPPORTED_HOST_PROTOCOLS.min) {
    return `The host speaks protocol ${version}, older than this app supports (${supported}). Update dream-host there.`;
  }
  return null;
}
