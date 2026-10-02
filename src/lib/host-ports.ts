/**
 * The browser panel and SSH hosts: a dev server on an SSH host listens on
 * that host's `localhost`, which this machine cannot reach. For a project
 * on an SSH host, a loopback URL (`localhost:3000`) is loaded through a port
 * forward instead (`127.0.0.1:<local port>`, set up by main over the host's
 * connection), while the tab keeps showing the host's own URL. Navigations
 * the page makes are mapped back the same way.
 */
import { getDesktopApi } from "./electron";

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

/** host:remotePort -> local port, and back. */
const localPortByRemote = new Map<string, number>();
const remoteByLocalPort = new Map<number, { hostId: string; port: number }>();
const pending = new Map<string, Promise<number>>();

const parse = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const portOf = (url: URL) =>
  url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? null);

/** Whether `url` points at the machine it is loaded on. */
export const isLoopbackUrl = (url: string) => {
  const parsed = parse(url);
  return Boolean(
    parsed &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      LOOPBACK_HOSTS.has(parsed.hostname),
  );
};

const forward = (hostId: string, port: number) => {
  const key = `${hostId}:${port}`;
  const known = localPortByRemote.get(key);
  if (known !== undefined) return Promise.resolve(known);
  let request = pending.get(key);
  if (!request) {
    const desktopApi = getDesktopApi();
    request = desktopApi
      ? desktopApi.forwardHostPort(hostId, port).then((localPort) => {
          localPortByRemote.set(key, localPort);
          remoteByLocalPort.set(localPort, { hostId, port });
          return localPort;
        })
      : Promise.reject(new Error("Port forwarding needs the desktop app."));
    request = request.finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
};

/**
 * The URL to load for a project on `hostId`: a loopback URL through its
 * port forward; anything else (and any URL of a local project) unchanged.
 */
export const toLoadableUrl = async (
  hostId: string | undefined,
  url: string,
): Promise<string> => {
  if (!hostId || !isLoopbackUrl(url)) return url;
  const parsed = parse(url);
  const port = parsed ? portOf(parsed) : null;
  if (!parsed || port === null) return url;
  const localPort = await forward(hostId, port);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(localPort);
  return parsed.toString();
};

/**
 * `text` with every forwarded origin of `hostId` (`http://127.0.0.1:<local
 * port>`) written as the host sees it (`http://localhost:<port>`), for what
 * a browser tool reports back to an agent on that host.
 */
export const fromLoadedText = (hostId: string, text: string): string =>
  text.replace(
    /(https?:\/\/)127\.0\.0\.1:(\d+)/g,
    (match, scheme: string, port: string) => {
      const remote = remoteByLocalPort.get(Number(port));
      return remote && remote.hostId === hostId
        ? `${scheme}localhost:${remote.port}`
        : match;
    },
  );

/** A forwarded URL as the host sees it (for the tab and the address bar). */
export const fromLoadedUrl = (url: string): string => {
  const parsed = parse(url);
  if (!parsed || parsed.hostname !== "127.0.0.1") return url;
  const remote = remoteByLocalPort.get(Number(parsed.port));
  if (!remote) return url;
  parsed.hostname = "localhost";
  parsed.port = String(remote.port);
  return parsed.toString();
};
