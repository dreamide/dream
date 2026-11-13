import { useTranslations } from "next-intl";
import { type KeyboardEvent, memo, useCallback, useMemo, useRef } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import type { ProjectGitStatusResponse } from "@/types/ide";
import { isProjectRunning as isAgentRunningIn } from "../chat-activity";
import {
  type CommitAction,
  useCommitDraft,
  useCommitDraftErrorText,
} from "../git-actions/commit-draft";
import { GitChangesDeltaSummary } from "../git-actions/summary";
import { useIdeStore } from "../ide-store";
import { useCommitMessageFocusRequest } from "./show-git-panel";

/**
 * The Changes tab's commit composer (git-actions/commit-draft.ts): whether
 * to include unstaged changes, whether to generate the message (on by
 * default, read from the message generated after the last agent turn when
 * there is one), the message, and Commit or Commit & push.
 */
const GitCommitBoxImpl = ({
  active,
  projectId,
  projectPath,
  status,
  statusReady,
}: {
  /** Whether the Changes tab is the one shown in a visible Git panel. */
  active: boolean;
  projectId: string;
  projectPath: string;
  /** A full status read. */
  status: ProjectGitStatusResponse | null;
  statusReady: boolean;
}) => {
  const gitT = useTranslations("git");
  // An agent is changing the project's files, here or from another client.
  const isProjectRunning = useIdeStore((s) => isAgentRunningIn(s, projectId));
  const settings = useIdeStore((s) => s.settings);
  const generation = useMemo(
    () => getDefaultGitGenerationModelSelection(settings),
    [settings],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Keep the last message while an agent is working; generate from a
  // current status once all of the project's turns have ended. The
  // background generation at turn completion shares this request.
  const { busy, draft, snapshot } = useCommitDraft({
    ...generation,
    canGenerate: active && statusReady && !isProjectRunning,
    projectId,
    projectPath,
    status,
  });
  const {
    autoGenerate,
    canCommit,
    canCommitPush,
    changes,
    generating,
    includeUnstaged,
    message,
    submitting,
  } = snapshot;
  const error = useCommitDraftErrorText(snapshot.error);
  const hasChanges = changes.length > 0;

  const focusMessage = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    // Without scrolling: the panel may still be sliding in from offscreen,
    // and scrolling it into view would shift the whole workspace sideways.
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  useCommitMessageFocusRequest(projectId, active, focusMessage);

  const handleCommit = useCallback(
    async (action: CommitAction) => {
      if (busy || !(action === "commit-push" ? canCommitPush : canCommit)) {
        return;
      }
      // The commit refreshes the project's git state itself.
      await draft.submit(action);
    },
    [busy, canCommit, canCommitPush, draft],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleCommit(event.shiftKey ? "commit-push" : "commit");
      }
    },
    [handleCommit],
  );

  return (
    <div className="space-y-3 border-b border-surface-200 px-3 py-3 dark:border-surface-800">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label
          className="mr-auto font-medium text-xs"
          htmlFor={`commit-message-${projectId}`}
        >
          {gitT("commitMessage")}
        </label>
        <label
          className="flex items-center gap-2 text-xs"
          htmlFor={`commit-include-unstaged-${projectId}`}
        >
          <Switch
            checked={includeUnstaged}
            id={`commit-include-unstaged-${projectId}`}
            onCheckedChange={(checked) => draft.setIncludeUnstaged(checked)}
          />
          <span>{gitT("includeUnstaged")}</span>
        </label>
        <label
          className="flex items-center gap-2 text-xs"
          htmlFor={`commit-auto-generate-${projectId}`}
        >
          <Switch
            checked={autoGenerate}
            id={`commit-auto-generate-${projectId}`}
            onCheckedChange={(checked) => draft.setAutoGenerate(checked)}
          />
          <span>{gitT("autoGenerateMessage")}</span>
        </label>
      </div>

      <div className="relative">
        <Textarea
          aria-busy={generating}
          className="max-h-40 min-h-16 resize-none text-sm"
          disabled={submitting !== null}
          id={`commit-message-${projectId}`}
          onChange={(event) => draft.setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={generating ? "" : gitT("enterCommitMessage")}
          readOnly={autoGenerate}
          ref={textareaRef}
          value={message}
        />
        {generating ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
            <Shimmer as="span" duration={1.5}>
              {gitT("generatingCommitMessage")}
            </Shimmer>
          </div>
        ) : null}
      </div>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      <div className="flex items-center gap-2">
        {hasChanges ? (
          <GitChangesDeltaSummary changes={changes} showFileIcon />
        ) : null}
        <Button
          className="ml-auto"
          disabled={busy || !canCommit}
          onClick={() => {
            void handleCommit("commit");
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {submitting === "commit" ? <Spinner className="size-3.5" /> : null}
          {gitT("commit")}
        </Button>
        <Button
          disabled={busy || !canCommitPush}
          onClick={() => {
            void handleCommit("commit-push");
          }}
          size="sm"
          type="button"
        >
          {submitting === "commit-push" ? (
            <Spinner className="size-3.5" />
          ) : null}
          {gitT("commitAndPush")}
        </Button>
      </div>
    </div>
  );
};

export const GitCommitBox = memo(GitCommitBoxImpl);
GitCommitBox.displayName = "GitCommitBox";
