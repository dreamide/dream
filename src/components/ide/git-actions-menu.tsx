import {
  ArrowUp,
  Check,
  Code,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  UploadCloud,
} from "lucide-react";
import {
  type FormEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { cn } from "@/lib/utils";
import type {
  ProjectGitCommitResponse,
  ProjectGitCreatePrNextStep,
  ProjectGitCreatePrResponse,
  ProjectGitPushNextStep,
  ProjectGitPushResponse,
  ProjectGitStatusResponse,
} from "@/types/ide";
import { useIdeStore } from "./ide-store";

type GitActionDialog = "commit" | "push" | "pr" | null;
type ActiveGitActionDialog = Exclude<GitActionDialog, null>;

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const postJson = async <T,>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readResponseText(response));
  }

  return (await response.json()) as T;
};

const formatFileCount = (count: number) =>
  `${count} ${count === 1 ? "file" : "files"}`;

const formatDelta = (value: number, prefix: "+" | "-") => `${prefix}${value}`;

const getStatusFileCount = (status: ProjectGitStatusResponse | null) =>
  status?.fileCount ?? status?.changes.length ?? 0;

const getStatusAddedLines = (status: ProjectGitStatusResponse | null) =>
  status?.addedLines ??
  status?.changes.reduce((total, change) => total + change.addedLines, 0) ??
  0;

const getStatusRemovedLines = (status: ProjectGitStatusResponse | null) =>
  status?.removedLines ??
  status?.changes.reduce((total, change) => total + change.removedLines, 0) ??
  0;

const GitDeltaSummary = ({
  showFileCount = true,
  status,
}: {
  showFileCount?: boolean;
  status: ProjectGitStatusResponse | null;
}) => (
  <div className="flex shrink-0 items-center gap-2 font-mono text-sm tabular-nums">
    {showFileCount ? (
      <span className="text-muted-foreground">
        {formatFileCount(getStatusFileCount(status))}
      </span>
    ) : null}
    <span className="font-medium text-emerald-500">
      {formatDelta(getStatusAddedLines(status), "+")}
    </span>
    <span className="font-medium text-rose-500">
      {formatDelta(getStatusRemovedLines(status), "-")}
    </span>
  </div>
);

type NextStepOption<Value extends string> = {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  value: Value;
};

const NextStepSelector = <Value extends string>({
  idPrefix,
  onValueChange,
  options,
  value,
}: {
  idPrefix: string;
  onValueChange: (value: Value) => void;
  options: NextStepOption<Value>[];
  value: Value;
}) => (
  <RadioGroup
    className="gap-0 overflow-hidden rounded-lg border border-foreground/10 bg-muted/35"
    onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    value={value}
  >
    {options.map((option, index) => {
      const checked = option.value === value;
      const optionId = `${idPrefix}-${option.value}`;
      return (
        <label
          className={cn(
            "flex h-12 items-center gap-3 px-3 text-sm transition-colors",
            index > 0 ? "border-t border-foreground/10" : "",
            option.disabled
              ? "cursor-not-allowed text-muted-foreground/45"
              : "cursor-pointer text-foreground hover:bg-muted/55",
          )}
          htmlFor={optionId}
          key={option.value}
        >
          <RadioGroupItem
            className="sr-only"
            disabled={option.disabled}
            id={optionId}
            value={option.value}
          />
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
            {option.icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          <Check
            className={cn(
              "size-4 shrink-0 transition-opacity",
              checked ? "opacity-100" : "opacity-0",
            )}
          />
        </label>
      );
    })}
  </RadioGroup>
);

const DialogIcon = ({ children }: { children: ReactNode }) => (
  <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-foreground [&_svg]:size-6">
    {children}
  </div>
);

const DialogMetricRow = ({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) => (
  <div className="flex min-h-8 items-center justify-between gap-4 text-sm">
    <div className="font-medium">{label}</div>
    <div className="min-w-0 text-right text-muted-foreground">{value}</div>
  </div>
);

const CustomInstructionsToggle = ({ onClick }: { onClick: () => void }) => (
  <button
    className="text-muted-foreground text-sm transition-colors hover:text-foreground"
    onClick={onClick}
    type="button"
  >
    Custom instructions
  </button>
);

const ActionError = ({ error }: { error: string | null }) =>
  error ? (
    <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
      {error}
    </div>
  ) : null;

const CommitDialog = ({
  branch,
  onCompleted,
  onOpenChange,
  open,
  projectPath,
  status,
}: {
  branch: string | null;
  onCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectPath: string;
  status: ProjectGitStatusResponse | null;
}) => {
  const [commitMessage, setCommitMessage] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [showCustomInstructions, setShowCustomInstructions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setCommitMessage("");
    setCustomInstructions("");
    setIncludeUnstaged(true);
    setShowCustomInstructions(false);
    setError(null);
  }, [open]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await postJson<ProjectGitCommitResponse>("/api/project-git-commit", {
          customInstructions,
          includeUnstaged,
          message: commitMessage,
          projectPath,
        });
        onCompleted();
        onOpenChange(false);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Unable to commit changes.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      commitMessage,
      customInstructions,
      includeUnstaged,
      onCompleted,
      onOpenChange,
      projectPath,
      submitting,
    ],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <DialogHeader className="gap-4">
          <DialogIcon>
            <GitCommitHorizontal />
          </DialogIcon>
          <DialogTitle className="text-2xl">Commit your changes</DialogTitle>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <DialogMetricRow
              label="Branch"
              value={
                <span className="inline-flex min-w-0 items-center gap-2 text-foreground">
                  <GitBranch className="size-4 shrink-0" />
                  <span className="truncate">{branch ?? "Unknown"}</span>
                </span>
              }
            />
            <DialogMetricRow
              label="Changes"
              value={<GitDeltaSummary status={status} />}
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

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="font-medium text-sm" htmlFor="commit-message">
                Commit message
              </label>
              <CustomInstructionsToggle
                onClick={() => setShowCustomInstructions((current) => !current)}
              />
            </div>
            <Textarea
              className="min-h-24 resize-none"
              id="commit-message"
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Leave blank to autogenerate a commit message"
              value={commitMessage}
            />
            {showCustomInstructions ? (
              <Textarea
                className="min-h-20 resize-none"
                onChange={(event) => setCustomInstructions(event.target.value)}
                placeholder="Optional generation instructions"
                value={customInstructions}
              />
            ) : null}
          </div>

          <ActionError error={error} />

          <div className="flex justify-end">
            <Button className="min-w-36" disabled={submitting} type="submit">
              {submitting ? <Spinner className="size-4" /> : null}
              <span>Continue</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const PushDialog = ({
  branch,
  onCompleted,
  onOpenChange,
  open,
  projectPath,
  status,
}: {
  branch: string | null;
  onCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectPath: string;
  status: ProjectGitStatusResponse | null;
}) => {
  const [nextStep, setNextStep] = useState<ProjectGitPushNextStep>("push");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasChanges = getStatusFileCount(status) > 0;

  useEffect(() => {
    if (!open) {
      return;
    }

    setNextStep(hasChanges ? "commit-push" : "push");
    setError(null);
  }, [hasChanges, open]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await postJson<ProjectGitPushResponse>("/api/project-git-push", {
          commitMessage: null,
          customInstructions: null,
          includeUnstaged: true,
          nextStep,
          projectPath,
        });
        onCompleted();
        onOpenChange(false);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Unable to push changes.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [nextStep, onCompleted, onOpenChange, projectPath, submitting],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <DialogHeader className="gap-4">
          <DialogIcon>
            <UploadCloud />
          </DialogIcon>
          <DialogTitle className="text-2xl">Push changes</DialogTitle>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogMetricRow
            label={
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <GitBranch className="size-4" />
                Branch
              </span>
            }
            value={
              <span className="text-foreground">{branch ?? "Unknown"}</span>
            }
          />

          <div className="space-y-2">
            <div className="font-medium text-sm">Next steps</div>
            <NextStepSelector<ProjectGitPushNextStep>
              idPrefix="push-next-step"
              onValueChange={setNextStep}
              options={[
                {
                  icon: <ArrowUp />,
                  label: "Push",
                  value: "push",
                },
                {
                  disabled: !hasChanges,
                  icon: <GitCommitHorizontal />,
                  label: "Commit & push",
                  value: "commit-push",
                },
              ]}
              value={nextStep}
            />
          </div>

          <ActionError error={error} />

          <div className="flex justify-end">
            <Button className="min-w-36" disabled={submitting} type="submit">
              {submitting ? <Spinner className="size-4" /> : null}
              <span>Continue</span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const CreatePrDialog = ({
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
  const [customInstructions, setCustomInstructions] = useState("");
  const [draft, setDraft] = useState(true);
  const [openPrPage, setOpenPrPage] = useState(false);
  const [nextStep, setNextStep] =
    useState<ProjectGitCreatePrNextStep>("create");
  const [showCustomInstructions, setShowCustomInstructions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasChanges = getStatusFileCount(status) > 0;
  const needsPush = !status?.upstreamBranch || (status.aheadCount ?? 0) > 0;
  const baseBranch = status?.baseBranch ?? "main";

  useEffect(() => {
    if (!open) {
      return;
    }

    setTitle("");
    setDescription("");
    setCustomInstructions("");
    setDraft(true);
    setOpenPrPage(false);
    setNextStep(
      hasChanges ? "commit-push-create" : needsPush ? "push-create" : "create",
    );
    setShowCustomInstructions(false);
    setError(null);
  }, [hasChanges, needsPush, open]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
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
            customInstructions,
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
      customInstructions,
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
        <DialogHeader className="gap-4">
          <DialogIcon>
            <GitPullRequest />
          </DialogIcon>
          <DialogTitle className="text-2xl">Create PR</DialogTitle>
          <div className="text-muted-foreground text-sm">
            {baseBranch} -&gt; {branch ?? "current branch"}
          </div>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogMetricRow
            label="Changes"
            value={<GitDeltaSummary status={status} />}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="font-medium text-sm" htmlFor="pr-title">
                Title
              </label>
              <CustomInstructionsToggle
                onClick={() => setShowCustomInstructions((current) => !current)}
              />
            </div>
            <Input
              id="pr-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Leave blank to generate"
              value={title}
            />
            {showCustomInstructions ? (
              <Textarea
                className="min-h-20 resize-none"
                onChange={(event) => setCustomInstructions(event.target.value)}
                placeholder="Optional generation instructions"
                value={customInstructions}
              />
            ) : null}
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
                  icon: <GitPullRequest />,
                  label: "Create PR",
                  value: "create",
                },
                {
                  icon: <ArrowUp />,
                  label: "Push & create PR",
                  value: "push-create",
                },
                {
                  disabled: !hasChanges,
                  icon: <GitCommitHorizontal />,
                  label: "Commit, push & create PR",
                  value: "commit-push-create",
                },
              ]}
              value={nextStep}
            />
          </div>

          <ActionError error={error} />

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
              disabled={submitting}
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

interface GitActionsMenuProps {
  projectId: string;
  projectPath: string;
}

const GitActionDialogHost = ({
  action,
  onActionCompleted,
  onOpenChange,
  onPrCompleted,
  projectId,
  projectPath,
}: {
  action: ActiveGitActionDialog;
  onActionCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  onPrCompleted: (url: string | null, shouldOpen: boolean) => void;
  projectId: string;
  projectPath: string;
}) => {
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
  const { branch, status } = useProjectGitStatus(projectPath, gitRefreshKey);

  if (action === "commit") {
    return (
      <CommitDialog
        branch={branch}
        onCompleted={onActionCompleted}
        onOpenChange={onOpenChange}
        open
        projectPath={projectPath}
        status={status}
      />
    );
  }

  if (action === "push") {
    return (
      <PushDialog
        branch={branch}
        onCompleted={onActionCompleted}
        onOpenChange={onOpenChange}
        open
        projectPath={projectPath}
        status={status}
      />
    );
  }

  return (
    <CreatePrDialog
      branch={branch}
      onCompleted={onPrCompleted}
      onOpenChange={onOpenChange}
      open
      projectPath={projectPath}
      status={status}
    />
  );
};

const GitActionsMenuImpl = ({
  projectId,
  projectPath,
}: GitActionsMenuProps) => {
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const setProjectRightPanelOpen = useIdeStore(
    (s) => s.setProjectRightPanelOpen,
  );
  const setProjectRightPanelView = useIdeStore(
    (s) => s.setProjectRightPanelView,
  );
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  const [activeDialog, setActiveDialog] = useState<GitActionDialog>(null);

  const handleOpenChanges = useCallback(() => {
    setProjectRightPanelView(projectId, "changes");
    setProjectRightPanelOpen(projectId, true);
  }, [projectId, setProjectRightPanelOpen, setProjectRightPanelView]);

  const handleOpenDialog = useCallback((dialog: GitActionDialog) => {
    setActiveDialog(dialog);
  }, []);

  const handleActionCompleted = useCallback(() => {
    bumpProjectGitRefreshKey(projectId);
  }, [bumpProjectGitRefreshKey, projectId]);

  const handlePrCompleted = useCallback(
    (url: string | null, shouldOpen: boolean) => {
      handleActionCompleted();
      if (url && shouldOpen) {
        openExternalUrl(url);
      }
    },
    [handleActionCompleted, openExternalUrl],
  );

  const handleDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setActiveDialog(null);
    }
  }, []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="Open Git actions"
              className="size-8 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
              size="icon"
              title="Git actions"
              variant="ghost"
            />
          }
        >
          <GitBranch className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-52 [-webkit-app-region:no-drag]"
        >
          <DropdownMenuItem onClick={handleOpenChanges}>
            <Code className="size-4" />
            Changes
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleOpenDialog("commit")}>
            <GitCommitHorizontal className="size-4" />
            Commit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleOpenDialog("push")}>
            <UploadCloud className="size-4" />
            Push
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleOpenDialog("pr")}>
            <GitPullRequest className="size-4" />
            Create pull request
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {activeDialog ? (
        <GitActionDialogHost
          action={activeDialog}
          onActionCompleted={handleActionCompleted}
          onOpenChange={handleDialogOpenChange}
          onPrCompleted={handlePrCompleted}
          projectId={projectId}
          projectPath={projectPath}
        />
      ) : null}
    </>
  );
};

export const GitActionsMenu = memo(GitActionsMenuImpl);
GitActionsMenu.displayName = "GitActionsMenu";
