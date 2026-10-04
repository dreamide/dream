// Notifications for chat activity: a turn that finished, failed or stopped
// to ask something. A desktop notification while the window is in the
// background (in the window itself the project tabs and chat history already
// show it), and, as its own setting, a sound wherever the user is looking.
import { getDesktopApi } from "@/lib/electron";
import { type ChatActivity, useActivityStore } from "./activity-store";
import { useIdeStore } from "./ide-store";
import { playNotificationSound } from "./notification-sound";

export type ActivityNotificationKind = "finished" | "failed" | "waiting";

const NOTIFICATION_DETAIL_MAX_LENGTH = 200;

/**
 * What a change of a chat's activity is worth telling the user, if anything:
 * a running turn that started waiting on them, or a running or waiting turn
 * that ended on its own. An interrupted turn was stopped by the user (or
 * lost with its connection) and says nothing.
 */
export const getActivityNotificationKind = (
  previous: ChatActivity | undefined,
  next: ChatActivity | undefined,
): ActivityNotificationKind | null => {
  if (!previous || !next || previous.status === next.status) return null;
  if (next.status === "waiting") {
    return previous.status === "running" ? "waiting" : null;
  }
  if (previous.status !== "running" && previous.status !== "waiting") {
    return null;
  }
  return next.status === "finished" || next.status === "failed"
    ? next.status
    : null;
};

export type TranslateActivityNotification = (
  kind: ActivityNotificationKind,
  values: { project: string },
) => string;

/** Opens the chat a notification was about. */
const showChat = (chatId: string) => {
  const state = useIdeStore.getState();
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat || chat.deletedAt !== null) return;
  if (!state.projects.some((project) => project.id === chat.projectId)) return;
  state.setSettingsOpen(false);
  state.setActiveProjectId(chat.projectId);
  state.setActiveChatId(chat.projectId, chatId);
};

/**
 * Watches chat activity and tells the user, as their settings ask: a desktop
 * notification while the window is unfocused, and a sound whether or not it
 * is. Returns how to stop.
 */
export const startActivityNotifications = (
  translate: TranslateActivityNotification,
): (() => void) => {
  const desktopApi = getDesktopApi();

  const stopWatching = useActivityStore.subscribe((state, previous) => {
    if (state.entries === previous.entries) return;
    const ide = useIdeStore.getState();
    const { chatNotificationSound, chatNotifications } = ide.settings;
    const showNotifications =
      chatNotifications && desktopApi !== null && !document.hasFocus();
    if (!showNotifications && !chatNotificationSound) return;

    let notified = false;
    for (const [chatId, entry] of Object.entries(state.entries)) {
      const kind = getActivityNotificationKind(previous.entries[chatId], entry);
      if (!kind) continue;
      const chat = ide.chats.find((item) => item.id === chatId);
      const project =
        chat && ide.projects.find((item) => item.id === chat.projectId);
      if (!chat || chat.deletedAt !== null || !project) continue;

      notified = true;
      if (!showNotifications) continue;
      const detail = entry.detail
        .trim()
        .slice(0, NOTIFICATION_DETAIL_MAX_LENGTH);
      void desktopApi?.showNotification({
        body: [translate(kind, { project: project.name }), detail]
          .filter(Boolean)
          .join("\n"),
        chatId,
        // The app's own sound plays instead of the system's.
        silent: chatNotificationSound,
        title: chat.title,
      });
    }
    // Once, however many chats changed together.
    if (notified && chatNotificationSound) playNotificationSound();
  });
  const stopClicks = desktopApi?.onNotificationClicked(({ chatId }) =>
    showChat(chatId),
  );

  return () => {
    stopWatching();
    stopClicks?.();
  };
};
