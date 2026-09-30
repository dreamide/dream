// The renderer side of the worktree lifecycle. A worktree project is
// created from a parent project, attached when git already lists it,
// completed by merging its branch back into its base, and forgotten in two
// steps: `forgetWorktree` has the main process remove it, and
// `purgeWorktreeProject` drops the app's own record of it (the dialog pauses
// between the two to show the outcome; the projects panel runs them back to
// back). The worktree record is built in one place, `createWorktreeRecord`.
import { ApiError, apiClient } from "@/lib/api-client";
import { createChatConfig, createProjectConfig } from "@/lib/ide-defaults";
import type {
  ChatConfig,
  ProjectConfig,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeInfo,
  ProjectWorktreeInfo,
} from "@/types/ide";
import { createBranchedChatConfig } from "../chat-branching";
import { normalizeProjectPathKey } from "../ide-state";
import { updateProjectInList } from ".";
import type {
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";
import { dropPurgedProjectState } from "./project-runtime-state";

/** The one place a `ProjectWorktreeInfo` is built. */
export const createWorktreeRecord = ({
  baseRef,
  branch,
  mainWorktreePath,
  managed,
  parentProjectId,
  repoRoot,
}: {
  baseRef: string | null;
  branch: string;
  mainWorktreePath: string;
  managed: boolean;
  parentProjectId: string | null;
  repoRoot: string;
}): ProjectWorktreeInfo => ({
  baseRef,
  branch,
  createdAt: new Date().toISOString(),
  kind: "worktree",
  mainWorktreePath,
  managed,
  parentProjectId,
  repoRoot,
});

const findProjectByPath = (
  projects: ProjectConfig[],
  projectPath: string,
): ProjectConfig | undefined => {
  const pathKey = normalizeProjectPathKey(projectPath);
  return projects.find(
    (project) => normalizeProjectPathKey(project.path) === pathKey,
  );
};

/**
 * The open project a worktree belongs to: the parent it was created from
 * when that is still open, otherwise the open project at its main checkout.
 */
export const resolveWorktreeParentId = (
  projects: ProjectConfig[],
  worktree: Pick<ProjectWorktreeInfo, "mainWorktreePath" | "parentProjectId">,
): string | null =>
  projects.find((project) => project.id === worktree.parentProjectId)?.id ??
  findProjectByPath(
    projects.filter((project) => !project.worktree),
    worktree.mainWorktreePath,
  )?.id ??
  null;

export const createWorktreeActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  { api = apiClient }: StoreActionDependencies = {},
): Pick<
  IdeState,
  | "createWorktreeProject"
  | "attachWorktreeProject"
  | "completeWorktreeProject"
  | "forgetWorktree"
  | "purgeWorktreeProject"
> => ({
  createWorktreeProject: async (parentProjectId, options) => {
    const activate = options.activate !== false;
    const parentProject = get().projects.find(
      (project) => project.id === parentProjectId,
    );
    if (!parentProject) {
      throw new Error();
    }

    const payload = await api.gitWorktreeCreate({
      baseRef: options.baseRef ?? null,
      branchName: options.branchName,
      projectPath: parentProject.path,
    });
    const worktree = createWorktreeRecord({
      baseRef: payload.baseRef,
      branch: payload.branch,
      mainWorktreePath: payload.mainWorktreePath,
      managed: true,
      parentProjectId,
      repoRoot: payload.repoRoot,
    });
    const seed = options.initialChatSeed ?? null;
    const seedChat = (project: ProjectConfig): ChatConfig | null => {
      if (!seed) {
        return null;
      }
      const chat = createBranchedChatConfig(
        seed.sourceChat,
        project,
        seed.messageId,
      );
      chat.messageCount = seed.messages.length;
      return chat;
    };
    const focusChat = (
      ui: ProjectConfig["ui"],
      chatId: string,
    ): ProjectConfig["ui"] => ({
      ...ui,
      activeChatId: chatId,
      openChatIds: [chatId],
      chatColumnWidths: {},
    });
    let createdProjectId: string | null = null;
    let createdChatId: string | null = null;

    set((state) => {
      const lastUsedAt = new Date().toISOString();
      const existingProject = findProjectByPath(state.projects, payload.path);
      if (existingProject) {
        createdProjectId = existingProject.id;
        const nextChat = seedChat(existingProject);
        createdChatId = nextChat?.id ?? existingProject.ui.activeChatId;
        return {
          ...(activate ? { activeProjectId: existingProject.id } : {}),
          chats: nextChat ? [...state.chats, nextChat] : state.chats,
          messagesByChatId: nextChat
            ? { ...state.messagesByChatId, [nextChat.id]: seed?.messages ?? [] }
            : state.messagesByChatId,
          projects: updateProjectInList(
            state.projects,
            existingProject.id,
            (project) => ({
              ...project,
              lastUsedAt,
              ui: nextChat ? focusChat(project.ui, nextChat.id) : project.ui,
              worktree: project.worktree ?? worktree,
            }),
          ),
        };
      }

      const closedProject = findProjectByPath(
        state.closedProjects,
        payload.path,
      );
      if (closedProject) {
        createdProjectId = closedProject.id;
        const reopenedProject = {
          ...closedProject,
          lastUsedAt,
          path: payload.path,
          worktree,
        };
        const nextChat = seedChat(reopenedProject);
        createdChatId = nextChat?.id ?? reopenedProject.ui.activeChatId;
        return {
          ...(activate ? { activeProjectId: closedProject.id } : {}),
          chats: nextChat ? [...state.chats, nextChat] : state.chats,
          closedProjects: state.closedProjects.filter(
            (project) => project.id !== closedProject.id,
          ),
          messagesByChatId: nextChat
            ? { ...state.messagesByChatId, [nextChat.id]: seed?.messages ?? [] }
            : state.messagesByChatId,
          projects: [
            ...state.projects,
            {
              ...reopenedProject,
              ui: nextChat
                ? focusChat(reopenedProject.ui, nextChat.id)
                : reopenedProject.ui,
            },
          ],
        };
      }

      const nextProject = {
        ...createProjectConfig(payload.path, state.settings),
        browserUrl: parentProject.browserUrl,
        model: parentProject.model,
        modelSpeed: parentProject.modelSpeed,
        name: `${parentProject.name} / ${payload.branch}`,
        provider: parentProject.provider,
        reasoningEffort: parentProject.reasoningEffort,
        runCommand: parentProject.runCommand,
        worktree,
      };
      const nextChat =
        seedChat(nextProject) ??
        createChatConfig(nextProject, {
          permissionMode: state.settings.defaultPermissionMode,
        });
      createdProjectId = nextProject.id;
      createdChatId = nextChat.id;

      return {
        ...(activate ? { activeProjectId: nextProject.id } : {}),
        draftChatIdByProject: {
          ...state.draftChatIdByProject,
          [nextProject.id]: seed ? null : nextChat.id,
        },
        messagesByChatId: {
          ...state.messagesByChatId,
          [nextChat.id]: seed?.messages ?? [],
        },
        chats: [...state.chats, nextChat],
        projects: [
          ...state.projects,
          {
            ...nextProject,
            ui: {
              ...focusChat(nextProject.ui, nextChat.id),
              rightPanelView: "changes",
            },
          },
        ],
      };
    });

    if (createdChatId && seed) {
      await get().persistMessagesForChat?.(createdChatId);
    }

    return createdProjectId
      ? { chatId: createdChatId, projectId: createdProjectId }
      : null;
  },

  attachWorktreeProject: (
    listed: ProjectGitWorktreeInfo,
    repo: { mainWorktreePath: string; repoRoot: string },
  ) => {
    // A detached worktree has no branch to record; it opens as a plain
    // folder. Details recorded at creation (base branch) win over these.
    const worktree = listed.branch
      ? createWorktreeRecord({
          baseRef: null,
          branch: listed.branch,
          mainWorktreePath: repo.mainWorktreePath,
          managed: listed.appManaged,
          parentProjectId: resolveWorktreeParentId(get().projects, {
            mainWorktreePath: repo.mainWorktreePath,
            parentProjectId: null,
          }),
          repoRoot: repo.repoRoot,
        })
      : undefined;
    get().addProject(listed.path, { worktree });
  },

  completeWorktreeProject: async (projectId, options = {}) => {
    const project = get().projects.find((item) => item.id === projectId);
    if (!project?.worktree) {
      throw new Error("Project is not a worktree.");
    }
    const result = await api.gitWorktreeMerge({
      acknowledgeUncommitted: options.acknowledgeUncommitted ?? false,
      baseRef: project.worktree.baseRef,
      projectPath: project.path,
    });
    if (result.status === "merged") {
      // The main checkout moved: its status is stale.
      const parentId = resolveWorktreeParentId(
        get().projects,
        project.worktree,
      );
      if (parentId) {
        get().bumpProjectGitRefreshKey(parentId);
      }
    }
    return result;
  },

  forgetWorktree: async ({
    branch,
    deleteBranch = false,
    force = false,
    mainWorktreePath,
    worktreePath,
  }) => {
    const state = get();
    const project = findProjectByPath(
      [...state.projects, ...state.closedProjects],
      worktreePath,
    );
    if (project && state.projects.includes(project)) {
      state.stopProjectTerminals(project.id);
    }

    const knownBranch = branch ?? project?.worktree?.branch ?? null;
    try {
      return await api.gitWorktreeCleanup({
        branch: knownBranch,
        deleteBranch,
        force,
        projectPath: mainWorktreePath,
        worktreePath,
      });
    } catch (error) {
      // Git had already forgotten it: as gone as a removal would leave it.
      if (error instanceof ApiError && error.status === 404) {
        return {
          branch: knownBranch,
          branchDeleted: false,
          branchDeleteError: null,
          path: worktreePath,
          pruned: true,
          removed: true,
        } satisfies ProjectGitWorktreeCleanupResponse;
      }
      throw error;
    }
  },

  purgeWorktreeProject: (worktreePath, options = {}) => {
    const worktreePathKey = normalizeProjectPathKey(worktreePath);
    const openProject = findProjectByPath(get().projects, worktreePath);
    const activateProjectId =
      options.activateProjectId ??
      (openProject?.worktree
        ? resolveWorktreeParentId(get().projects, openProject.worktree)
        : null);
    if (openProject) {
      get().closeProject(openProject.id);
    }

    set((current) => {
      const removedProjectIds = [...current.projects, ...current.closedProjects]
        .filter(
          (item) => normalizeProjectPathKey(item.path) === worktreePathKey,
        )
        .map((item) => item.id);
      if (removedProjectIds.length === 0) {
        return current;
      }

      // The worktree's chats go with it.
      const removedChatIds = current.chats
        .filter((chat) => removedProjectIds.includes(chat.projectId))
        .map((chat) => chat.id);

      return {
        ...dropPurgedProjectState(current, removedProjectIds, removedChatIds),
        chats: current.chats.filter(
          (chat) => !removedChatIds.includes(chat.id),
        ),
        closedProjects: current.closedProjects.filter(
          (item) => !removedProjectIds.includes(item.id),
        ),
        projects: current.projects.filter(
          (item) => !removedProjectIds.includes(item.id),
        ),
      };
    });

    if (
      activateProjectId &&
      get().projects.some((project) => project.id === activateProjectId)
    ) {
      get().setActiveProjectId(activateProjectId);
      get().bumpProjectGitRefreshKey(activateProjectId);
    }
  },
});
