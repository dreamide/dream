// The desktop's launch and quit with fake Electron parts, databases and
// hosts: a held workspace ends the launch, a failed workspace move shares
// the writer, host options are built once, and quit tears down in order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopLaunch } from "./desktop-launch.js";
import { StateLockedError } from "./host/state-lock.js";

const STATE_DB = "/data/dream.db";
const WORKSPACE_DB = "/data/dream.workspace.db";

const createFakes = ({ env = {}, moveFails = false, locked = false } = {}) => {
  const steps = [];
  const shown = [];
  const exits = [];
  const created = { attachments: [], hosts: [], queues: [], renderers: [] };
  // A home host (host/home-host.js) recording what the launch calls.
  const fakeHost = (mode) => ({
    mode,
    processSessions: {
      hasActiveSessions: () => false,
      stopAllProcesses: async () => {},
    },
    close: async () => steps.push("host.close"),
    listen: async (options) => steps.push(["host.listen", options]),
    startRemoteAccess: async () => steps.push("host.startRemoteAccess"),
  });
  const connections = {
    disconnectAll: async () => steps.push("connections.disconnectAll"),
    getEndpoint: (hostId) => ({ hostId }),
  };
  const ports = [5001, 5002];
  const launch = createDesktopLaunch({
    appName: "Dream",
    electron: {
      app: { isPackaged: false },
      dialog: { showErrorBox: (title, text) => shown.push({ text, title }) },
    },
    env,
    exit: (code) => exits.push(code),
    getConnections: () => connections,
    hosts: {
      createHomeHostAttachment: (options) => {
        created.attachments.push(options);
        return fakeHost("detached");
      },
      createHost: (options) => {
        created.hosts.push(options);
        return fakeHost("in-process");
      },
      withInProcessFallback: (options) => ({ ...options.attached, options }),
    },
    isDevelopment: false,
    paths: {
      appDir: "/app/electron",
      clientDirectory: "/app/dist",
      dataDirectory: "/data",
    },
    persistence: {
      acquireStateLock: (databasePath, options) => {
        steps.push(["lock", databasePath, options]);
        if (locked) {
          throw new StateLockedError(`${databasePath}.host-lock`, { pid: 42 });
        }
        return () => steps.push("lock.release");
      },
      closePersistedStateDatabase: () => steps.push("database.close"),
      configureHostDataDirectory: (directory) =>
        steps.push(["dataDirectory", directory]),
      createStateSaveQueue: ({ databasePath }) => {
        const queue = {
          databasePath,
          flushAndClose: async () => steps.push("queue.flushAndClose"),
          write: async (name, payload) =>
            steps.push(["queue.write", name, payload]),
        };
        created.queues.push(queue);
        return queue;
      },
      installIdConfigValue: (installId) => ({ key: "installId", installId }),
      prepareWorkspaceDatabase: ({ stateDatabasePath }) => {
        steps.push(["prepareWorkspace", stateDatabasePath]);
        if (moveFails) throw new Error("disk full");
        return {
          backupPath: null,
          migrated: false,
          workspaceDatabasePath: WORKSPACE_DB,
        };
      },
      readOrCreatePersistedInstallId: ({ databasePath }) => ({
        created: databasePath === WORKSPACE_DB,
        installId: "install-1",
      }),
      resolveStateDatabasePath: () => STATE_DB,
    },
    renderer: {
      createRendererServerManager: (options) => {
        let hostListening = null;
        const server = {
          getUrl: () => "http://127.0.0.1:5002",
          options,
          start: async () => {
            hostListening = options.startApi({
              apiToken: "token",
              port: options.apiServerPort,
            });
            steps.push("renderer.start");
          },
          stop: async () => steps.push("renderer.stop"),
          whenHostListening: () => hostListening,
        };
        created.renderers.push(server);
        return server;
      },
      getPort: async () => ports.shift(),
    },
    version: "1.2.3",
  });
  return { created, exits, launch, shown, steps };
};

describe("createDesktopLaunch", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends the launch when another desktop holds the workspace", () => {
    const { created, exits, launch, shown, steps } = createFakes({
      locked: true,
    });

    expect(launch.prepare()).toBeNull();

    expect(steps).toEqual([
      ["dataDirectory", "/data"],
      ["prepareWorkspace", STATE_DB],
      ["lock", WORKSPACE_DB, { kind: "desktop" }],
    ]);
    expect(shown).toEqual([
      {
        text: expect.stringContaining("(process 42)"),
        title: "Dream is already running",
      },
    ]);
    expect(exits).toEqual([1]);
    expect(created.queues).toEqual([]);
    expect(created.hosts).toEqual([]);
    expect(created.attachments).toEqual([]);
  });

  it("shares the writer with a host in this process when the workspace cannot move", () => {
    const { created, launch, steps } = createFakes({ moveFails: true });

    const prepared = launch.prepare();

    // No workspace lock: the in-process host takes the state lock.
    expect(steps.some((step) => step[0] === "lock")).toBe(false);
    expect(prepared.workspaceDatabasePath).toBe(STATE_DB);
    expect(created.queues.map((queue) => queue.databasePath)).toEqual([
      STATE_DB,
    ]);
    expect(created.attachments).toEqual([]);
    expect(created.hosts).toHaveLength(1);
    expect(created.hosts[0].kind).toBe("desktop");
    expect(created.hosts[0].getStateWriter()).toBe(prepared.saveQueue);
    expect(prepared.hostMode()).toBe("in-process");
  });

  it("builds the host options once for the home host and its in-process fallback", () => {
    const { created, launch } = createFakes();

    const prepared = launch.prepare();

    expect(created.queues.map((queue) => queue.databasePath)).toEqual([
      WORKSPACE_DB,
    ]);
    const [attachment] = created.attachments;
    expect(attachment).toEqual({
      clientDirectory: "/app/dist",
      dataDirectory: "/data",
      diagnosticsEnabled: true,
      resolveRemoteHost: expect.any(Function),
      stateDatabasePath: STATE_DB,
      version: "1.2.3",
    });
    expect(attachment.resolveRemoteHost("ssh-1")).toEqual({ hostId: "ssh-1" });
    expect(prepared.host.options).toMatchObject({
      fallBack: true,
      stateDatabasePath: STATE_DB,
    });
    expect(created.hosts).toEqual([]);
    expect(prepared.hostMode()).toBe("detached");

    // The fallback host gets the same options; the workspace moved out, so
    // it keeps a writer of its own.
    prepared.host.options.createInProcess();
    const { stateDatabasePath: _, ...shared } = attachment;
    expect(created.hosts).toEqual([{ ...shared, kind: "desktop" }]);
    expect(created.hosts[0].resolveRemoteHost).toBe(
      attachment.resolveRemoteHost,
    );
    prepared.host.mode = "in-process";
    expect(prepared.hostMode()).toBe("in-process");
  });

  it("starts the renderer server on two ports, then remote access, then saves a new install id", async () => {
    const { created, launch, steps } = createFakes();
    const prepared = launch.prepare();
    steps.length = 0;

    const { hostListening, rendererServer } = await launch.start();
    await hostListening;
    await Promise.resolve();

    expect(launch.rendererServer()).toBe(rendererServer);
    expect(created.renderers[0].options).toMatchObject({
      apiServerPort: 5001,
      appDir: "/app/electron",
      developmentRendererUrl: "http://127.0.0.1:5002",
      internalRendererPort: 5002,
      rendererProbeIntervalMs: 300,
      rendererStartupTimeoutMs: 45000,
    });
    expect(steps).toEqual([
      ["host.listen", { apiToken: "token", port: 5001 }],
      "renderer.start",
      "host.startRemoteAccess",
    ]);

    expect(launch.readInstallId()).toBe("install-1");
    expect(steps.at(-1)).toEqual([
      "queue.write",
      "config",
      { installId: "install-1", key: "installId" },
    ]);
    expect(prepared.saveQueue).toBe(created.queues[0]);
  });

  it("quits in order: host, connections, renderer server, save queue, database, lock", async () => {
    const { launch, steps } = createFakes();
    launch.prepare();
    await launch.start();
    steps.length = 0;

    await launch.quit();

    expect(steps).toEqual([
      "host.close",
      "connections.disconnectAll",
      "renderer.stop",
      "queue.flushAndClose",
      "database.close",
      "lock.release",
    ]);
  });

  it("stops the teardown at the first failing step, as before", async () => {
    const { launch, steps } = createFakes();
    const prepared = launch.prepare();
    prepared.host.close = async () => {
      throw new Error("host stuck");
    };

    await expect(launch.quit()).rejects.toThrow("host stuck");

    expect(steps).not.toContain("queue.flushAndClose");
    expect(steps).not.toContain("lock.release");
  });
});
