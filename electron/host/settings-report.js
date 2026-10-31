// What a host reports about itself for Settings (POST /api/host/settings):
// who it is, its version, who started it and where it is reached. The
// options it runs with are documented (docs/host-service.md), not shown;
// remote access reports for itself whether the host's start options fix it
// (remote-access.js, `mode: "proxy"`).

/**
 * @param {{
 *   access: { origin?: string | null },
 *   descriptor: { hostId: string, fingerprint?: string },
 *   owner: "user" | "desktop",
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
  owner,
  localPort,
  name,
  pid,
  startedAt,
  version,
}) {
  return {
    host: {
      fingerprint: descriptor.fingerprint ?? null,
      hostId: descriptor.hostId,
      local: localPort ? `http://127.0.0.1:${localPort}` : null,
      name,
      owner,
      pid,
      remote: access.origin ?? null,
      startedAt,
      version,
    },
  };
}
