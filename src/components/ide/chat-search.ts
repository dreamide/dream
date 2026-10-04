// Search across every chat: titles from the store, transcripts from each
// host's catalog (`/api/catalog/search`), merged into one list.
import { create } from "zustand";
import type { CatalogSearchResult } from "@/lib/api-client";
import type { ChatConfig, ProjectConfig } from "@/types/ide";

/** Transcripts are searched from this many characters; titles from one. */
export const CHAT_SEARCH_MIN_TRANSCRIPT_QUERY = 2;
export const CHAT_SEARCH_MAX_ROWS = 50;

interface ChatSearchState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Whether the search dialog is open; opened from the side nav or shortcut. */
export const useChatSearchStore = create<ChatSearchState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export interface ChatSearchRow {
  chat: ChatConfig;
  project: ProjectConfig;
  /** The chat's latest matching message; null for a title-only match. */
  snippet: CatalogSearchResult["snippet"] | null;
  /** Matching messages beyond the one shown. */
  moreMatches: number;
}

const updatedTime = (chat: ChatConfig) => {
  const time = Date.parse(chat.updatedAt || chat.createdAt);
  return Number.isNaN(time) ? 0 : time;
};

/**
 * The chats to list for `query`: those a host found in a transcript and
 * those whose title matches, most recently updated first. A result for a
 * chat or project the store does not know is dropped.
 */
export const buildChatSearchRows = ({
  chats,
  projects,
  query,
  transcriptResults,
}: {
  chats: ChatConfig[];
  projects: ProjectConfig[];
  query: string;
  transcriptResults: CatalogSearchResult[];
}): ChatSearchRow[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const resultByChatId = new Map(
    transcriptResults.map((result) => [result.chatId, result]),
  );

  const rows: ChatSearchRow[] = [];
  for (const chat of chats) {
    const project = projectById.get(chat.projectId);
    if (!project) continue;
    const result = resultByChatId.get(chat.id);
    if (!result && !chat.title.toLowerCase().includes(needle)) continue;
    rows.push({
      chat,
      moreMatches: result ? Math.max(0, result.matchCount - 1) : 0,
      project,
      snippet: result?.snippet ?? null,
    });
  }

  return rows
    .sort((left, right) => updatedTime(right.chat) - updatedTime(left.chat))
    .slice(0, CHAT_SEARCH_MAX_ROWS);
};
