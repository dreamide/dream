/**
 * Git text a model writes for the user: commit messages and pull request
 * details. One cache for both, keyed by what they are written from: the
 * changes (as `electron/shared/git-changes.js` names them, the same key the
 * main process caches by), the model settings, and for pull requests the
 * branches, the next step and the git version, since a pull request also
 * describes commits the status does not list.
 *
 * A request already under way is shared, so the commit message warmed when a
 * turn ends is the one the Changes tab then shows. Only answers with text
 * are kept; a failure reaches the caller and is never cached.
 */
import { apiClient } from "@/lib/api-client";
import type {
  AiProvider,
  ModelSpeed,
  ProjectGitCreatePrNextStep,
  ProjectGitPullRequestDetailsResponse,
  ProjectGitStatusEntry,
  ReasoningEffort,
} from "@/types/ide";
import {
  gitChangesKey,
  selectCommitChanges,
} from "../../../electron/shared/git-changes.js";
import { projectResourceKey, readProjectResource } from "./project-resources";

export { selectCommitChanges };

/** The model a text is generated with. */
export interface GitGenerationSettings {
  model: string;
  modelSpeed: ModelSpeed;
  provider: AiProvider;
  reasoningEffort: ReasoningEffort | null;
}

export interface CommitMessageRequest extends GitGenerationSettings {
  /** The changes the commit takes (see `selectCommitChanges`). */
  changes: readonly ProjectGitStatusEntry[];
  includeUnstaged: boolean;
  hostId: string;
  projectPath: string;
}

export interface PullRequestDetailsRequest extends CommitMessageRequest {
  baseBranch: string;
  branch: string | null;
  nextStep: ProjectGitCreatePrNextStep;
  /** The project's git version (refresh key). */
  version: number;
}

const MAX_ENTRIES = 50;
const answers = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();

const remember = (key: string, value: unknown) => {
  answers.delete(key);
  answers.set(key, value);
  if (answers.size > MAX_ENTRIES) {
    const oldest = answers.keys().next().value;
    if (oldest !== undefined) answers.delete(oldest);
  }
};

/** The answer for `key`: kept, shared while under way, or loaded. */
const generate = <T>(
  key: string,
  load: () => Promise<T>,
  keep: (answer: T) => boolean,
): Promise<T> => {
  if (answers.has(key)) {
    return Promise.resolve(answers.get(key) as T);
  }
  const existing = pending.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const request = load();
  pending.set(key, request);
  request.then(
    (answer) => {
      if (keep(answer)) remember(key, answer);
    },
    () => undefined,
  );
  void request
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    })
    .catch(() => undefined);
  return request;
};

const commitMessageKey = ({
  changes,
  hostId,
  includeUnstaged,
  model,
  modelSpeed,
  projectPath,
  provider,
  reasoningEffort,
}: CommitMessageRequest) =>
  `commit\0${gitChangesKey(changes, {
    includeUnstaged,
    hostId,
    model,
    modelSpeed,
    projectPath,
    provider,
    reasoningEffort,
  })}`;

const pullRequestDetailsKey = (request: PullRequestDetailsRequest) =>
  `pull-request\0${gitChangesKey(request.changes, {
    baseBranch: request.baseBranch,
    branch: request.branch,
    includeUnstaged: request.includeUnstaged,
    hostId: request.hostId,
    model: request.model,
    modelSpeed: request.modelSpeed,
    nextStep: request.nextStep,
    projectPath: request.projectPath,
    provider: request.provider,
    reasoningEffort: request.reasoningEffort,
    version: request.version,
  })}`;

/** A commit message already generated for these changes, if any. */
export const cachedCommitMessage = (request: CommitMessageRequest) =>
  answers.get(commitMessageKey(request)) as string | undefined;

/** The commit message for these changes, generated once. */
export const generateCommitMessage = (request: CommitMessageRequest) =>
  generate(
    commitMessageKey(request),
    async () =>
      (
        await apiClient.gitCommitMessage(
          {
            includeUnstaged: request.includeUnstaged,
            model: request.model,
            modelSpeed: request.modelSpeed,
            projectPath: request.projectPath,
            provider: request.provider,
            reasoningEffort: request.reasoningEffort,
          },
          { hostId: request.hostId },
        )
      ).commitMessage.trim(),
    (message) => message.length > 0,
  );

/** Pull request details already generated for this request, if any. */
export const cachedPullRequestDetails = (request: PullRequestDetailsRequest) =>
  answers.get(pullRequestDetailsKey(request)) as
    | ProjectGitPullRequestDetailsResponse
    | undefined;

/** Pull request details for this request, generated once. */
export const generatePullRequestDetails = (
  request: PullRequestDetailsRequest,
) =>
  generate(
    pullRequestDetailsKey(request),
    () =>
      apiClient.gitPullRequestDetails(
        {
          baseBranch: request.baseBranch,
          includeUnstaged: request.includeUnstaged,
          model: request.model,
          modelSpeed: request.modelSpeed,
          nextStep: request.nextStep,
          projectPath: request.projectPath,
          provider: request.provider,
          reasoningEffort: request.reasoningEffort,
        },
        { hostId: request.hostId },
      ),
    (details) => Boolean(details.title || details.description),
  );

/**
 * Generates the project's commit message ahead of time (a turn ended), from
 * its current full status, so the Changes tab finds it ready. Never fails.
 */
export const warmProjectCommitMessage = async ({
  hostId,
  includeUnstaged = true,
  projectPath,
  ...settings
}: GitGenerationSettings & {
  /** The project's Host (`getProjectHostId`). */
  hostId: string;
  includeUnstaged?: boolean;
  projectPath: string;
}) => {
  try {
    // Read now: the turn that just ended may have changed files after the
    // last status read, and a delayed panel refresh may not have run yet.
    const status = await readProjectResource(
      projectResourceKey("gitStatus", projectPath, {
        hostId,
        params: { detail: "full" },
      }),
      { force: true },
    );
    const changes = selectCommitChanges(status.changes, includeUnstaged);
    if (changes.length === 0) return "";
    return await generateCommitMessage({
      ...settings,
      changes,
      includeUnstaged,
      hostId,
      projectPath,
    });
  } catch {
    return "";
  }
};

/** Forgets every generated text (tests). */
export const clearGeneratedGitText = () => {
  answers.clear();
  pending.clear();
};
