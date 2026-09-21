import { createChatActions } from "./chat-actions";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createStashActions } from "./stash-actions";
import { createTaskActions } from "./task-actions";

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
  | "addTask"
  | "addTaskToProjectPath"
  | "updateTask"
  | "deleteTask"
  | "moveTaskInBacklog"
  | "startTask"
  | "advanceTask"
  | "sendTaskBack"
  | "retryTaskStep"
  | "completeTask"
  | "openTaskStepChat"
  | "reopenTaskWorktree"
  | "recreateTaskWorktree"
  | "unlinkTaskRunsForChats"
  | "setTaskStepConfig"
  | "isTaskChat"
  | "maybeAutoAdvanceTaskForChat"
> => ({
  ...createProjectLifecycleActions(set, get),
  ...createChatActions(set, get),
  ...createStashActions(set, get),
  ...createTaskActions(set, get),
});
