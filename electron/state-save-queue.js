// The queue in front of the persisted-state save worker: the one writer of
// a state database.
//
// Every write (state-writes.js) goes through it by name, and the worker
// (persisted-state-worker.js) holds the only connection that writes the
// database, so writes run in the order they were queued and no thread that
// serves the UI waits on a write lock. A write the table says may merge
// (adjacent transcript saves of one chat) is merged with the same write
// queued just before it; everything else is a delta and runs as sent.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { findStateWrite } from "./state-writes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "persisted-state-worker.js");
const FLUSH_TIMEOUT_MS = 5000;

/**
 * What writes a state database, for everything that writes one: the host's
 * catalog (host/catalog.js), its device sessions (host/auth/host-auth.js)
 * and the desktop's workspace. A save queue is one; a desktop sharing its
 * database with its in-process host hands the host its own.
 * @typedef {object} StateWriter
 * @property {(name: string, payload: unknown) => Promise<any>} write
 *   Runs the write `name` (state-writes.js), after every write queued
 *   before it.
 * @property {() => Promise<unknown>} ready Settles once the database exists
 *   and is migrated: what a reader on another thread waits for.
 * @property {() => Promise<unknown>} settled Settles once every write
 *   queued before it has.
 */

export function createStateSaveQueue({ databasePath }) {
  /** @type {Worker | null} */
  let worker = null;
  let nextMessageId = 1;
  let busy = false;
  let closed = false;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const inFlight = new Map();
  /** @type {Array<{ type: string, name?: string, payload: any, resolvers: Array<{ resolve: (value: unknown) => void, reject: (error: Error) => void }> }>} */
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
          // A void operation resolves true; a null result (an empty queue
          // claim) is an answer and must reach the caller as null.
          entry.resolve(message.result === undefined ? true : message.result);
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
      ensureWorker().postMessage({
        id,
        name: operation.name,
        payload: operation.payload,
        type: operation.type,
      });
    } catch (error) {
      inFlight.delete(id);
      busy = false;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const resolver of operation.resolvers) {
        resolver.reject(failure);
      }
    }
  };

  /** Queues one message for the worker, never merged with another. */
  const enqueue = (type, payload) => {
    if (closed) {
      return Promise.reject(new Error("State save queue is closed."));
    }

    return new Promise((resolve, reject) => {
      pending.push({ type, payload, resolvers: [{ resolve, reject }] });
      drain();
    });
  };

  /**
   * Queues the write `name` (state-writes.js), merged with the same write
   * queued just before it where the write says it may be.
   */
  const write = (name, payload) => {
    if (closed) {
      return Promise.reject(new Error("State save queue is closed."));
    }
    const stateWrite = findStateWrite(name);
    if (!stateWrite) {
      return Promise.reject(new Error(`Unknown state write: ${String(name)}`));
    }

    return new Promise((resolve, reject) => {
      const latest = pending.at(-1);
      const merged =
        stateWrite.coalesce && latest?.type === "write" && latest.name === name
          ? stateWrite.coalesce(latest.payload, payload)
          : null;
      if (merged) {
        latest.payload = merged;
        latest.resolvers.push({ resolve, reject });
      } else {
        pending.push({
          name,
          payload,
          resolvers: [{ resolve, reject }],
          type: "write",
        });
      }
      drain();
    });
  };

  // The workspace as stored, read by the worker after every write queued
  // before it (a reloaded window sees what the old one saved).
  const loadWorkspace = () => enqueue("load-workspace", null);

  // Settles once the worker has opened (created and migrated) the database:
  // what readers on other threads wait for before opening it themselves.
  let opened = null;
  const ready = () => {
    opened ??= enqueue("open", null).catch((error) => {
      opened = null;
      throw error;
    });
    return opened;
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
    write,
    ready,
    /**
     * Settles once every write queued before it has: what a read that must
     * see them (a catalog load after a window's last saves) waits for.
     */
    settled: () => enqueue("open", null),
    loadWorkspace,
    flushAndClose,
  };
}
