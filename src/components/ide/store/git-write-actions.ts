// Writing to a project's git: commit, push, pull, fetch, revert, checkout,
// deleting a branch, and creating a pull request. Every surface that writes (the Git panel's
// footer and commit box, the Changes tab, the branch switcher, the PR and
// worktree dialogs) goes through here, so the rules that go with a write
// hold for all of them:
//
//   it runs on the project's own host;
//   one write runs at a time per project (git takes its index lock), and a
//   second is refused rather than queued: the surface asked while busy;
//   the project's git state is read again exactly once when it ends,
//   succeeded or not (the refresh key moves);
//   it answers an outcome and never throws: how a failure shows (a toast,
//   a line under the message) is the surface's.
import {
  type ApiRequestOf,
  type ApiResponseOf,
  apiClient,
} from "@/lib/api-client";
import type { ProjectConfig, ProjectGitStatusEntry } from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import type {
  GitWrite,
  GitWriteOutcome,
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";

/** A write asked for while another of the same project runs. */
export class GitWriteBusyError extends Error {
  constructor() {
    super("Another git action is still running for this project.");
    this.name = "GitWriteBusyError";
  }
}

/**
 * The git write actions in the store (`IdeState`). Each runs on the
 * project's host, refuses to start while another write of the project runs,
 * refreshes the project's git state once when done, and answers an outcome
 * rather than throwing.
 */
export interface GitWriteActions {
  commitProject: (
    projectId: string,
    commit: { message: string; includeUnstaged: boolean; push: boolean },
  ) => Promise<GitWriteOutcome<unknown>>;
  pushProject: (
    projectId: string,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitPush">>>;
  pullProject: (
    projectId: string,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitPull">>>;
  fetchProject: (
    projectId: string,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitFetch">>>;
  /** Reverts one changed file, or every change. */
  revertProjectChanges: (
    projectId: string,
    target: ProjectGitStatusEntry | "all",
  ) => Promise<GitWriteOutcome<unknown>>;
  checkoutProjectBranch: (
    projectId: string,
    branchName: string,
    options?: { create?: boolean },
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitCheckout">>>;
  deleteProjectBranch: (
    projectId: string,
    branchName: string,
    options?: { confirmedHead?: string | null },
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitBranchDelete">>>;
  createProjectPullRequest: (
    projectId: string,
    request: Omit<ApiRequestOf<"gitCreatePullRequest">, "projectPath">,
  ) => Promise<GitWriteOutcome<ApiResponseOf<"gitCreatePullRequest">>>;
}

export const createGitWriteActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  { api = apiClient }: StoreActionDependencies = {},
): GitWriteActions => {
  const setWrite = (projectId: string, write: GitWrite | null) => {
    set((state) => {
      const next = { ...state.gitWriteByProject };
      if (write) next[projectId] = write;
      else delete next[projectId];
      return { gitWriteByProject: next };
    });
  };

  /** Runs one write of `projectId` under the rules above. */
  const run = async <Result>(
    projectId: string,
    write: GitWrite,
    perform: (
      project: ProjectConfig,
      host: { hostId: string },
    ) => Promise<Result>,
  ): Promise<GitWriteOutcome<Result>> => {
    const state = get();
    const project = [...state.projects, ...state.closedProjects].find(
      (item) => item.id === projectId,
    );
    if (!project) {
      return { error: new Error("This project is not open."), ok: false };
    }
    if (state.gitWriteByProject[projectId]) {
      return { error: new GitWriteBusyError(), ok: false };
    }

    setWrite(projectId, write);
    try {
      return {
        ok: true,
        result: await perform(project, { hostId: getProjectHostId(project) }),
      };
    } catch (error) {
      return { error, ok: false };
    } finally {
      setWrite(projectId, null);
      get().bumpProjectGitRefreshKey(projectId);
    }
  };

  return {
    commitProject: (projectId, { includeUnstaged, message, push }) =>
      run<unknown>(
        projectId,
        push ? "commit-push" : "commit",
        (project, host) =>
          push
            ? api.gitPush(
                {
                  commitMessage: message,
                  includeUnstaged,
                  nextStep: "commit-push",
                  projectPath: project.path,
                },
                host,
              )
            : api.gitCommit(
                { includeUnstaged, message, projectPath: project.path },
                host,
              ),
      ),

    pushProject: (projectId) =>
      run(projectId, "push", (project, host) =>
        api.gitPush(
          {
            commitMessage: null,
            includeUnstaged: true,
            nextStep: "push",
            projectPath: project.path,
          },
          host,
        ),
      ),

    pullProject: (projectId) =>
      run(projectId, "pull", (project, host) =>
        api.gitPull({ projectPath: project.path }, host),
      ),

    fetchProject: (projectId) =>
      run(projectId, "fetch", (project, host) =>
        api.gitFetch({ projectPath: project.path }, host),
      ),

    revertProjectChanges: (projectId, target) =>
      run(projectId, "revert", (project, host) =>
        target === "all"
          ? api.gitRevertAll({ projectPath: project.path }, host)
          : api.gitRevertFile(
              {
                filePath: target.path,
                previousPath: target.previousPath,
                projectPath: project.path,
                status: target.status,
              },
              host,
            ),
      ),

    checkoutProjectBranch: (projectId, branchName, { create = false } = {}) =>
      run(projectId, "checkout", (project, host) =>
        api.gitCheckout(
          { branchName, create, projectPath: project.path },
          host,
        ),
      ),

    deleteProjectBranch: (
      projectId,
      branchName,
      { confirmedHead = null } = {},
    ) =>
      run(projectId, "delete-branch", (project, host) =>
        api.gitBranchDelete(
          { branchName, confirmedHead, projectPath: project.path },
          host,
        ),
      ),

    createProjectPullRequest: (projectId, request) =>
      run(projectId, "pull-request", (project, host) =>
        api.gitCreatePullRequest(
          { ...request, projectPath: project.path },
          host,
        ),
      ),
  };
};
