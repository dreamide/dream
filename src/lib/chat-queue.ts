import { createStore } from "zustand/vanilla";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { getProjectHostId } from "../../electron/shared/persisted-state-codec.js";
import type {
  ApiClient,
  ChatQueueResponse,
  ChatRunSummary,
} from "./api-client";

type FinishedRunStatus = "completed" | "cancelled";
export type OpenChatRun = ChatRunSummary & {
  status: Exclude<ChatRunSummary["status"], FinishedRunStatus>;
};

const isOpenRun = (run: ChatRunSummary): run is OpenChatRun =>
  run.status !== "completed" && run.status !== "cancelled";
// The turn in progress (or waiting on a tool approval): the transcript
// already shows it.
const LIVE_RUN_STATUSES = new Set(["running", "waiting"]);

/**
 * The runs the queue panel lists: none unless one needs attention (queued
 * behind the current turn, interrupted or failed). The live turn alone is not
 * a queue; alongside waiting runs it is listed first, as context.
 */
export function visibleQueueRuns(
  runs: readonly ChatRunSummary[],
): OpenChatRun[] {
  const open = runs.filter(isOpenRun);
  return open.some((run) => !LIVE_RUN_STATUSES.has(run.status)) ? open : [];
}

type QueueProject = Pick<ProjectConfig, "id" | "hostId">;
interface QueueWorkspace {
  chats: readonly Pick<ChatConfig, "id" | "projectId">[];
  projects: readonly QueueProject[];
  closedProjects: readonly QueueProject[];
}

interface QueueView {
  queue?: ChatQueueResponse;
  error?: string;
}

interface TrackedQueue {
  hostId: string;
  read: number;
  /** A new control or its failure supersedes older requests' error messages. */
  controlVersion: number;
}

const HOST_REFRESH_CONCURRENCY = 6;

const isSameQueueView = (previous: QueueView | undefined, next: QueueView) => {
  if (!previous || previous.error !== next.error) return false;
  if (previous.queue === next.queue) return true;
  if (!previous.queue || !next.queue) return false;
  return (
    previous.queue.paused === next.queue.paused &&
    previous.queue.runs.length === 0 &&
    next.queue.runs.length === 0
  );
};

/** Owns each queue from its first request until its Chat leaves this Host. */
export const createChatQueues = (
  api: Pick<ApiClient, "chatQueue" | "controlChatQueue">,
) => {
  const views = createStore<ReadonlyMap<string, QueueView>>(() => new Map());
  const tracked = new Map<string, TrackedQueue>();
  const hosts = new Map<string, string>();
  const openChats = new Set<string>();

  const track = (chatId: string, expectedHost?: string) => {
    const hostId = hosts.get(chatId);
    if (!hostId || (expectedHost !== undefined && expectedHost !== hostId))
      return;
    let entry = tracked.get(chatId);
    if (!entry) {
      entry = { hostId, read: 0, controlVersion: 0 };
      tracked.set(chatId, entry);
    }
    return entry;
  };

  const publish = (chatId: string, view: QueueView) => {
    if (isSameQueueView(views.getState().get(chatId), view)) return;
    views.setState((current) => new Map(current).set(chatId, view), true);
  };
  const reportError = (chatId: string, error: unknown) =>
    publish(chatId, {
      ...views.getState().get(chatId),
      error: error instanceof Error ? error.message : String(error),
    });

  const read = async (
    chatId: string,
    entry: TrackedQueue,
    controlVersion = entry.controlVersion,
  ) => {
    const revision = ++entry.read;
    const current = () =>
      tracked.get(chatId) === entry && entry.read === revision;
    try {
      const queue = await api.chatQueue({ chatId }, { hostId: entry.hostId });
      if (current()) {
        const error =
          entry.controlVersion === controlVersion
            ? undefined
            : views.getState().get(chatId)?.error;
        publish(chatId, { queue, error });
      }
    } catch (error) {
      if (current() && entry.controlVersion === controlVersion)
        reportError(chatId, error);
    }
  };

  const refresh = async (chatId: string, expectedHost?: string) => {
    const entry = track(chatId, expectedHost);
    if (entry) await read(chatId, entry);
  };

  return {
    views,
    refresh,
    refreshHost(hostId: string) {
      const targets: [string, TrackedQueue][] = [];
      for (const [chatId, entry] of tracked) {
        if (entry.hostId !== hostId) continue;
        // Skip idle closed-project chats (unpaused, empty, no error, settled) on reconnect.
        const currentView = views.getState().get(chatId);
        const isIdleClosed =
          !openChats.has(chatId) &&
          currentView !== undefined &&
          !currentView.error &&
          !currentView.queue?.paused &&
          (currentView.queue?.runs.length ?? 0) === 0;
        if (isIdleClosed) {
          continue;
        }
        targets.push([chatId, entry]);
      }
      if (targets.length === 0) return;
      let cursor = 0;
      const runNext = () => {
        if (cursor >= targets.length) return;
        const [chatId, entry] = targets[cursor++];
        void read(chatId, entry).finally(runNext);
      };
      const initial = Math.min(HOST_REFRESH_CONCURRENCY, targets.length);
      for (let i = 0; i < initial; i += 1) runNext();
    },
    async control(input: Parameters<ApiClient["controlChatQueue"]>[0]) {
      const { chatId } = input;
      const entry = track(chatId);
      if (!entry) return;
      const version = ++entry.controlVersion;
      try {
        await api.controlChatQueue(input, { hostId: entry.hostId });
        if (tracked.get(chatId) !== entry) return;
        const view = views.getState().get(chatId);
        if (entry.controlVersion === version && view?.error !== undefined)
          publish(chatId, { queue: view.queue });
        // Concurrent controls can reach the Host in either order.
        await read(chatId, entry, version);
      } catch (error) {
        if (tracked.get(chatId) === entry && entry.controlVersion === version) {
          ++entry.controlVersion;
          reportError(chatId, error);
        }
      }
    },
    observe(state: QueueWorkspace, previous?: QueueWorkspace) {
      if (
        previous &&
        state.chats === previous.chats &&
        state.projects === previous.projects &&
        state.closedProjects === previous.closedProjects
      )
        return;
      const openProjectIds = new Set(
        state.projects.map((project) => project.id),
      );
      const projects = new Map(
        [...state.projects, ...state.closedProjects].map((project) => [
          project.id,
          getProjectHostId(project),
        ]),
      );
      hosts.clear();
      openChats.clear();
      for (const chat of state.chats) {
        const hostId = projects.get(chat.projectId);
        if (hostId) {
          hosts.set(chat.id, hostId);
          if (openProjectIds.has(chat.projectId)) openChats.add(chat.id);
        }
      }

      const retired: string[] = [];
      for (const [chatId, entry] of tracked) {
        if (hosts.get(chatId) === entry.hostId) continue;
        tracked.delete(chatId);
        retired.push(chatId);
      }
      if (!retired.length) return;
      views.setState((current) => {
        const next = new Map(current);
        for (const chatId of retired) next.delete(chatId);
        return next;
      }, true);
      // A Project can acquire a new connection while its panel stays mounted.
      for (const chatId of retired) {
        if (hosts.has(chatId)) void refresh(chatId);
      }
    },
  };
};

export type ChatQueues = ReturnType<typeof createChatQueues>;
