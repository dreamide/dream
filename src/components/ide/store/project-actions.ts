import { createChatActions } from "./chat-actions";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";

export const createProjectActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "setProjects"
  | "setActiveProjectId"
  | "addProject"
  | "closeProject"
  | "updateProject"
  | "addChat"
  | "setActiveChatId"
  | "updateChat"
  | "deleteChat"
  | "permanentlyDeleteChats"
  | "restoreChats"
  | "setMessagesForChat"
  | "setChatSort"
> => ({
  ...createProjectLifecycleActions(set, get),
  ...createChatActions(set, get),
});
