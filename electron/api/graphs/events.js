/**
 * In-process event bus for graph run activity. The Electron main process
 * subscribes and forwards events to the renderer over IPC (`graph:event`).
 * Events are lossy across renderer reloads by design; the renderer always
 * rehydrates run state from the database on mount.
 */

const listeners = new Set();

export const GRAPH_EVENT_TYPES = [
  "graph.run.started",
  "graph.run.completed",
  "graph.run.failed",
  "graph.run.cancelled",
  "graph.node.started",
  "graph.node.completed",
  "graph.node.failed",
  "graph.edge.traversed",
];

export const subscribeGraphEvents = (listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const emitGraphEvent = (event) => {
  const payload = { timestamp: new Date().toISOString(), ...event };
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      console.error("[graphs] event listener failed:", error);
    }
  }
  return payload;
};
