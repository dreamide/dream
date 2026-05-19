import {
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { cn } from "@/lib/utils";
import type { ProjectConfig } from "@/types/ide";
import { BranchSwitcher } from "./branch-switcher";
import { useIdeStore } from "./ide-store";

const slugifyBranchSegment = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "worktree";

const readResponseText = async (response: Response) => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const toFileUrl = (path: string) =>
  encodeURI(`file:///${path.replace(/\\/g, "/").replace(/^\/+/, "")}`);

const CreateWorktreeDialog = ({
  baseRef,
  onOpenChange,
  open,
  project,
}: {
  baseRef: string | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  project: ProjectConfig;
}) => {
  const createWorktreeProject = useIdeStore((s) => s.createWorktreeProject);
  const [branchName, setBranchName] = useState("");
  const [baseRefValue, setBaseRefValue] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setBranchName(`codex/${slugifyBranchSegment(project.name)}`);
    setBaseRefValue(baseRef ?? "");
    setWorktreePath("");
    setError(null);
  }, [baseRef, open, project.name]);

  const canSubmit = branchName.trim().length > 0 && !submitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createWorktreeProject(project.id, {
        baseRef: baseRefValue.trim() || null,
        branchName: branchName.trim(),
        worktreePath: worktreePath.trim() || null,
      });
      onOpenChange(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to create worktree.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            Create a separate project space from this repository.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <label className="font-medium text-sm" htmlFor="worktree-branch">
              Branch
            </label>
            <Input
              autoFocus
              id="worktree-branch"
              onChange={(event) => setBranchName(event.target.value)}
              placeholder="codex/my-feature"
              value={branchName}
            />
          </div>

          <div className="grid gap-2">
            <label className="font-medium text-sm" htmlFor="worktree-base">
              Base ref
            </label>
            <Input
              id="worktree-base"
              onChange={(event) => setBaseRefValue(event.target.value)}
              placeholder="main"
              value={baseRefValue}
            />
          </div>

          <div className="grid gap-2">
            <label className="font-medium text-sm" htmlFor="worktree-path">
              Folder
            </label>
            <Input
              id="worktree-path"
              onChange={(event) => setWorktreePath(event.target.value)}
              placeholder="Auto-create beside the main worktree"
              value={worktreePath}
            />
          </div>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          <DialogFooter>
            <Button
              disabled={submitting}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {submitting ? (
                <>
                  <Spinner className="size-3.5" />
                  <span>Create worktree</span>
                </>
              ) : (
                "Create worktree"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const WorktreeMenu = ({ project }: { project: ProjectConfig }) => {
  const closeProject = useIdeStore((s) => s.closeProject);
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worktree = project.worktree;

  if (!worktree) {
    return null;
  }

  const handleRemove = async () => {
    if (!worktree.managed || removing) {
      return;
    }

    const confirmed = window.confirm(
      `Remove worktree "${worktree.branch}"?\n\nThis removes the worktree folder from disk. Git will refuse if it has uncommitted changes.`,
    );
    if (!confirmed) {
      return;
    }

    setRemoving(true);
    setError(null);
    try {
      const response = await fetch("/api/project-git-worktree-remove", {
        body: JSON.stringify({
          force: false,
          projectPath: project.path,
          worktreePath: project.path,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await readResponseText(response));
      }

      bumpProjectGitRefreshKey(project.id);
      closeProject(project.id);
      useIdeStore.setState((state) => {
        const removedChatIds = new Set(
          state.chats
            .filter((chat) => chat.projectId === project.id)
            .map((chat) => chat.id),
        );
        const nextMessagesByChatId = { ...state.messagesByChatId };
        for (const chatId of removedChatIds) {
          delete nextMessagesByChatId[chatId];
        }

        return {
          chats: state.chats.filter((chat) => chat.projectId !== project.id),
          closedProjects: state.closedProjects.filter(
            (closedProject) => closedProject.id !== project.id,
          ),
          messagesByChatId: nextMessagesByChatId,
        };
      });
      useIdeStore.getState().persist();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to remove worktree.",
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="h-7 max-w-[280px] gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            size="sm"
            variant="ghost"
          />
        }
      >
        {removing ? (
          <Spinner className="size-3.5" />
        ) : (
          <FolderGit2 className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0">worktree</span>
        <span className="truncate text-foreground">{worktree.branch}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <div className="px-2 py-1.5">
          <p className="truncate font-medium text-sm">{worktree.branch}</p>
          <p className="truncate text-muted-foreground text-xs">
            {project.path}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => openExternalUrl(toFileUrl(project.path))}
        >
          <ExternalLink className="size-4" />
          Open folder
        </DropdownMenuItem>
        {worktree.managed ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            disabled={removing}
            onClick={() => {
              void handleRemove();
            }}
          >
            <Trash2 className="size-4" />
            Remove worktree
          </DropdownMenuItem>
        ) : null}
        {error ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-destructive text-xs">{error}</div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ProjectStatusBar = ({ project }: { project: ProjectConfig }) => {
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  const { branch, isRepo, status } = useProjectGitStatus(
    project.path,
    gitRefreshKey,
  );
  const [createWorktreeOpen, setCreateWorktreeOpen] = useState(false);
  const fileCount = status?.fileCount ?? 0;
  const changeLabel = useMemo(() => {
    if (!isRepo) {
      return null;
    }
    if (fileCount === 0) {
      return "clean";
    }
    return `${fileCount} changed`;
  }, [fileCount, isRepo]);

  return (
    <>
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-t border-surface-200 dark:border-surface-800 px-3 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{project.name}</span>
          {changeLabel ? (
            <span
              className={cn(
                "shrink-0",
                fileCount > 0 && "text-warning-foreground",
              )}
            >
              {changeLabel}
            </span>
          ) : null}
        </div>

        {isRepo && !project.worktree ? (
          <Button
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setCreateWorktreeOpen(true)}
            size="sm"
            title="New worktree"
            variant="ghost"
          >
            <GitBranchPlus className="size-3.5" />
            <span>New worktree</span>
          </Button>
        ) : null}

        {project.worktree ? (
          <WorktreeMenu project={project} />
        ) : (
          <BranchSwitcher projectId={project.id} projectPath={project.path} />
        )}
      </div>

      <CreateWorktreeDialog
        baseRef={branch}
        onOpenChange={setCreateWorktreeOpen}
        open={createWorktreeOpen}
        project={project}
      />
    </>
  );
};
