// Worker thread that owns all persisted-state WRITES.
//
// Every write (state-writes.js) runs here, on the one connection that writes
// the database, as a synchronous SQLite transaction. Running them here keeps
// the Electron main thread free even when a completed transcript contains
// large tool payloads.
//
// The parent passes the resolved database path in workerData so persisted-state.js
// never needs the (unavailable) "electron" module.
import { parentPort, workerData } from "node:worker_threads";
import {
  closePersistedStateDatabase,
  getPersistedStateDatabase,
  loadPersistedState,
} from "./persisted-state.js";
import { runStateWrite } from "./state-writes.js";

if (!parentPort) {
  throw new Error("persisted-state-worker must be run as a worker thread.");
}

const databasePath =
  typeof workerData?.databasePath === "string" ? workerData.databasePath : null;
const options = { databasePath };

/**
 * What the save queue (state-save-queue.js) sends besides writes. A new
 * write is a row in state-writes.js, not a message here.
 */
const controls = {
  /** Runs a write by its name (state-writes.js). */
  write: ({ name, payload }) =>
    runStateWrite(getPersistedStateDatabase(options), name, payload),
  // Opens (creating and migrating) the database, so readers on other
  // threads can open it after.
  open: () => {
    getPersistedStateDatabase(options);
    return true;
  },
  // A read, run here so the main thread never waits on SQLite, and in turn
  // with the writes queued before it.
  "load-workspace": () => loadPersistedState(options),
  close: () => {
    closePersistedStateDatabase();
    return true;
  },
};

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  const { id, type } = message;
  const control = Object.hasOwn(controls, type) ? controls[type] : null;
  if (!control) {
    parentPort.postMessage({
      id,
      ok: false,
      error: `Unknown message type: ${String(type)}`,
    });
    return;
  }

  try {
    parentPort.postMessage({
      id,
      ok: true,
      result: control(message),
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
