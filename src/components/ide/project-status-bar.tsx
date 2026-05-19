import { FolderGit2, Settings } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setBranchName(`codex/${slugifyBranchSegment(project.name)}`);
    setBaseRefValue(baseRef ?? "");
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

export const ProjectStatusBar = ({
  project,
}: {
  project: ProjectConfig | null;
}) => {
  const gitRefreshKey = useIdeStore((s) =>
    project ? (s.projectGitRefreshKeys[project.id] ?? 0) : 0,
  );
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);
  const { branch, isRepo } = useProjectGitStatus(project?.path, gitRefreshKey);
  const [createWorktreeOpen, setCreateWorktreeOpen] = useState(false);
  const openSettings = () => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  };

  return (
    <>
      <div className="flex min-h-9 shrink-0 items-center gap-2 pr-3 pl-2 text-xs">
        <Button
          aria-label="Settings"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={openSettings}
          size="icon"
          title="Settings"
          variant="ghost"
        >
          <Settings className="size-4" />
        </Button>

        <div className="flex min-w-0 flex-1 justify-end">
          {project?.worktree ? (
            <Button
              aria-label={`Worktree ${project.worktree.branch}`}
              className="h-7 max-w-[280px] gap-1.5 px-2 text-xs text-muted-foreground"
              disabled
              size="sm"
              title={`Worktree ${project.worktree.branch}`}
              variant="ghost"
            >
              <FolderGit2 className="size-3.5 shrink-0" />
              <span className="shrink-0">worktree</span>
              <span className="truncate text-foreground">
                {project.worktree.branch}
              </span>
            </Button>
          ) : project ? (
            <BranchSwitcher
              onCreateWorktree={
                isRepo ? () => setCreateWorktreeOpen(true) : undefined
              }
              projectId={project.id}
              projectPath={project.path}
            />
          ) : null}
        </div>
      </div>

      {project ? (
        <CreateWorktreeDialog
          baseRef={branch}
          onOpenChange={setCreateWorktreeOpen}
          open={createWorktreeOpen}
          project={project}
        />
      ) : null}
    </>
  );
};
