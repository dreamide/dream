// The host owns dispatch; clients submit durable intent and observe streams.
import { randomUUID } from "node:crypto";
export function createRunScheduler({ catalog, turns, execute }) {
  let ready;
  let closed = false;
  let delegation;
  const workers = new Map();
  const held = new Set();
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
    if (closed || workers.has(chatId)) return;
    const worker = (async () => {
      await initialize();
      while (!closed && !held.has(chatId) && !turns.isRunning(chatId)) {
        const run = await catalog.mutateRunQueue({ type: "claim", chatId });
        if (!run) return;
        if (closed || held.has(chatId)) {
          // Held while claiming: it never started, so it goes back in line.
          await change(chatId, run.id, "queued");
          return;
        }
        let failure = null;
        let signal;
        let status = "running";
        let scope;
        try {
          await turns.run({
            chatId,
            run: async (abortSignal) => {
              signal = abortSignal;
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
                  remoteConversationId: chat.remoteConversationId,
                  remoteConversationModel: chat.remoteConversationModel,
                  remoteConversationModelSpeed:
                    chat.remoteConversationModelSpeed,
                  remoteConversationProjectPath:
                    chat.remoteConversationProjectPath,
                },
                {
                  catalog,
                  // Saved above: the turn writes only its own message.
                  requestSaved: true,
                  signal,
                  orchestration: scope,
                  onChunk: async (chunk) => {
                    if (chunk.type === "error")
                      failure = chunk.errorText || "Provider failed.";
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
          if (signal?.aborted) await ended(chatId, run.id);
          else
            await change(
              chatId,
              run.id,
              failure ? "failed" : "completed",
              failure,
            );
          if (failure || signal?.aborted) return;
        } catch (error) {
          if (signal?.aborted) await ended(chatId, run.id);
          else
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
        workers.delete(chatId);
        if (closed || held.has(chatId) || turns.isRunning(chatId)) return;
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
      // A new message is consent to continue a held chat (after Stop or a
      // failure): resume it. A resent duplicate is not.
      if (
        !receipt.duplicate &&
        (held.has(chatId) || (await catalog.runQueue(chatId)).paused)
      )
        await this.control({ chatId, action: "resume" });
      else drain(chatId);
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
      if (holds) held.add(chatId);
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
      if (action === "resume") held.delete(chatId);
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
