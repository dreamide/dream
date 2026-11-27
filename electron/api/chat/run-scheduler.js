// The host owns dispatch; clients submit durable intent and observe streams.
import { randomUUID } from "node:crypto";
export function createRunScheduler({ catalog, turns, execute }) {
  let ready;
  let closed = false;
  let delegation;
  const workers = new Map();
  // SQLite owns Pause. These guards cover only the gap between a durable
  // claim and starting its turn, and Stop's work on live descendants.
  const claiming = new Set();
  const pendingHolds = new Map();
  const initialize = () =>
    (ready ??= catalog.mutateRunQueue({ type: "recover" }));
  const change = (chatId, id, status, error) =>
    catalog.mutateRunQueue({ type: "status", chatId, id, status, error });
  // Only Stop and host shutdown abort a turn. A stopped turn is finished
  // business; one cut off by shutdown is interrupted and waits for review.
  const ended = (chatId, id) =>
    closed
      ? change(chatId, id, "interrupted")
      : change(chatId, id, "cancelled", "Stopped.");

  const drain = (chatId) => {
    if (closed || workers.has(chatId) || pendingHolds.has(chatId)) return;
    const worker = (async () => {
      await initialize();
      while (!closed && !pendingHolds.has(chatId) && !turns.isRunning(chatId)) {
        claiming.add(chatId);
        const run = await catalog.mutateRunQueue({ type: "claim", chatId });
        const mayStart = claiming.delete(chatId);
        if (!run) return;
        if (closed || !mayStart) {
          // Held while claiming: it never started, so it goes back in line.
          await change(chatId, run.id, "queued");
          return;
        }
        let status = "running";
        let scope;
        try {
          const ending = await turns.run({
            chatId,
            run: async (signal) => {
              scope = delegation?.open(run, signal);
              const chat = await catalog.getChat(chatId);
              if (!chat || chat.deletedAt)
                throw new Error("Chat no longer exists.");
              const messages = JSON.parse(
                await catalog.getTranscriptJson(chatId),
              );
              // An explicitly retried interrupted run already has its user message.
              if (
                !messages.some(
                  (message) => message.id === run.request.message.id,
                )
              )
                messages.push(run.request.message);
              else if (messages.at(-1)?.id !== run.request.message.id)
                messages.push({ ...run.request.message, id: randomUUID() });
              // Only the submission is new: the rows before it were just read.
              const submitted = messages.length - 1;
              if (
                !(await catalog.saveTranscript(
                  chatId,
                  messages.slice(submitted),
                  { fromIndex: submitted, origin: "host" },
                ))
              )
                throw new Error("Unable to save submission.");
              return execute(
                {
                  ...run.request,
                  chatId,
                  messages,
                },
                {
                  catalog,
                  // Saved above: the turn writes only its own message.
                  requestSaved: true,
                  signal,
                  orchestration: scope,
                  onChunk: async (chunk) => {
                    const next =
                      chunk.type === "tool-approval-request"
                        ? "waiting"
                        : [
                              "tool-output-available",
                              "tool-output-error",
                              "text-delta",
                            ].includes(chunk.type)
                          ? "running"
                          : status;
                    if (status !== next) {
                      status = next;
                      await change(chatId, run.id, status);
                    }
                  },
                },
              );
            },
          });
          if (ending.status === "interrupted") {
            await ended(chatId, run.id);
            return;
          }
          await change(chatId, run.id, "completed");
        } catch (error) {
          await change(
            chatId,
            run.id,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          return;
        } finally {
          scope?.close();
        }
      }
    })()
      .catch((error) => console.warn("[queue] Dispatch failed.", error))
      .finally(async () => {
        claiming.delete(chatId);
        workers.delete(chatId);
        if (closed || pendingHolds.has(chatId) || turns.isRunning(chatId))
          return;
        // Enqueue can race the last empty claim. Recheck after releasing ownership.
        const queue = await catalog.runQueue(chatId).catch(() => null);
        if (
          queue &&
          !queue.paused &&
          queue.runs.some((run) => run.status === "queued")
        )
          drain(chatId);
      });
    workers.set(chatId, worker);
  };

  return {
    setDelegation(service) {
      delegation = service;
    },
    dispatch: drain,
    initialize,
    async submit(request) {
      if (closed) throw new Error("Host is stopping.");
      await initialize();
      const { requestId: id, chatId, ...payload } = request;
      const receipt = await catalog.mutateRunQueue({
        type: "enqueue",
        chatId,
        id,
        request: payload,
      });
      drain(chatId);
      return receipt;
    },
    async list(chatId) {
      await initialize();
      return catalog.runQueue(chatId);
    },
    // pause holds queued work and lets the live turn finish; stop also ends
    // the live turn and its delegated tasks. resume and retry never wait on a
    // live turn: a running worker picks the work up when its turn settles.
    async control({ chatId, action, id }) {
      const holds = action === "pause" || action === "stop";
      if (holds) {
        claiming.delete(chatId);
        pendingHolds.set(chatId, (pendingHolds.get(chatId) ?? 0) + 1);
      }
      try {
        await initialize();
        await catalog.mutateRunQueue({
          type: holds ? "pause" : action,
          chatId,
          id,
        });
        if (action === "stop") {
          turns.stop(chatId);
          for (const child of (await catalog.delegatedTasks?.(chatId)) ?? []) {
            await this.cancelTask(child.childChatId);
          }
        }
      } finally {
        if (holds) {
          const remaining = pendingHolds.get(chatId) - 1;
          if (remaining) pendingHolds.set(chatId, remaining);
          else {
            pendingHolds.delete(chatId);
            // A newer submission or Resume could have arrived during Stop.
            drain(chatId);
          }
        }
      }
      if (action === "resume" || action === "retry") drain(chatId);
      return this.list(chatId);
    },
    async cancelTask(chatId) {
      await this.control({ chatId, action: "stop" });
      for (const run of (await this.list(chatId)).runs) {
        if (run.status === "queued")
          await this.control({ chatId, action: "cancel", id: run.id });
      }
    },
    async close() {
      closed = true;
      turns.stopAll();
      await Promise.allSettled(workers.values());
    },
  };
}
