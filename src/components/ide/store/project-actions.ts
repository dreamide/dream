import { createChatActions } from "./chat-actions";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { createKanbanActions } from "./kanban-actions";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createStashActions } from "./stash-actions";

export const createProjectActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "setProjects"
  | "setActiveProjectId"
  | "addProject"
  | "createWorktreeProject"
  | "closeProject"
  | "stopProjectTerminals"
  | "purgeWorktreeProject"
  | "removeWorktreeProject"
  | "updateProject"
  | "addChat"
  | "addChatBeside"
  | "branchChatInWorkspace"
  | "branchChatInNewWorktree"
  | "toggleProjectMultiChatMode"
  | "setActiveChatId"
  | "updateChat"
  | "archiveInactiveChats"
  | "deleteChat"
  | "permanentlyDeleteChats"
  | "restoreChats"
  | "setMessagesForChat"
  | "setChatSort"
  | "addStashItem"
  | "updateStashItem"
  | "deleteStashItem"
  | "executeStashItem"
  | "takePendingChatSubmit"
  | "queueChatSubmit"
  | "addKanbanCard"
  | "updateKanbanCard"
  | "deleteKanbanCard"
  | "moveKanbanCard"
  | "startKanbanCard"
  | "openKanbanCardChat"
  | "unlinkKanbanCardsForChats"
  | "advanceKanbanCardsForChat"
> => ({
  ...createProjectLifecycleActions(set, get),
  ...createChatActions(set, get),
  ...createStashActions(set, get),
  ...createKanbanActions(set, get),
});
