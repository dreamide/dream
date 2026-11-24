import { Folder, FolderTree } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { cn } from "@/lib/utils";
import type { ProjectConfig } from "@/types/ide";
import { getProjectHostId } from "../../../electron/shared/persisted-state-codec.js";
import { BranchSwitcher } from "./branch-switcher";
import { GitFooterActions } from "./git-panel/footer-actions";
import { OpenInEditorIcon } from "./header/open-in-editor-icon";
import { useIdeStore } from "./ide-store";
import { ProjectHostLabel } from "./ssh/project-host-label";
import { useDetectedEditors } from "./use-detected-editors";
import { useOpenProjectInEditor } from "./use-open-project-folder";
import { slugifyWorktreeBranchName, WorktreeFields } from "./worktree-fields";

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
  const commonT = useTranslations("common");
  const worktreeT = useTranslations("worktrees");
  const createWorktreeProject = useIdeStore((s) => s.createWorktreeProject);
  const [branchName, setBranchName] = useState("");
  const [baseRefValue, setBaseRefValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setBranchName(slugifyWorktreeBranchName(project.name));
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
    } catch {
      setError(worktreeT("unableToCreate"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{worktreeT("newWorktree")}</DialogTitle>
          <DialogDescription>
            {worktreeT("createDescription")}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <WorktreeFields
            autoFocus
            baseRef={baseRefValue}
            branchName={branchName}
            idPrefix="worktree"
            onBaseRefChange={setBaseRefValue}
            onBranchNameChange={setBranchName}
          />

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          <DialogFooter>
            <Button
              disabled={submitting}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {commonT("cancel")}
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {submitting ? (
                <>
                  <Spinner className="size-3.5" />
                  <span>{worktreeT("createWorktree")}</span>
                </>
              ) : (
                worktreeT("createWorktree")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const ProjectBranchFooter = ({
  active,
  className,
  project,
}: {
  /** Whether the project's workspace is on screen. */
  active: boolean;
  className?: string;
  project: ProjectConfig;
}) => {
  const worktreeT = useTranslations("worktrees");
  const { branch, isRepo, loading } = useProjectGitStatus(project.path, {
    detail: "summary",
    hostId: getProjectHostId(project),
  });
  const [createWorktreeOpen, setCreateWorktreeOpen] = useState(false);
  const commonT = useTranslations("common");
  const isElectron = useIdeStore((s) => s.isElectron);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const detectedEditors = useDetectedEditors(isMacOs);
  // Only the desktop app can open a folder in an editor, and a folder on an
  // SSH host opens only in editors that reach it remotely. (Only a project on
  // another host carries a hostId.)
  const editors = !isElectron
    ? []
    : project.hostId
      ? detectedEditors.filter((editor) => editor.supportsRemote)
      : detectedEditors;
  const openProjectInEditor = useOpenProjectInEditor();

  // A breadcrumb of where the chat works: the host, the project (which opens
  // the "Open In" menu), then (for a repository) its branch. The branch's git
  // actions sit on the right.
  const showBranch = Boolean(project.worktree) || isRepo || loading;

  return (
    <>
      <div className={cn("shrink-0 px-2 pt-1 pb-2", className)}>
        {/* Fixed height (the branch switcher's) so the composer above does not
            shift when switching to a project without a branch. */}
        <div className="mx-auto flex h-8 w-full max-w-[700px] items-center justify-between gap-2">
          <Breadcrumb className="-ml-2 min-w-0">
            <BreadcrumbList className="flex-nowrap gap-0 text-xs sm:gap-0">
              <BreadcrumbItem className="min-w-0">
                <ProjectHostLabel project={project} />
              </BreadcrumbItem>
              <BreadcrumbSeparator className="shrink-0 [&>svg]:size-3" />
              <BreadcrumbItem className="min-w-0">
                {editors.length === 0 ? (
                  <div
                    className="flex h-8 min-w-0 max-w-[220px] items-center gap-1.5 px-2 text-muted-foreground text-xs"
                    title={project.path}
                  >
                    <Folder className="size-3.5 shrink-0" />
                    <span className="truncate">{project.name}</span>
                  </div>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          className="h-8 min-w-0 max-w-[220px] gap-1.5 px-2 text-muted-foreground text-xs hover:text-foreground aria-expanded:text-foreground"
                          size="sm"
                          title={project.path}
                          type="button"
                          variant="ghost"
                        />
                      }
                    >
                      <Folder className="size-3.5 shrink-0" />
                      <span className="truncate">{project.name}</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>
                          {commonT("openIn")}
                        </DropdownMenuLabel>
                        {editors.map((editor) => (
                          <DropdownMenuItem
                            key={editor.id}
                            onClick={() =>
                              void openProjectInEditor(
                                project.id,
                                project.path,
                                editor.id,
                              )
                            }
                          >
                            <OpenInEditorIcon
                              editor={editor}
                              isMacOs={isMacOs}
                            />
                            {editor.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </BreadcrumbItem>
              {!showBranch ? null : (
                <>
                  <BreadcrumbSeparator className="shrink-0 [&>svg]:size-3" />
                  <BreadcrumbItem className="min-w-0">
                    {project.worktree ? (
                      <div
                        className="flex h-7 min-w-0 max-w-[280px] items-center gap-1.5 px-2"
                        title={project.worktree.branch}
                      >
                        <FolderTree className="size-3.5 shrink-0" />
                        <span className="shrink-0">
                          {worktreeT("worktree")}
                        </span>
                        <span className="truncate text-foreground">
                          {project.worktree.branch}
                        </span>
                      </div>
                    ) : (
                      <BranchSwitcher
                        onCreateWorktree={
                          isRepo ? () => setCreateWorktreeOpen(true) : undefined
                        }
                        projectId={project.id}
                        projectPath={project.path}
                      />
                    )}
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          {!showBranch ? null : (
            <GitFooterActions active={active} project={project} />
          )}
        </div>
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
