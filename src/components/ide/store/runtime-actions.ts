import { getDesktopApi } from "@/lib/electron";
import type { IdeState, IdeStoreSet } from "./ide-store-types";

export const createRuntimeActions = (
  set: IdeStoreSet,
): Pick<
  IdeState,
  | "appendTerminalOutput"
  | "clearTerminalOutput"
  | "setTerminalStatus"
  | "setTerminalTransport"
  | "setTerminalShell"
  | "setTerminalSessionName"
  | "setChatStreaming"
  | "setChatTitleGenerating"
  | "bumpProjectGitRefreshKey"
  | "bumpProjectFilesRefreshKey"
  | "setIsMacOs"
  | "setIsElectron"
  | "setAppReady"
  | "openExternalUrl"
> => ({
  appendTerminalOutput: (projectId, chunk) => {
    set((state) => {
      const current = state.terminalOutput[projectId] ?? "";
      const next = `${current}${chunk}`;
      return {
        terminalOutput: {
          ...state.terminalOutput,
          [projectId]: next.slice(-150_000),
        },
      };
    });
  },

  clearTerminalOutput: (projectId) => {
    set((state) => ({
      terminalOutput: { ...state.terminalOutput, [projectId]: "" },
    }));
  },

  setTerminalStatus: (projectId, status) => {
    set((state) => ({
      terminalStatus: { ...state.terminalStatus, [projectId]: status },
    }));
  },

  setTerminalTransport: (projectId, transport) => {
    set((state) => ({
      terminalTransport: { ...state.terminalTransport, [projectId]: transport },
    }));
  },

  setTerminalShell: (projectId, shell) => {
    set((state) => ({
      terminalShell: { ...state.terminalShell, [projectId]: shell },
    }));
  },

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

  setChatStreaming: (chatId, streaming) =>
    set((state) => {
      const next = { ...state.streamingChatIds };
      if (streaming) {
        next[chatId] = true;
      } else {
        delete next[chatId];
      }
      return { streamingChatIds: next };
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
});
