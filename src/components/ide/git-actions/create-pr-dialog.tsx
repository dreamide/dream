import {
  ArrowUp,
  Code,
  GitCommitHorizontal,
  GitPullRequest,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  ProjectGitCreatePrNextStep,
  ProjectGitCreatePrResponse,
  ProjectGitStatusResponse,
} from "@/types/ide";
import { getPullRequestBranchError } from "./branch-utils";
import {
  ActionError,
  DialogMetricRow,
  GitDialogHeader,
  NextStepSelector,
} from "./dialog-layout";
import { GitDeltaSummary } from "./summary";
import { getStatusFileCount, postJson } from "./utils";

export const CreatePrDialog = ({
  branch,
  onCompleted,
  onOpenChange,
  open,
  projectPath,
  status,
}: {
  branch: string | null;
  onCompleted: (url: string | null, openPrPage: boolean) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectPath: string;
  status: ProjectGitStatusResponse | null;
}) => {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(true);
  const [openPrPage, setOpenPrPage] = useState(false);
  const [nextStep, setNextStep] =
    useState<ProjectGitCreatePrNextStep>("create");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasChanges = getStatusFileCount(status) > 0;
  const needsPush = !status?.upstreamBranch || (status.aheadCount ?? 0) > 0;
  const baseBranch = status?.baseBranch ?? "main";
  const branchError = getPullRequestBranchError(branch, baseBranch);

  useEffect(() => {
    if (!open) {
      return;
    }

    setTitle("");
    setDescription("");
    setDraft(true);
    setOpenPrPage(false);
    setNextStep(
      hasChanges ? "commit-push-create" : needsPush ? "push-create" : "create",
    );
    setError(null);
  }, [hasChanges, needsPush, open]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }
      if (branchError) {
        setError(branchError);
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        const response = await postJson<ProjectGitCreatePrResponse>(
          "/api/project-git-create-pr",
          {
            baseBranch,
            commitMessage: null,
            description,
            draft,
            includeUnstaged: true,
            nextStep,
            openPrPage,
            projectPath,
            title,
          },
        );
        onCompleted(response.url, openPrPage);
        onOpenChange(false);
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "Unable to create a pull request.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      baseBranch,
      branchError,
      description,
      draft,
      nextStep,
      onCompleted,
      onOpenChange,
      openPrPage,
      projectPath,
      submitting,
      title,
    ],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <GitDialogHeader
          icon={<GitPullRequest />}
          subtitle={
            <>
              {baseBranch} -&gt; {branch ?? "current branch"}
            </>
          }
          title="Create PR"
        />

        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogMetricRow
            icon={<Code className="size-4" />}
            label="Changes"
            value={<GitDeltaSummary status={status} />}
          />

          <div className="space-y-2">
            <label className="font-medium text-sm" htmlFor="pr-title">
              Title
            </label>
            <Input
              id="pr-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Leave blank to generate"
              value={title}
            />
          </div>

          <div className="space-y-2">
            <label className="font-medium text-sm" htmlFor="pr-description">
              Description
            </label>
            <Textarea
              className="min-h-32 resize-none"
              id="pr-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Leave blank to generate"
              value={description}
            />
          </div>

          <div className="space-y-2">
            <div className="font-medium text-sm">Next steps</div>
            <NextStepSelector<ProjectGitCreatePrNextStep>
              idPrefix="pr-next-step"
              onValueChange={setNextStep}
              options={[
                {
                  disabled: Boolean(branchError),
                  icon: <GitPullRequest />,
                  label: "Create PR",
                  value: "create",
                },
                {
                  disabled: Boolean(branchError),
                  icon: <ArrowUp />,
                  label: "Push & create PR",
                  value: "push-create",
                },
                {
                  disabled: !hasChanges || Boolean(branchError),
                  icon: <GitCommitHorizontal />,
                  label: "Commit, push & create PR",
                  value: "commit-push-create",
                },
              ]}
              value={nextStep}
            />
          </div>

          <ActionError error={error ?? branchError} />

          <div className="flex flex-wrap items-center gap-4">
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor="pr-draft"
            >
              <Switch
                checked={draft}
                id="pr-draft"
                onCheckedChange={setDraft}
              />
              <span>Draft</span>
            </label>
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor="pr-open-page"
            >
              <Switch
                checked={openPrPage}
                id="pr-open-page"
                onCheckedChange={setOpenPrPage}
              />
              <span>Open PR page</span>
            </label>
            <Button
              className="ml-auto min-w-36"
              disabled={submitting || Boolean(branchError)}
              type="submit"
            >
              {submitting ? <Spinner className="size-4" /> : null}
              <span>Create PR</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
