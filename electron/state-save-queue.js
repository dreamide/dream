// Coalescing queue in front of the persisted-state save worker.
//
// Workspace saves, transcripts, active-project updates and host catalog
// changes share one worker so their ordering is deterministic. Adjacent
// operations of the same kind are coalesced to the latest value, except
// catalog changes, which are deltas.
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

const saveStartIndex = (payload) =>
  Number.isInteger(payload?.fromIndex) && payload.fromIndex > 0
    ? payload.fromIndex
    : 0;

/**
 * One transcript save standing for `queued` followed by `next`, or null when
 * they cannot be one (different chats, or `next` starts past where `queued`
 * ends). A save replaces its chat's transcript from `fromIndex` on, so the
 * later one wins from its own start and the queued one keeps what it said
 * before that.
 */
export const mergeChatMessageSaves = (queued, next) => {
  if (
    queued?.chatId !== next?.chatId ||
    !Array.isArray(queued?.messages) ||
    !Array.isArray(next?.messages)
  ) {
    return null;
  }
  const queuedStart = saveStartIndex(queued);
  const nextStart = saveStartIndex(next);
  if (nextStart <= queuedStart) return next;
  const kept = nextStart - queuedStart;
  if (kept > queued.messages.length) return null;
  return {
    ...next,
    fromIndex: queuedStart,
    messages: [...queued.messages.slice(0, kept), ...next.messages],
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
  /** @type {Array<{ type: "save", state: any, resolvers: Array<{ resolve: (value: unknown) => void, reject: (error: Error) => void }> } | { type: "save-active-project" | "save-chat-messages", payload: any, resolvers: Array<{ resolve: (value: unknown) => void, reject: (error: Error) => void }> }>} */
  let pending = [];

  const failAll = (error) => {
    for (const entry of inFlight.values()) {
      entry.reject(error);
    }
    inFlight.clear();
    for (const operation of pending) {
      for (const resolver of operation.resolvers) {
        resolver.reject(error);
      }
    }
    pending = [];
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
    if (busy || pending.length === 0 || closed) {
      return;
    }

    const operation = pending.shift();
    if (!operation) {
      return;
    }
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
      const latest = pending.at(-1);
      if (latest?.type === "save") {
        // Supersede the queued snapshot; all waiters settle with the result
        // of the write that actually persists their (newer) data.
        latest.state = state;
        latest.resolvers.push({ resolve, reject });
      } else if (latest?.type === "save-active-project") {
        pending[pending.length - 1] = {
          type: "save",
          state,
          resolvers: [...latest.resolvers, { resolve, reject }],
        };
      } else {
        pending.push({
          type: "save",
          state,
          resolvers: [{ resolve, reject }],
        });
      }
      drain();
    });
  };

  const saveActiveProject = (payload) => {
    if (closed) {
      return Promise.reject(new Error("State save queue is closed."));
    }

    return new Promise((resolve, reject) => {
      const latest = pending.at(-1);
      if (latest?.type === "save") {
        latest.state = mergeActiveProjectIntoState(latest.state, payload);
        latest.resolvers.push({ resolve, reject });
      } else if (latest?.type === "save-active-project") {
        latest.payload = payload;
        latest.resolvers.push({ resolve, reject });
      } else {
        pending.push({
          type: "save-active-project",
          payload,
          resolvers: [{ resolve, reject }],
        });
      }
      drain();
    });
  };

  const saveChatMessages = (payload) => {
    if (closed) {
      return Promise.reject(new Error("State save queue is closed."));
    }

    return new Promise((resolve, reject) => {
      const latest = pending.at(-1);
      const merged =
        latest?.type === "save-chat-messages"
          ? mergeChatMessageSaves(latest.payload, payload)
          : null;
      if (merged) {
        latest.payload = merged;
        latest.resolvers.push({ resolve, reject });
      } else {
        pending.push({
          type: "save-chat-messages",
          payload,
          resolvers: [{ resolve, reject }],
        });
      }
      drain();
    });
  };

  // A catalog change set is a delta, so it is never coalesced: each one is
  // applied, in order with every other write.
  const applyCatalogChanges = (payload) => {
    if (closed) {
      return Promise.reject(new Error("State save queue is closed."));
    }

    return new Promise((resolve, reject) => {
      pending.push({
        type: "catalog-changes",
        payload,
        resolvers: [{ resolve, reject }],
      });
      drain();
    });
  };

  const flushAndClose = async () => {
    if (closed) {
      return;
    }

    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    while ((busy || pending.length > 0) && Date.now() < deadline) {
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

  return {
    save,
    saveActiveProject,
    saveChatMessages,
    applyCatalogChanges,
    flushAndClose,
  };
}
