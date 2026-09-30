import { createChatActions } from "./chat-actions";
import type {
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createSavedPromptActions } from "./saved-prompt-actions";
import { createStashActions } from "./stash-actions";
import { createWorktreeActions } from "./worktree-actions";

export const createProjectActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  dependencies: StoreActionDependencies = {},
): Pick<
  IdeState,
  | "setProjects"
  | "setActiveProjectId"
  | "addProject"
  | "closeProject"
  | "stopProjectTerminals"
  | "createWorktreeProject"
  | "attachWorktreeProject"
  | "completeWorktreeProject"
  | "forgetWorktree"
  | "purgeWorktreeProject"
  | "updateProject"
  | "addChat"
  | "addChatBeside"
  | "branchChatInWorkspace"
  | "branchChatInNewWorktree"
  | "toggleProjectMultiChatMode"
  | "setActiveChatId"
  | "updateChat"
  | "archiveInactiveChats"
  | "toggleChatPinned"
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
  | "addSavedPrompt"
  | "updateSavedPrompt"
  | "deleteSavedPrompt"
  | "moveSavedPrompt"
  | "runSavedPrompt"
> => ({
  ...createProjectLifecycleActions(set, get),
  ...createWorktreeActions(set, get, dependencies),
  ...createChatActions(set, get, dependencies),
  ...createStashActions(set, get),
  ...createSavedPromptActions(set, get),
});
