import type { UIMessage } from "ai";
import { getDesktopApi } from "@/lib/electron";
import type { PersistedIdeState } from "@/types/ide";
import { createEmptyPersistedState } from "../../../../electron/shared/persisted-state-codec.js";

const STATE_LOAD_TIMEOUT_MS = 8000;

const requireDesktopApi = () => {
  const desktopApi = getDesktopApi();
  if (!desktopApi) {
    throw new Error("Dream desktop API is unavailable.");
  }

  return desktopApi;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
};

/**
 * The main process decodes persisted state once, with the shared codec,
 * before it crosses the IPC seam; what arrives here is already valid.
 */
export const loadPersistedIdeState = async (): Promise<PersistedIdeState> => {
  const desktopApi = requireDesktopApi();

  try {
    const state = await withTimeout(
      desktopApi.loadState(),
      STATE_LOAD_TIMEOUT_MS,
      "Timed out loading persisted Dream state.",
    );
    return state && typeof state === "object"
      ? state
      : createEmptyPersistedState();
  } catch (error) {
    console.warn("Unable to load persisted Dream state.", error);
    return createEmptyPersistedState();
  }
};

export const loadPersistedChatMessages = async (
  chatId: string,
): Promise<UIMessage[]> => {
  const desktopApi = requireDesktopApi();

  try {
    return await withTimeout(
      desktopApi.loadChatMessages(chatId),
      STATE_LOAD_TIMEOUT_MS,
      `Timed out loading messages for chat ${chatId}.`,
    );
  } catch (error) {
    console.warn(`Unable to load messages for chat ${chatId}.`, error);
    throw error;
  }
};

export const savePersistedIdeState = (state: PersistedIdeState) => {
  void requireDesktopApi().saveState(state);
};

export const savePersistedChatMessages = async (
  chatId: string,
  messages: UIMessage[],
) => {
  await requireDesktopApi().saveChatMessages({ chatId, messages });
};

export const savePersistedActiveProject = (
  activeProjectId: string | null,
  lastUsedAt: string | null,
) => {
  const desktopApi = requireDesktopApi();
  if (typeof desktopApi.saveActiveProject !== "function") {
    return;
  }

  void desktopApi
    .saveActiveProject({
      activeProjectId,
      lastUsedAt,
    })
    .catch((error: unknown) => {
      console.warn("Unable to persist the active Dream project.", error);
    });
};
