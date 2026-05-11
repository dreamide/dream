import { useEffect, useMemo, useState } from "react";
import type { ChatConfig } from "@/types/ide";
import { CHAT_KEEP_ALIVE_LIMIT } from "./constants";

export const useMountedProjectChats = ({
  activeChatId,
  chats,
  openChatIds,
  projectId,
  streamingChatIds,
}: {
  activeChatId: string | null;
  chats: ChatConfig[];
  openChatIds: string[];
  projectId: string;
  streamingChatIds: Record<string, boolean>;
}) => {
  const [recentMountedChatIds, setRecentMountedChatIds] = useState<string[]>(
    [],
  );

  useEffect(() => {
    if (!activeChatId) {
      return;
    }

    setRecentMountedChatIds((current) => [
      activeChatId,
      ...current
        .filter((chatId) => chatId !== activeChatId)
        .slice(0, CHAT_KEEP_ALIVE_LIMIT - 1),
    ]);
  }, [activeChatId]);

  return useMemo(() => {
    const mountedChatIds = new Set<string>();
    const projectChats = chats.filter(
      (chat) => chat.projectId === projectId && chat.deletedAt === null,
    );
    const projectChatsById = new Map(
      projectChats.map((chat) => [chat.id, chat]),
    );
    const nextChats = [] as typeof chats;

    for (const chatId of openChatIds) {
      const openChat = projectChatsById.get(chatId);
      if (!openChat || mountedChatIds.has(openChat.id)) {
        continue;
      }

      mountedChatIds.add(openChat.id);
      nextChats.push(openChat);
    }

    if (activeChatId && !mountedChatIds.has(activeChatId)) {
      const activeMountedChat = projectChatsById.get(activeChatId);
      if (activeMountedChat) {
        mountedChatIds.add(activeMountedChat.id);
        nextChats.push(activeMountedChat);
      }
    }

    for (const chat of projectChats) {
      if (!streamingChatIds[chat.id] || mountedChatIds.has(chat.id)) {
        continue;
      }

      mountedChatIds.add(chat.id);
      nextChats.push(chat);
    }

    for (const chatId of recentMountedChatIds) {
      if (
        mountedChatIds.size >= CHAT_KEEP_ALIVE_LIMIT ||
        mountedChatIds.has(chatId)
      ) {
        continue;
      }

      const recentChat = projectChatsById.get(chatId);
      if (!recentChat) {
        continue;
      }

      mountedChatIds.add(recentChat.id);
      nextChats.push(recentChat);
    }

    return nextChats;
  }, [
    activeChatId,
    chats,
    openChatIds,
    projectId,
    recentMountedChatIds,
    streamingChatIds,
  ]);
};
