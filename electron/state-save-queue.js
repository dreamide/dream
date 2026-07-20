// Coalescing queue in front of the persisted-state save worker.
//
// Full-state saves and lightweight active-project updates share one worker so
// their ordering is deterministic. Adjacent operations are coalesced to the
// latest value, which bounds the backlog during chat streaming and rapid tab
// switching.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "persisted-state-worker.js");
const FLUSH_TIMEOUT_MS = 5000;

const mergeActiveProjectIntoState = (state, payload) => {
  if (!state || typeof state !== "object") {
    return state;
  }

  const activeProjectId =
    typeof payload?.activeProjectId === "string"
      ? payload.activeProjectId
      : null;
  const lastUsedAt =
    typeof payload?.lastUsedAt === "string" ? payload.lastUsedAt : null;
  const projects =
    activeProjectId && lastUsedAt && Array.isArray(state.projects)
      ? state.projects.map((project) =>
          project?.id === activeProjectId
            ? {
                ...project,
                lastUsedAt,
              }
            : project,
        )
      : state.projects;

  return {
    ...state,
    activeProjectId,
    projects,
  };
};

export function createStateSaveQueue({ databasePath }) {
  /** @type {Worker | null} */
  let worker = null;
  let nextMessageId = 1;
  let busy = false;
  let closed = false;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const inFlight = new Map();
  /** @type {({ type: "save", state: any, resolvers: Array<{ resolve: (value: unknown) => void, reject: (error: Error) => void }> } | { type: "save-active-project", payload: any, resolvers: Array<{ resolve: (value: unknown) => void, reject: (error: Error) => void }> }) | null} */
  let pending = null;

  const failAll = (error) => {
    for (const entry of inFlight.values()) {
      entry.reject(error);
    }
    inFlight.clear();
    if (pending) {
      for (const resolver of pending.resolvers) {
        resolver.reject(error);
      }
      pending = null;
    }
    busy = false;
  };

  const ensureWorker = () => {
    if (worker) {
      return worker;
    }

    worker = new Worker(WORKER_PATH, {
      workerData: { databasePath },
    });

    worker.on("message", (message) => {
      const entry = inFlight.get(message?.id);
      if (entry) {
        inFlight.delete(message.id);
        if (message.ok) {
          entry.resolve(message.result ?? true);
        } else {
          entry.reject(new Error(message.error || "State save failed."));
        }
      }
      busy = false;
      drain();
    });

    worker.on("error", (error) => {
      worker = null;
      failAll(error instanceof Error ? error : new Error(String(error)));
    });

    worker.on("exit", (code) => {
      worker = null;
      if (code !== 0) {
        failAll(new Error(`State save worker exited with code ${code}.`));
      }
    });

    return worker;
  };

  const drain = () => {
    if (busy || !pending || closed) {
      return;
    }

    const operation = pending;
    pending = null;
    busy = true;

    const id = nextMessageId++;
    inFlight.set(id, {
      resolve: (value) => {
        for (const resolver of operation.resolvers) {
          resolver.resolve(value);
        }
      },
      reject: (error) => {
        for (const resolver of operation.resolvers) {
          resolver.reject(error);
        }
      },
    });

    try {
      ensureWorker().postMessage(
        operation.type === "save"
          ? { id, type: operation.type, state: operation.state }
          : { id, type: operation.type, payload: operation.payload },
      );
    } catch (error) {
      inFlight.delete(id);
      busy = false;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const resolver of operation.resolvers) {
        resolver.reject(failure);
      }
    }
  };

  const save = (state) => {
    if (closed) {
      return Promise.reject(new Error("State save queue is closed."));
    }

    return new Promise((resolve, reject) => {
      if (pending?.type === "save") {
        // Supersede the queued snapshot; all waiters settle with the result
        // of the write that actually persists their (newer) data.
        pending.state = state;
        pending.resolvers.push({ resolve, reject });
      } else if (pending?.type === "save-active-project") {
        pending = {
          type: "save",
          state,
          resolvers: [...pending.resolvers, { resolve, reject }],
        };
      } else {
        pending = {
          type: "save",
          state,
          resolvers: [{ resolve, reject }],
        };
      }
      drain();
    });
  };

  const saveActiveProject = (payload) => {
    if (closed) {
      return Promise.reject(new Error("State save queue is closed."));
    }

    return new Promise((resolve, reject) => {
      if (pending?.type === "save") {
        pending.state = mergeActiveProjectIntoState(pending.state, payload);
        pending.resolvers.push({ resolve, reject });
      } else if (pending?.type === "save-active-project") {
        pending.payload = payload;
        pending.resolvers.push({ resolve, reject });
      } else {
        pending = {
          type: "save-active-project",
          payload,
          resolvers: [{ resolve, reject }],
        };
      }
      drain();
    });
  };

  const flushAndClose = async () => {
    if (closed) {
      return;
    }

    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    while ((busy || pending) && Date.now() < deadline) {
      drain();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    closed = true;

    const activeWorker = worker;
    worker = null;
    if (activeWorker) {
      try {
        await new Promise((resolve) => {
          const id = nextMessageId++;
          inFlight.set(id, { resolve, reject: resolve });
          activeWorker.postMessage({ id, type: "close" });
          setTimeout(resolve, 1000);
        });
      } finally {
        await activeWorker.terminate();
      }
    }
  };

  return { save, saveActiveProject, flushAndClose };
}
