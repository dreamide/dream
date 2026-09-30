// The renderer side of the worktree lifecycle. A worktree project is
// created from a parent project, attached when git already lists it,
// completed by merging its branch back into its base, and forgotten in two
// steps: `forgetWorktree` has the main process remove it, and
// `purgeWorktreeProject` drops the app's own record of it (the dialog pauses
// between the two to show the outcome; the projects panel runs them back to
// back). The worktree record is built in one place, `createWorktreeRecord`.
import { ApiError, apiClient } from "@/lib/api-client";
import type {
  ProjectConfig,
  ProjectGitWorktreeCleanupResponse,
  ProjectGitWorktreeInfo,
  ProjectWorktreeInfo,
} from "@/types/ide";
import { createBranchedChatConfig } from "../chat-branching";
import { normalizeProjectPathKey } from "../ide-state";
import type {
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
  WorktreeProjectCreationResult,
} from "./ide-store-types";
import { dropPurgedProjectState } from "./project-runtime-state";
import * as workspace from "./workspace-document";

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
    const created: { value: WorktreeProjectCreationResult | null } = {
      value: null,
    };

    set((state) => {
      const opened = workspace.openProject(
        state,
        state.settings,
        payload.path,
        {
          activate: options.activate,
          // A new worktree project takes after its parent and opens on its
          // changes, which are what the worktree is for.
          create: (project) => ({
            ...project,
            browserUrl: parentProject.browserUrl,
            model: parentProject.model,
            modelSpeed: parentProject.modelSpeed,
            name: `${parentProject.name} / ${payload.branch}`,
            provider: parentProject.provider,
            reasoningEffort: parentProject.reasoningEffort,
            runCommand: parentProject.runCommand,
            ui: { ...project.ui, rightPanelView: "changes" },
          }),
          replaceWorktree: true,
          seed: seed
            ? (project) => {
                const chat = createBranchedChatConfig(
                  seed.sourceChat,
                  project,
                  seed.messageId,
                );
                chat.messageCount = seed.messages.length;
                return { chat, messages: seed.messages };
              }
            : undefined,
          worktree,
        },
      );
      created.value = { chatId: opened.chatId, projectId: opened.projectId };
      return opened.doc;
    });

    if (created.value?.chatId && seed) {
      await get().persistMessagesForChat?.(created.value.chatId);
    }

    return created.value;
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
