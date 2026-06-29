// Worker thread that owns all persisted-state WRITES.
//
// The full-state save in persisted-state.js rewrites every project, chat, and
// chat message inside a synchronous SQLite transaction. Running that on the
// Electron main process blocked its event loop for hundreds of milliseconds
// per save (worse on Windows due to slower sync I/O and antivirus scanning),
// which delayed input-event delivery to every window — the source of the
// click-to-action lag. Running it here keeps the main thread free.
//
// The parent passes the resolved database path in workerData so persisted-state.js
// never needs the (unavailable) "electron" module.
import { parentPort, workerData } from "node:worker_threads";

import {
  closePersistedStateDatabase,
  savePersistedState,
} from "./persisted-state.js";

if (!parentPort) {
  throw new Error("persisted-state-worker must be run as a worker thread.");
}

const databasePath =
  typeof workerData?.databasePath === "string" ? workerData.databasePath : null;

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  const { id, type } = message;

  try {
    if (type === "save") {
      const result = savePersistedState(message.state, { databasePath });
      parentPort.postMessage({ id, ok: true, result });
      return;
    }

    if (type === "close") {
      closePersistedStateDatabase();
      parentPort.postMessage({ id, ok: true, result: true });
      return;
    }

    parentPort.postMessage({
      id,
      ok: false,
      error: `Unknown message type: ${String(type)}`,
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
