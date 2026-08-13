// Worker thread that owns all persisted-state WRITES.
//
// Metadata snapshots and dirty-chat message upserts use synchronous SQLite
// transactions. Running them here keeps the Electron main thread free even
// when a completed transcript contains large tool payloads.
//
// The parent passes the resolved database path in workerData so persisted-state.js
// never needs the (unavailable) "electron" module.
import { parentPort, workerData } from "node:worker_threads";

import {
  closePersistedStateDatabase,
  savePersistedActiveProject,
  savePersistedChatMessages,
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

    if (type === "save-active-project") {
      const result = savePersistedActiveProject(message.payload, {
        databasePath,
      });
      parentPort.postMessage({ id, ok: true, result });
      return;
    }

    if (type === "save-chat-messages") {
      const result = savePersistedChatMessages(message.payload, {
        databasePath,
      });
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
