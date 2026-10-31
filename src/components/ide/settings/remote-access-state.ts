/** Accepted Remote access state. Polls and mutations share one request lifetime. */
import {
  type ApiClient,
  type ApiRequestOf,
  apiClient,
  type RemoteAccessStatus,
  type RemoteDeviceSession,
  type RemotePairing,
} from "@/lib/api-client";

interface RemoteAccessSnapshot {
  status: RemoteAccessStatus | null;
  /** Seeds form drafts once; later polls cannot overwrite the operator's edits. */
  initialStatus: RemoteAccessStatus | null;
  devices: RemoteDeviceSession[];
  pairing: RemotePairing | null;
  busy: boolean;
  error: { kind: "load" | "change" | "pair"; cause: unknown } | null;
}

type RemoteAccessClient = Pick<
  ApiClient,
  | "remoteAccess"
  | "remoteAccessEnable"
  | "remoteAccessDisable"
  | "remoteAccessCheck"
  | "remoteSessions"
  | "remoteSessionRevoke"
  | "remotePairingCreate"
>;

const REMOTE_ACCESS_METHODS = [
  "remoteAccess",
  "remoteAccessEnable",
  "remoteAccessDisable",
  "remoteAccessCheck",
  "remoteSessions",
  "remoteSessionRevoke",
  "remotePairingCreate",
] as const satisfies readonly (keyof RemoteAccessClient)[];

/** The app's client with every remote access request sent to `hostId`. */
export const bindRemoteAccessClient = (
  hostId: string,
  api: ApiClient = apiClient,
): RemoteAccessClient =>
  Object.fromEntries(
    REMOTE_ACCESS_METHODS.map((name) => [
      name,
      (request: unknown, options?: { signal?: AbortSignal }) =>
        (api[name] as (request: unknown, options?: object) => Promise<unknown>)(
          request,
          { ...options, hostId },
        ),
    ]),
  ) as unknown as RemoteAccessClient;

export const createRemoteAccessState = ({
  api = apiClient,
  pollMs = 3_000,
}: {
  api?: RemoteAccessClient;
  pollMs?: number;
} = {}) => {
  let snapshot: RemoteAccessSnapshot = {
    status: null,
    initialStatus: null,
    devices: [],
    pairing: null,
    busy: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let active = false;
  let generation = 0;
  let readId = 0;
  let pairingId = 0;
  let mutation: symbol | null = null;
  let reading: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = (patch: Partial<RemoteAccessSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    snapshot.initialStatus ??= snapshot.status;
    for (const listener of listeners) listener();
  };
  const invalidateRead = () => {
    readId += 1;
    reading?.abort();
    reading = null;
    clearTimeout(timer);
    timer = undefined;
  };

  const refresh = async () => {
    if (!active || mutation) return;
    invalidateRead();
    const id = readId;
    const era = generation;
    const controller = new AbortController();
    reading = controller;
    const options = { signal: controller.signal };
    const [status, sessions] = await Promise.allSettled([
      api.remoteAccess({}, options),
      api.remoteSessions({}, options),
    ]);
    if (!active || era !== generation || id !== readId) return;
    reading = null;
    const patch: Partial<RemoteAccessSnapshot> = {};
    if (status.status === "fulfilled") {
      patch.status = status.value;
      if (snapshot.error?.kind === "load") patch.error = null;
    } else if (snapshot.status === null) {
      patch.error = { kind: "load", cause: status.reason };
    }
    if (sessions.status === "fulfilled")
      patch.devices = sessions.value.sessions.filter(
        (session) => !session.revokedAt,
      );
    publish(patch);
    // Poll after settlement: a slow host never accumulates overlapping polls.
    if (active && era === generation && id === readId && !mutation)
      timer = setTimeout(() => {
        void refresh();
      }, pollMs);
  };

  const write = async (
    kind: "change" | "pair",
    work: () => Promise<Partial<RemoteAccessSnapshot>>,
  ): Promise<boolean> => {
    if (!active || mutation) return false;
    const token = Symbol();
    const era = generation;
    mutation = token;
    invalidateRead();
    publish({ busy: true, error: null });
    const current = () => active && generation === era && mutation === token;
    try {
      const result = await work();
      if (!current()) return false;
      publish(result);
      return true;
    } catch (cause) {
      if (current()) publish({ error: { kind, cause } });
      return false;
    } finally {
      if (current()) {
        mutation = null;
        publish({ busy: false });
        void refresh();
      }
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (active) return;
      active = true;
      void refresh();
    },
    stop() {
      active = false;
      generation += 1;
      pairingId += 1;
      mutation = null;
      invalidateRead();
      publish({ busy: false, pairing: null });
    },
    refresh,
    enable: (options: ApiRequestOf<"remoteAccessEnable">) =>
      write("change", async () => ({
        status: await api.remoteAccessEnable(options),
      })),
    disable: () =>
      write("change", async () => ({
        status: await api.remoteAccessDisable({}),
      })),
    check: () =>
      write("change", async () => ({
        status: await api.remoteAccessCheck({}),
      })),
    createPairing(scopes: string[]) {
      const id = pairingId;
      return write("pair", async () => {
        const pairing = await api.remotePairingCreate({ scopes });
        return id === pairingId ? { pairing } : {};
      });
    },
    clearPairing() {
      pairingId += 1;
      publish({ pairing: null });
    },
    revoke: (sessionId: string) =>
      write("change", async () => {
        await api.remoteSessionRevoke({ sessionId });
        return {
          devices: snapshot.devices.filter((device) => device.id !== sessionId),
        };
      }),
  };
};
