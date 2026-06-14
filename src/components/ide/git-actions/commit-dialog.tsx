import { Code, GitBranch, GitCommitHorizontal } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  AiProvider,
  ProjectGitCommitResponse,
  ProjectGitPushResponse,
  ProjectGitStatusResponse,
} from "@/types/ide";
import {
  generateCachedProjectCommitMessage,
  getCachedProjectCommitMessage,
  getCommitChanges,
} from "../git-commit-message-cache";
import { ActionError, DialogMetricRow, GitDialogHeader } from "./dialog-layout";
import { GitChangesDeltaSummary } from "./summary";
import { hasPushDestination, postJson } from "./utils";

type CommitSubmitAction = "commit" | "commit-push";

export const CommitDialog = ({
  branch,
  onCompleted,
  onOpenChange,
  open,
  projectPath,
  provider,
  refreshToken,
  status,
}: {
  branch: string | null;
  onCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectPath: string;
  provider: AiProvider;
  refreshToken: number;
  status: ProjectGitStatusResponse | null;
}) => {
  const [commitMessage, setCommitMessage] = useState("");
  const [autoGenerateMessage, setAutoGenerateMessage] = useState(true);
  const [generatingCommitMessage, setGeneratingCommitMessage] = useState(false);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [submittingAction, setSubmittingAction] =
    useState<CommitSubmitAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commitChanges = useMemo(
    () => getCommitChanges(status, includeUnstaged),
    [includeUnstaged, status],
  );
  const hasCommitChanges = commitChanges.length > 0;
  const canCommit =
    Boolean(commitMessage.trim()) &&
    hasCommitChanges &&
    !generatingCommitMessage;
  const canCommitPush = canCommit && hasPushDestination(status);

  useEffect(() => {
    if (!open) {
      return;
    }

    setAutoGenerateMessage(true);
    setCommitMessage("");
    setGeneratingCommitMessage(false);
    setIncludeUnstaged(true);
    setSubmittingAction(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!(open && autoGenerateMessage)) {
      setGeneratingCommitMessage(false);
      return;
    }

    if (!hasCommitChanges) {
      setCommitMessage("");
      setGeneratingCommitMessage(false);
      return;
    }

    const cachedMessage = getCachedProjectCommitMessage({
      changes: commitChanges,
      includeUnstaged,
      projectPath,
      provider,
      refreshToken,
    });
    if (cachedMessage !== undefined) {
      setCommitMessage(cachedMessage);
      setGeneratingCommitMessage(false);
      return;
    }

    let ignore = false;
    setCommitMessage("");
    setError(null);
    setGeneratingCommitMessage(true);
    void generateCachedProjectCommitMessage({
      changes: commitChanges,
      includeUnstaged,
      projectPath,
      provider,
      refreshToken,
    })
      .then((nextMessage) => {
        if (ignore) {
          return;
        }
        setCommitMessage(nextMessage);
      })
      .catch((error) => {
        if (ignore) {
          return;
        }
        setError(
          error instanceof Error
            ? error.message
            : "Unable to generate commit message.",
        );
      })
      .finally(() => {
        if (!ignore) {
          setGeneratingCommitMessage(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [
    autoGenerateMessage,
    commitChanges,
    hasCommitChanges,
    includeUnstaged,
    open,
    projectPath,
    provider,
    refreshToken,
  ]);

  const handleAutoGenerateMessageChange = useCallback(
    (nextChecked: boolean) => {
      setAutoGenerateMessage(nextChecked);
      setGeneratingCommitMessage(false);
      if (!nextChecked) {
        setCommitMessage("");
      }
    },
    [],
  );

  const handleSubmitAction = useCallback(
    async (action: CommitSubmitAction) => {
      if (
        submittingAction ||
        !canCommit ||
        (action === "commit-push" && !canCommitPush)
      ) {
        return;
      }

      setSubmittingAction(action);
      setError(null);
      try {
        if (action === "commit-push") {
          await postJson<ProjectGitPushResponse>("/api/project-git-push", {
            commitMessage,
            includeUnstaged,
            nextStep: "commit-push",
            projectPath,
          });
        } else {
          await postJson<ProjectGitCommitResponse>("/api/project-git-commit", {
            includeUnstaged,
            message: commitMessage,
            projectPath,
          });
        }
        onCompleted();
        onOpenChange(false);
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : action === "commit-push"
              ? "Unable to commit and push changes."
              : "Unable to commit changes.",
        );
      } finally {
        setSubmittingAction(null);
      }
    },
    [
      canCommit,
      canCommitPush,
      commitMessage,
      includeUnstaged,
      onCompleted,
      onOpenChange,
      projectPath,
      submittingAction,
    ],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await handleSubmitAction("commit");
    },
    [handleSubmitAction],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <GitDialogHeader
          icon={<GitCommitHorizontal />}
          title="Commit your changes"
        />

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <DialogMetricRow
              icon={<GitBranch className="size-4" />}
              label="Branch"
              value={<span className="truncate">{branch ?? "Unknown"}</span>}
            />
            <DialogMetricRow
              icon={<Code className="size-4" />}
              label="Changes"
              value={<GitChangesDeltaSummary changes={commitChanges} />}
            />
          </div>

          <label
            className="flex items-center gap-3 text-sm"
            htmlFor="commit-include-unstaged"
          >
            <Switch
              checked={includeUnstaged}
              id="commit-include-unstaged"
              onCheckedChange={setIncludeUnstaged}
            />
            <span>Include unstaged</span>
          </label>

          <label
            className="flex items-center gap-3 text-sm"
            htmlFor="commit-auto-generate-message"
          >
            <Switch
              checked={autoGenerateMessage}
              id="commit-auto-generate-message"
              onCheckedChange={handleAutoGenerateMessageChange}
            />
            <span>Auto generate message</span>
          </label>

          <div className="space-y-3">
            <label className="font-medium text-sm" htmlFor="commit-message">
              Commit message
            </label>
            <div className="relative">
              <Textarea
                aria-busy={generatingCommitMessage}
                className="min-h-24 resize-none"
                id="commit-message"
                readOnly={autoGenerateMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder={
                  generatingCommitMessage ? "" : "Enter a commit message"
                }
                value={commitMessage}
              />
              {generatingCommitMessage ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
                  <Shimmer as="span" duration={1.5}>
                    Generating commit message...
                  </Shimmer>
                </div>
              ) : null}
            </div>
          </div>

          <ActionError error={error} />

          <div className="flex justify-end gap-2">
            <Button
              className="min-w-36"
              disabled={Boolean(submittingAction) || !canCommit}
              type="submit"
              variant="outline"
            >
              {submittingAction === "commit" ? (
                <Spinner className="size-4" />
              ) : null}
              <span>Commit</span>
            </Button>
            <Button
              className="min-w-36"
              disabled={Boolean(submittingAction) || !canCommitPush}
              onClick={() => {
                void handleSubmitAction("commit-push");
              }}
              type="button"
            >
              {submittingAction === "commit-push" ? (
                <Spinner className="size-4" />
              ) : null}
              <span>Commit & push</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
