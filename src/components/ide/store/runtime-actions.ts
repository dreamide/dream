import { getDesktopApi } from "@/lib/electron";
import type { IdeState, IdeStoreSet } from "./ide-store-types";

export const createRuntimeActions = (
  set: IdeStoreSet,
): Pick<
  IdeState,
  | "setTerminalSessionName"
  | "setChatStreaming"
  | "setChatSending"
  | "setChatAwaitingAnswer"
  | "setChatTitleGenerating"
  | "bumpProjectGitRefreshKey"
  | "bumpProjectFilesRefreshKey"
  | "setIsMacOs"
  | "setIsElectron"
  | "setAppReady"
  | "openExternalUrl"
  | "openExternalPath"
> => ({
  setTerminalSessionName: (sessionId, name) => {
    const normalizedSessionId =
      typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) {
      return;
    }

    const normalizedName = name.trim();
    set((state) => {
      const nextTerminalSessionNames = { ...state.terminalSessionNames };

      if (normalizedName) {
        nextTerminalSessionNames[normalizedSessionId] = normalizedName;
      } else {
        delete nextTerminalSessionNames[normalizedSessionId];
      }

      return {
        terminalSessionNames: nextTerminalSessionNames,
      };
    });
  },

  // Whether this window's session streams the chat. What its turn came to
  // is the Chat turn outcome's (chat-turn-outcome.ts).
  setChatStreaming: (chatId, streaming) =>
    set((state) => {
      const streamingChatIds = { ...state.streamingChatIds };
      if (streaming) {
        if (state.streamingChatIds[chatId]) return state;
        streamingChatIds[chatId] = true;
        return { streamingChatIds };
      }
      if (
        !state.streamingChatIds[chatId] &&
        !state.awaitingAnswerChatIds[chatId]
      )
        return state;
      delete streamingChatIds[chatId];
      const awaitingAnswerChatIds = { ...state.awaitingAnswerChatIds };
      delete awaitingAnswerChatIds[chatId];
      return { awaitingAnswerChatIds, streamingChatIds };
    }),

  // A message is being sent to the chat from this window
  // (chat/chat-submission.ts).
  setChatSending: (chatId, sending) =>
    set((state) => {
      if (Boolean(state.sendingChatIds[chatId]) === sending) return state;
      const sendingChatIds = { ...state.sendingChatIds };
      if (sending) sendingChatIds[chatId] = true;
      else delete sendingChatIds[chatId];
      return { sendingChatIds };
    }),

  setChatAwaitingAnswer: (chatId, awaiting) =>
    set((state) => {
      if (Boolean(state.awaitingAnswerChatIds[chatId]) === awaiting) {
        return state;
      }

      const awaitingAnswerChatIds = { ...state.awaitingAnswerChatIds };
      if (awaiting) {
        awaitingAnswerChatIds[chatId] = true;
      } else {
        delete awaitingAnswerChatIds[chatId];
      }
      return { awaitingAnswerChatIds };
    }),

  setChatTitleGenerating: (chatId, generating) =>
    set((state) => {
      const next = { ...state.titleGeneratingChatIds };
      if (generating) {
        next[chatId] = true;
      } else {
        delete next[chatId];
      }
      return { titleGeneratingChatIds: next };
    }),

  bumpProjectGitRefreshKey: (projectId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => ({
      projectGitRefreshKeys: {
        ...state.projectGitRefreshKeys,
        [normalizedProjectId]:
          (state.projectGitRefreshKeys[normalizedProjectId] ?? 0) + 1,
      },
    }));
  },

  bumpProjectFilesRefreshKey: (projectId) => {
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedProjectId) {
      return;
    }

    set((state) => ({
      projectFilesRefreshKeys: {
        ...state.projectFilesRefreshKeys,
        [normalizedProjectId]:
          (state.projectFilesRefreshKeys[normalizedProjectId] ?? 0) + 1,
      },
    }));
  },

  setIsMacOs: (value) => set({ isMacOs: value }),

  setIsElectron: (value) => set({ isElectron: value }),

  setAppReady: (value) => set({ appReady: value }),

  openExternalUrl: (url) => {
    const desktopApi = getDesktopApi();
    if (desktopApi) {
      void desktopApi.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },

  openExternalPath: (path) => {
    const desktopApi = getDesktopApi();
    if (desktopApi) {
      void desktopApi.openPath(path);
    }
  },
});
