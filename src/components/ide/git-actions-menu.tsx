import {
  ArrowUp,
  Check,
  Code,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  UploadCloud,
} from "lucide-react";
import {
  type FormEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  AiProvider,
  ProjectGitCommitResponse,
  ProjectGitCreatePrNextStep,
  ProjectGitCreatePrResponse,
  ProjectGitPushResponse,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";
import {
  generateCachedProjectCommitMessage,
  getCachedProjectCommitMessage,
  getCommitChanges,
} from "./git-commit-message-cache";
import { useIdeStore } from "./ide-store";

type GitActionDialog = "commit" | "push" | "pr" | null;
type ActiveGitActionDialog = Exclude<GitActionDialog, null>;
type CommitSubmitAction = "commit" | "commit-push";

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

const getChangesAddedLines = (changes: ProjectGitStatusEntry[]) =>
  changes.reduce((total, change) => total + change.addedLines, 0);

const getChangesRemovedLines = (changes: ProjectGitStatusEntry[]) =>
  changes.reduce((total, change) => total + change.removedLines, 0);

const getGitFileSubjectOverride = (filePath: string) => {
  switch (filePath) {
    case "src/components/ide/assistant-message-part.tsx":
      return "assistant message chips";
    case "src/components/ide/git-actions-menu.tsx":
      return "git action dialog behavior";
    default:
      return null;
  }
};

const formatGitFileSubject = (filePath: string) => {
  const override = getGitFileSubjectOverride(filePath);
  if (override) {
    return override;
  }

  const baseName =
    filePath
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/\.[^.]+$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase() ?? "";

  return baseName || "project files";
};

const formatCommitSubjectList = (changes: ProjectGitStatusEntry[]) => {
  const subjects = Array.from(
    new Set(
      changes
        .map((change) => formatGitFileSubject(change.path))
        .filter((subject) => subject !== "project files"),
    ),
  );

  if (subjects.length === 0) {
    return "project files";
  }

  if (subjects.length === 1) {
    return subjects[0];
  }

  if (subjects.length === 2) {
    return `${subjects[0]} and ${subjects[1]}`;
  }

  return `${subjects[0]}, ${subjects[1]}, and ${
    subjects.length - 2
  } more files`;
};

const getCommitMessageVerb = (changes: ProjectGitStatusEntry[]) => {
  if (
    changes.every(
      (change) => change.status === "added" || change.status === "untracked",
    )
  ) {
    return "Add";
  }

  if (changes.every((change) => change.status === "deleted")) {
    return "Remove";
  }

  return "Update";
};

const describeGitChangeForMessage = (change: ProjectGitStatusEntry) => {
  const fileSubject = formatGitFileSubject(change.path);
  switch (change.status) {
    case "added":
    case "untracked":
      return `Add ${fileSubject}`;
    case "deleted":
      return `Remove ${fileSubject}`;
    case "renamed":
      return `Rename ${formatGitFileSubject(
        change.previousPath ?? "file",
      )} to ${fileSubject}`;
    case "copied":
      return `Copy ${fileSubject}`;
    default:
      return `Update ${fileSubject}`;
  }
};

const addUniqueCommitMessageSubject = (subjects: string[], subject: string) => {
  if (!subjects.includes(subject)) {
    subjects.push(subject);
  }
};

const titleCaseCommitMessageSubject = (subject: string) =>
  subject ? `${subject.charAt(0).toUpperCase()}${subject.slice(1)}` : subject;

const joinCommitMessageSubjects = (subjects: string[]) => {
  if (subjects.length === 0) {
    return "";
  }

  const [firstSubject, ...restSubjects] = subjects;
  return [titleCaseCommitMessageSubject(firstSubject), ...restSubjects].join(
    " and ",
  );
};

const buildPathAwareCommitMessage = (changes: ProjectGitStatusEntry[]) => {
  const paths = new Set(changes.map((change) => change.path));
  const subjects: string[] = [];

  if (
    paths.has("electron/api-server.js") &&
    paths.has("src/components/ide/git-actions-menu.tsx") &&
    paths.has("src/types/ide.ts")
  ) {
    addUniqueCommitMessageSubject(subjects, "add diff-aware commit messages");
  }

  if (paths.has("src/components/ide/chat-panel.tsx")) {
    addUniqueCommitMessageSubject(
      subjects,
      "refresh panels after assistant turns",
    );
  }

  return joinCommitMessageSubjects(subjects);
};

const buildGeneratedCommitMessage = (changes: ProjectGitStatusEntry[]) => {
  if (changes.length === 0) {
    return "";
  }

  const pathAwareMessage = buildPathAwareCommitMessage(changes);
  if (pathAwareMessage) {
    return pathAwareMessage;
  }

  if (changes.length === 1 && changes[0]) {
    return describeGitChangeForMessage(changes[0]);
  }

  return `${getCommitMessageVerb(changes)} ${formatCommitSubjectList(changes)}`;
};

const hasPushDestination = (status: ProjectGitStatusResponse | null) =>
  Boolean(status?.upstreamBranch || status?.remoteName);

const hasPushableCommits = (status: ProjectGitStatusResponse | null) => {
  if (!status) {
    return false;
  }

  if (status.upstreamBranch) {
    return status.aheadCount > 0;
  }

  return Boolean(status.remoteName);
};

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

const GitChangesDeltaSummary = ({
  changes,
  showFileCount = true,
}: {
  changes: ProjectGitStatusEntry[];
  showFileCount?: boolean;
}) => (
  <div className="flex shrink-0 items-center gap-2 font-mono text-sm tabular-nums">
    {showFileCount ? (
      <span className="text-muted-foreground">
        {formatFileCount(changes.length)}
      </span>
    ) : null}
    <span className="font-medium text-emerald-500">
      {formatDelta(getChangesAddedLines(changes), "+")}
    </span>
    <span className="font-medium text-rose-500">
      {formatDelta(getChangesRemovedLines(changes), "-")}
    </span>
  </div>
);

const GitMenuDeltaSummary = ({
  status,
}: {
  status: ProjectGitStatusResponse | null;
}) =>
  status && getStatusFileCount(status) > 0 ? (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="font-medium !text-emerald-500 group-focus/dropdown-menu-item:!text-emerald-500">
        {formatDelta(getStatusAddedLines(status), "+")}
      </span>
      <span className="font-medium !text-rose-500 group-focus/dropdown-menu-item:!text-rose-500">
        {formatDelta(getStatusRemovedLines(status), "-")}
      </span>
    </span>
  ) : null;

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
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center [&_svg]:size-4",
              option.disabled
                ? "text-muted-foreground/45"
                : "text-muted-foreground",
            )}
          >
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
  <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-5">
    {children}
  </div>
);

const GitDialogHeader = ({
  icon,
  subtitle,
  title,
}: {
  icon: ReactNode;
  subtitle?: ReactNode;
  title: string;
}) => (
  <DialogHeader className="gap-1 text-left">
    <div className="flex min-w-0 items-center gap-3">
      <DialogIcon>{icon}</DialogIcon>
      <div className="min-w-0">
        <DialogTitle className="text-base leading-6">{title}</DialogTitle>
        {subtitle ? (
          <div className="truncate text-muted-foreground text-sm">
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  </DialogHeader>
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
  const fallbackGeneratedCommitMessage = useMemo(
    () => buildGeneratedCommitMessage(commitChanges),
    [commitChanges],
  );

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
    setGeneratingCommitMessage(true);
    void generateCachedProjectCommitMessage({
      changes: commitChanges,
      fallbackMessage: fallbackGeneratedCommitMessage,
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
    fallbackGeneratedCommitMessage,
    hasCommitChanges,
    includeUnstaged,
    open,
    projectPath,
    provider,
    refreshToken,
  ]);

  const handleAutoGenerateMessageChange = useCallback(
    (nextChecked: boolean | "indeterminate") => {
      const nextAutoGenerateMessage = nextChecked === true;
      setAutoGenerateMessage(nextAutoGenerateMessage);
      setGeneratingCommitMessage(false);
      if (!nextAutoGenerateMessage) {
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

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="font-medium text-sm" htmlFor="commit-message">
                Commit message
              </label>
              <label
                className="flex items-center gap-2 text-sm"
                htmlFor="commit-auto-generate-message"
              >
                <Checkbox
                  checked={autoGenerateMessage}
                  id="commit-auto-generate-message"
                  onCheckedChange={handleAutoGenerateMessageChange}
                />
                <span>Auto generate message</span>
              </label>
            </div>
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
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground text-sm">
                  <Spinner className="size-4" />
                  <span>Generating commit message...</span>
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPush = hasPushableCommits(status);

  useEffect(() => {
    if (!open) {
      return;
    }

    setError(null);
  }, [open]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting || !canPush) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await postJson<ProjectGitPushResponse>("/api/project-git-push", {
          commitMessage: null,
          includeUnstaged: true,
          nextStep: "push",
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
    [canPush, onCompleted, onOpenChange, projectPath, submitting],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <GitDialogHeader icon={<UploadCloud />} title="Push changes" />

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

          <ActionError error={error} />

          <div className="flex justify-end">
            <Button
              className="min-w-36"
              disabled={submitting || !canPush}
              type="submit"
            >
              {submitting ? <Spinner className="size-4" /> : null}
              <span>Push</span>
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
  const [draft, setDraft] = useState(true);
  const [openPrPage, setOpenPrPage] = useState(false);
  const [nextStep, setNextStep] =
    useState<ProjectGitCreatePrNextStep>("create");
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
  branch,
  onActionCompleted,
  onOpenChange,
  onPrCompleted,
  projectPath,
  provider,
  refreshToken,
  status,
}: {
  action: ActiveGitActionDialog;
  branch: string | null;
  onActionCompleted: () => void;
  onOpenChange: (open: boolean) => void;
  onPrCompleted: (url: string | null, shouldOpen: boolean) => void;
  projectPath: string;
  provider: AiProvider;
  refreshToken: number;
  status: ProjectGitStatusResponse | null;
}) => {
  if (action === "commit") {
    return (
      <CommitDialog
        branch={branch}
        onCompleted={onActionCompleted}
        onOpenChange={onOpenChange}
        open
        projectPath={projectPath}
        provider={provider}
        refreshToken={refreshToken}
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
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
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
  const provider = useIdeStore(
    (s) =>
      s.projects.find((project) => project.id === projectId)?.provider ??
      "openai",
  );
  const { branch, status } = useProjectGitStatus(projectPath, gitRefreshKey);
  const [activeDialog, setActiveDialog] = useState<GitActionDialog>(null);
  const hasGitChanges = getStatusFileCount(status) > 0;
  const canPush = hasPushableCommits(status);
  const hasGitActivity = hasGitChanges || canPush;

  const handleOpenChanges = useCallback(() => {
    setProjectRightPanelView(projectId, "changes");
    setProjectRightPanelOpen(projectId, true);
  }, [projectId, setProjectRightPanelOpen, setProjectRightPanelView]);

  const handleOpenDialog = useCallback(
    (dialog: GitActionDialog) => {
      if (dialog === "push" && !canPush) {
        return;
      }

      if (dialog !== "push" && !hasGitChanges) {
        return;
      }

      setActiveDialog(dialog);
    },
    [canPush, hasGitChanges],
  );

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
              className={cn(
                "size-8 [-webkit-app-region:no-drag]",
                hasGitActivity
                  ? "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                  : "text-muted-foreground hover:text-foreground",
              )}
              size="icon"
              title="Git actions"
              variant="ghost"
            />
          }
        >
          <GitFork className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-52 [-webkit-app-region:no-drag]"
        >
          <DropdownMenuItem onClick={handleOpenChanges}>
            <Code className="size-4" />
            Changes
            <GitMenuDeltaSummary status={status} />
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasGitChanges}
            onClick={() => handleOpenDialog("commit")}
          >
            <GitCommitHorizontal className="size-4" />
            Commit
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canPush}
            onClick={() => handleOpenDialog("push")}
          >
            <UploadCloud className="size-4" />
            Push
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasGitChanges}
            onClick={() => handleOpenDialog("pr")}
          >
            <GitPullRequest className="size-4" />
            Create pull request
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {activeDialog ? (
        <GitActionDialogHost
          action={activeDialog}
          branch={branch}
          onActionCompleted={handleActionCompleted}
          onOpenChange={handleDialogOpenChange}
          onPrCompleted={handlePrCompleted}
          projectPath={projectPath}
          provider={provider}
          refreshToken={gitRefreshKey}
          status={status}
        />
      ) : null}
    </>
  );
};

export const GitActionsMenu = memo(GitActionsMenuImpl);
GitActionsMenu.displayName = "GitActionsMenu";
