import { Folder, FolderOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getDesktopApi } from "@/lib/electron";
import type { ProjectConfig } from "@/types/ide";
import { ProjectTabIcon } from "../../header/project-tab-icon";
import { normalizeProjectPathKey } from "../../ide-state";

export interface TaskDialogValue {
  description: string;
  /**
   * Where the task belongs, as a folder path: the project may be open in Code,
   * merely recent, or a folder the app has never seen. `null` only in edit
   * mode, where the owner is already settled.
   */
  projectPath: string | null;
  title: string;
}

/** A project the task can be filed under; it does not have to be open. */
export interface TaskProjectOption {
  icon: ProjectConfig["icon"];
  name: string;
  path: string;
  /** Closed in Code. It stays closed until one of its tasks is started. */
  recent: boolean;
  worktreeBranch: string | null;
}

export interface TaskDialogProps {
  initialValue: TaskDialogValue | null;
  mode: "create" | "edit";
  onClose: () => void;
  onSubmit: (value: TaskDialogValue) => void;
  /**
   * Projects to choose the owner from. `null` hides the picker because the
   * owner is already settled: the board is filtered to one project, or the
   * task exists.
   */
  projectOptions: TaskProjectOption[] | null;
}

const getFolderName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const ProjectOptionLabel = ({ option }: { option: TaskProjectOption }) => (
  <span className="flex min-w-0 items-center gap-2">
    <ProjectTabIcon
      fallback={<Folder className="size-4 text-muted-foreground" />}
      icon={option.icon}
      projectName={option.name}
      projectPath={option.path}
    />
    <span className="truncate">
      {option.name}
      {option.worktreeBranch ? ` · ${option.worktreeBranch}` : ""}
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
  projectOptions,
}: TaskDialogProps) => {
  const t = useTranslations("tasks");
  const commonT = useTranslations("common");
  const [title, setTitle] = useState(initialValue?.title ?? "");
  const [description, setDescription] = useState(
    initialValue?.description ?? "",
  );
  const [projectPath, setProjectPath] = useState(
    initialValue?.projectPath ?? null,
  );
  // A folder picked with Browse that is not a known project yet. It is only
  // registered when the task is created, so cancelling leaves no trace.
  const [browsedOption, setBrowsedOption] = useState<TaskProjectOption | null>(
    null,
  );

  const { openOptions, recentOptions, options } = useMemo(() => {
    const known = projectOptions ?? [];
    return {
      openOptions: known.filter((option) => !option.recent),
      options: browsedOption ? [browsedOption, ...known] : known,
      recentOptions: known.filter((option) => option.recent),
    };
  }, [browsedOption, projectOptions]);
  const selectedOption =
    options.find((option) => option.path === projectPath) ?? null;
  const canSubmit =
    title.trim().length > 0 &&
    (projectOptions === null || selectedOption !== null);

  const submit = () => {
    if (!canSubmit) {
      return;
    }

    onSubmit({
      description: description.trim(),
      projectPath: selectedOption?.path ?? null,
      title: title.trim(),
    });
  };

  const browse = async () => {
    const pickedPath = await getDesktopApi()?.pickProjectDirectory();
    if (!pickedPath) {
      return;
    }

    // Reuse the known project when the folder is already open or recent.
    const pickedKey = normalizeProjectPathKey(pickedPath);
    const known = (projectOptions ?? []).find(
      (option) => normalizeProjectPathKey(option.path) === pickedKey,
    );
    if (known) {
      setBrowsedOption(null);
      setProjectPath(known.path);
      return;
    }

    setBrowsedOption({
      icon: null,
      name: getFolderName(pickedPath),
      path: pickedPath,
      recent: false,
      worktreeBranch: null,
    });
    setProjectPath(pickedPath);
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
          {projectOptions ? (
            <div className="space-y-2">
              <Label htmlFor="task-project">{t("taskProject")}</Label>
              <div className="flex items-center gap-2">
                <Select
                  onValueChange={(value) =>
                    setProjectPath(typeof value === "string" ? value : null)
                  }
                  value={selectedOption?.path ?? null}
                >
                  <SelectTrigger className="min-w-0 flex-1" id="task-project">
                    <SelectValue placeholder={t("selectProject")}>
                      {selectedOption ? (
                        <ProjectOptionLabel option={selectedOption} />
                      ) : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {browsedOption ? (
                      <SelectGroup>
                        <SelectItem value={browsedOption.path}>
                          <ProjectOptionLabel option={browsedOption} />
                        </SelectItem>
                      </SelectGroup>
                    ) : null}
                    {openOptions.length > 0 ? (
                      <SelectGroup>
                        <SelectLabel>{t("projectsOpen")}</SelectLabel>
                        {openOptions.map((option) => (
                          <SelectItem key={option.path} value={option.path}>
                            <ProjectOptionLabel option={option} />
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                    {recentOptions.length > 0 ? (
                      <SelectGroup>
                        <SelectLabel>{t("projectsRecent")}</SelectLabel>
                        {recentOptions.map((option) => (
                          <SelectItem key={option.path} value={option.path}>
                            <ProjectOptionLabel option={option} />
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null}
                  </SelectContent>
                </Select>
                <Button
                  className="shrink-0"
                  onClick={() => void browse()}
                  type="button"
                  variant="outline"
                >
                  <FolderOpen className="size-4" />
                  {t("browseProject")}
                </Button>
              </div>
              {selectedOption ? (
                <p
                  className="truncate text-muted-foreground text-xs"
                  title={selectedOption.path}
                >
                  {selectedOption.path}
                </p>
              ) : null}
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
