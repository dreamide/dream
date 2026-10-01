// What a client checks before talking to a host. The app version only names
// the folder a host runtime is installed in; compatibility is this integer
// plus the capabilities. Bump the version for a change an older client or
// host cannot handle; add a capability for one it can simply ignore.

export const HOST_PROTOCOL_VERSION = 1;

export const HOST_CAPABILITIES = Object.freeze(["host-socket"]);

/** The host protocol versions this app can talk to, as a client. */
export const SUPPORTED_HOST_PROTOCOLS = Object.freeze({ min: 1, max: 1 });
