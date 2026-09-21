import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectConfig } from "@/types/ide";
import { ProjectTabIcon } from "../../header/project-tab-icon";

export interface TaskDialogValue {
  description: string;
  /** The project the task belongs to; `null` only when none is open. */
  projectId: string | null;
  title: string;
}

export interface TaskDialogProps {
  initialValue: TaskDialogValue | null;
  mode: "create" | "edit";
  onClose: () => void;
  onSubmit: (value: TaskDialogValue) => void;
  /**
   * Projects to choose the owner from. `null` hides the picker because the
   * owner is already settled: one project is in view, or the task exists.
   */
  projects: ProjectConfig[] | null;
}

const ProjectOption = ({ project }: { project: ProjectConfig }) => (
  <span className="flex min-w-0 items-center gap-2">
    <ProjectTabIcon
      icon={project.icon}
      projectName={project.name}
      projectPath={project.path}
    />
    <span className="truncate">
      {project.name}
      {project.worktree ? ` · ${project.worktree.branch}` : ""}
    </span>
  </span>
);

/**
 * Mount this only while open (keyed by the card being edited) so the local
 * form state initialises from `initialValue` without effects.
 */
export const TaskDialog = ({
  initialValue,
  mode,
  onClose,
  onSubmit,
  projects,
}: TaskDialogProps) => {
  const t = useTranslations("tasks");
  const commonT = useTranslations("common");
  const [title, setTitle] = useState(initialValue?.title ?? "");
  const [description, setDescription] = useState(
    initialValue?.description ?? "",
  );
  const [projectId, setProjectId] = useState(initialValue?.projectId ?? null);
  const selectedProject =
    projects?.find((project) => project.id === projectId) ?? null;
  const canSubmit =
    title.trim().length > 0 && (projects === null || selectedProject !== null);

  const submit = () => {
    if (!canSubmit) {
      return;
    }

    onSubmit({
      description: description.trim(),
      projectId,
      title: title.trim(),
    });
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {mode === "create" ? t("newTask") : t("editTask")}
            </DialogTitle>
          </DialogHeader>
          {projects ? (
            <div className="space-y-2">
              <Label htmlFor="task-project">{t("taskProject")}</Label>
              <Select
                onValueChange={(value) =>
                  setProjectId(typeof value === "string" ? value : null)
                }
                value={selectedProject?.id ?? null}
              >
                <SelectTrigger className="w-full" id="task-project">
                  <SelectValue placeholder={t("selectProject")}>
                    {selectedProject ? (
                      <ProjectOption project={selectedProject} />
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      <ProjectOption project={project} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="task-title">{t("titleLabel")}</Label>
            <Input
              autoFocus
              id="task-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("titlePlaceholder")}
              value={title}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-description">{t("descriptionLabel")}</Label>
            <Textarea
              id="task-description"
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("descriptionPlaceholder")}
              rows={5}
              value={description}
            />
          </div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {mode === "create" ? t("create") : commonT("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
