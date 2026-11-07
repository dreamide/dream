/**
 * A commit being written: its message, whether it takes unstaged changes,
 * whether the message is generated, and committing it (or committing and
 * pushing). The Changes tab's commit box and the commit dialog both render
 * one; they differ only in layout and in what follows a commit.
 *
 * With generation on, the message is the one generated for the changes the
 * commit takes (git-generated-text.ts): shown at once when it already
 * exists, else generated, and a generation the inputs have since overtaken
 * is ignored. While generation may not run (the panel is hidden, its status
 * is not current, an agent is still writing) the message stays as it is.
 */
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-client";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type {
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";
import {
  type CommitMessageRequest,
  cachedCommitMessage,
  type GitGenerationSettings,
  generateCommitMessage,
  selectCommitChanges,
} from "../git-generated-text";
import { useIdeStore } from "../ide-store";
import type { GitWriteOutcome } from "../store/ide-store-types";
import { hasPushDestination } from "./utils";

const PUSH_FAILURE_TOAST_DURATION_MS = 8000;

export type CommitAction = "commit" | "commit-push";

export interface CommitDraftInputs extends GitGenerationSettings {
  hostId: string;
  projectPath: string;
  /** A full status read of the project (or worktree) being committed. */
  status: ProjectGitStatusResponse | null;
  /** Whether a message may be generated now. */
  canGenerate: boolean;
}

/** Why the draft failed; the composer puts it into words. */
export type CommitDraftError =
  | { kind: "generate" }
  | { kind: "submit"; action: CommitAction; error: unknown };

export interface CommitDraftSnapshot {
  autoGenerate: boolean;
  /** The changes the commit takes. */
  changes: ProjectGitStatusEntry[];
  canCommit: boolean;
  canCommitPush: boolean;
  error: CommitDraftError | null;
  generating: boolean;
  includeUnstaged: boolean;
  message: string;
  submitting: CommitAction | null;
}

/** What a commit sends: the message, which changes, and whether to push. */
export interface CommitRequest {
  includeUnstaged: boolean;
  message: string;
  push: boolean;
}

export interface CommitDraftDependencies {
  /** Commits (and pushes) the project; the store's `commitProject`. */
  commit: (request: CommitRequest) => Promise<GitWriteOutcome<unknown>>;
  /**
   * A commit-and-push failed. The commit may have landed before the push did,
   * leaving nothing to commit and so no composer to show the error in.
   */
  onPushFailure: (error: unknown) => void;
  text?: {
    cached: (request: CommitMessageRequest) => string | undefined;
    generate: (request: CommitMessageRequest) => Promise<string>;
  };
}

const INITIAL: CommitDraftSnapshot = {
  autoGenerate: true,
  canCommit: false,
  canCommitPush: false,
  changes: [],
  error: null,
  generating: false,
  includeUnstaged: true,
  message: "",
  submitting: null,
};

export class CommitDraft {
  readonly #commit: CommitDraftDependencies["commit"];
  readonly #onPushFailure: CommitDraftDependencies["onPushFailure"];
  readonly #text: NonNullable<CommitDraftDependencies["text"]>;
  readonly #listeners = new Set<() => void>();
  #inputs: CommitDraftInputs | null = null;
  #snapshot = INITIAL;
  /** Bumped by anything that makes a generation under way stale. */
  #generation = 0;

  constructor({
    commit,
    onPushFailure,
    text = { cached: cachedCommitMessage, generate: generateCommitMessage },
  }: CommitDraftDependencies) {
    this.#commit = commit;
    this.#onPushFailure = onPushFailure;
    this.#text = text;
  }

  getSnapshot = (): CommitDraftSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The project, status, model or permission to generate changed. */
  update(inputs: CommitDraftInputs) {
    this.#inputs = inputs;
    this.#set({});
    this.#syncMessage();
  }

  setMessage(message: string) {
    this.#set({ message });
  }

  setIncludeUnstaged(includeUnstaged: boolean) {
    this.#set({ includeUnstaged });
    this.#syncMessage();
  }

  /** Turning generation off clears the message for the user to write. */
  setAutoGenerate(autoGenerate: boolean) {
    this.#set({
      autoGenerate,
      generating: false,
      ...(autoGenerate ? {} : { message: "" }),
    });
    this.#syncMessage();
  }

  /** Back to a fresh draft (a dialog opening). */
  reset() {
    this.#generation += 1;
    this.#snapshot = INITIAL;
    this.#set({});
    this.#syncMessage();
  }

  /** Ignores any generation still under way (the composer went away). */
  dispose() {
    this.#generation += 1;
  }

  /** Commits, or commits and pushes. True when it went through. */
  async submit(action: CommitAction): Promise<boolean> {
    const draft = this.#snapshot;
    if (
      !this.#inputs ||
      draft.submitting !== null ||
      !draft.canCommit ||
      (action === "commit-push" && !draft.canCommitPush)
    ) {
      return false;
    }

    this.#set({ error: null, submitting: action });
    const outcome = await this.#commit({
      includeUnstaged: draft.includeUnstaged,
      message: draft.message,
      push: action === "commit-push",
    });
    if (outcome.ok) {
      this.#set({ message: "", submitting: null });
      return true;
    }
    if (action === "commit-push") {
      // Reported once, past the composer: the commit has usually landed, so
      // the composer is about to empty and an error shown in it only flashes.
      this.#set({ submitting: null });
      this.#onPushFailure(outcome.error);
      return false;
    }
    this.#set({
      error: { action, error: outcome.error, kind: "submit" },
      submitting: null,
    });
    return false;
  }

  /** Applies `next` and re-derives what follows from it. */
  #set(next: Partial<CommitDraftSnapshot>) {
    const merged = { ...this.#snapshot, ...next };
    const status = this.#inputs?.status ?? null;
    const changes = selectCommitChanges(
      status?.changes,
      merged.includeUnstaged,
    );
    const canCommit =
      changes.length > 0 &&
      merged.message.trim().length > 0 &&
      !merged.generating &&
      merged.submitting === null;
    this.#snapshot = {
      ...merged,
      canCommit,
      canCommitPush: canCommit && hasPushDestination(status),
      changes,
    };
    for (const listener of this.#listeners) listener();
  }

  /** Shows, generates or keeps the message, as the inputs now allow. */
  #syncMessage() {
    this.#generation += 1;
    const generation = this.#generation;
    const inputs = this.#inputs;
    const { autoGenerate, changes, includeUnstaged } = this.#snapshot;
    if (!inputs || !autoGenerate || !inputs.canGenerate) {
      if (this.#snapshot.generating) this.#set({ generating: false });
      return;
    }
    if (changes.length === 0) {
      this.#set({ generating: false, message: "" });
      return;
    }

    const request: CommitMessageRequest = {
      changes,
      includeUnstaged,
      hostId: inputs.hostId,
      model: inputs.model,
      modelSpeed: inputs.modelSpeed,
      projectPath: inputs.projectPath,
      provider: inputs.provider,
      reasoningEffort: inputs.reasoningEffort,
    };
    const cached = this.#text.cached(request);
    if (cached !== undefined) {
      this.#set({ generating: false, message: cached });
      return;
    }

    this.#set({ error: null, generating: true, message: "" });
    this.#text.generate(request).then(
      (message) => {
        if (generation === this.#generation) {
          this.#set({ generating: false, message });
        }
      },
      () => {
        if (generation === this.#generation) {
          this.#set({ error: { kind: "generate" }, generating: false });
        }
      },
    );
  }
}

/**
 * A commit draft for one composer, kept in step with its inputs; it commits
 * `projectId` through the store's git writes (store/git-write-actions.ts).
 */
export const useCommitDraft = ({
  canGenerate,
  model,
  modelSpeed,
  projectId,
  projectPath,
  provider,
  reasoningEffort,
  status,
}: Omit<CommitDraftInputs, "hostId"> & { projectId: string }) => {
  const hostId = useIdeStore(
    (state) =>
      [...state.projects, ...state.closedProjects].find(
        (project) => project.id === projectId,
      )?.hostId ?? LOCAL_HOST_ID,
  );
  const gitT = useTranslations("git");
  const gitTRef = useRef(gitT);
  gitTRef.current = gitT;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [draft] = useState(
    () =>
      new CommitDraft({
        commit: (request) =>
          useIdeStore.getState().commitProject(projectIdRef.current, request),
        onPushFailure: (error) => {
          toast.error(
            getApiErrorMessage(error, gitTRef.current("unableToCommitAndPush")),
            { duration: PUSH_FAILURE_TOAST_DURATION_MS },
          );
        },
      }),
  );
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  // Another git write of the project (a push from the footer...) is
  // running: a commit now would be refused, so the composer waits.
  const projectWrite = useIdeStore(
    (s) => s.gitWriteByProject[projectId] ?? null,
  );
  const busy = projectWrite !== null && snapshot.submitting === null;

  useEffect(() => {
    draft.update({
      canGenerate,
      hostId,
      model,
      modelSpeed,
      projectPath,
      provider,
      reasoningEffort,
      status,
    });
  }, [
    canGenerate,
    draft,
    hostId,
    model,
    modelSpeed,
    projectPath,
    provider,
    reasoningEffort,
    status,
  ]);

  useEffect(() => () => draft.dispose(), [draft]);

  return { busy, draft, snapshot };
};

/** A draft's error in words, for either composer. */
export const useCommitDraftErrorText = (error: CommitDraftError | null) => {
  const gitT = useTranslations("git");
  if (!error) return null;
  if (error.kind === "generate") return gitT("unableToGenerateCommitMessage");
  return getApiErrorMessage(
    error.error,
    error.action === "commit-push"
      ? gitT("unableToCommitAndPush")
      : gitT("unableToCommit"),
  );
};
