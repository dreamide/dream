// What a host reports about itself for Settings (POST /api/host/settings):
// who it is, and every option it runs with (host/options.js) with where the
// value came from. A client shows an option set by a flag or environment
// variable as read-only, names that flag or variable, and offers to change
// only what a client can change.
//
// Remote access is the one option group a client can change, through the
// saved setting: its options report `saved` unless the host was started
// with them (`--remote-port` and friends), which fixes them for the life
// of the process.
//
// No option changes while the host runs, so nothing is ever pending a
// restart today; `pendingRestart` is there for one that will.
import { HOST_OPTIONS } from "./options.js";

const REMOTE_OPTIONS = new Set([
  "remotePort",
  "remoteOrigins",
  "trustForwardedHost",
]);

/**
 * @param {{
 *   access: ReturnType<ReturnType<typeof import("./remote-access/remote-access.js").createRemoteAccess>["status"]>,
 *   descriptor: { hostId: string, fingerprint?: string },
 *   launch: { options: Record<string, any>, sources: Record<string, string>, from: Record<string, string | null> },
 *   localPort: number | null,
 *   name: string,
 *   pid: number,
 *   startedAt: string,
 *   version: string | null,
 * }} input
 */
export function describeHostSettings({
  access,
  descriptor,
  launch,
  localPort,
  name,
  pid,
  startedAt,
  version,
}) {
  const overridden = access.mode === "proxy";
  const settings = HOST_OPTIONS.map((option) => {
    let value =
      // The port actually serving, where 0 asked for any free one.
      option.name === "remotePort" && overridden && access.port
        ? access.port
        : launch.options[option.name];
    let source = launch.sources[option.name];
    let from = launch.from?.[option.name] ?? null;
    if (REMOTE_OPTIONS.has(option.name) && !overridden) {
      // Not set at start: remote access as the host saved it.
      source = "saved";
      from = null;
      value =
        option.name === "remotePort"
          ? access.enabled
            ? access.port
            : null
          : option.name === "remoteOrigins"
            ? access.enabled && access.origin
              ? [access.origin]
              : []
            : access.enabled;
    }
    return {
      editable: REMOTE_OPTIONS.has(option.name) && !overridden,
      env: option.env,
      flag: `--${option.flag}`,
      from,
      name: option.name,
      pendingRestart: false,
      source,
      value,
    };
  });
  return {
    host: {
      fingerprint: descriptor.fingerprint ?? null,
      hostId: descriptor.hostId,
      local: localPort ? `http://127.0.0.1:${localPort}` : null,
      name,
      owner: launch.options.owner,
      pid,
      remote: access.origin ?? null,
      startedAt,
      version,
    },
    settings,
  };
}
