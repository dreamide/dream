import { Folder, Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useRef, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import type { ProjectConfig, ProjectIconInfo } from "@/types/ide";
import { normalizeProjectIconResponse } from "./project-icon";
import { ProjectTabIcon } from "./project-tab-icon";
export type ProjectEditTarget = {
  id: string;
  name: string;
};

export const ProjectEditDialog = ({
  onClose,
  onSubmit,
  onValueChange,
  target,
  project,
  value,
}: {
  onClose: () => void;
  onSubmit: (icon: ProjectIconInfo | null) => void;
  onValueChange: (value: string) => void;
  target: ProjectEditTarget | null;
  project: ProjectConfig | null;
  value: string;
}) => {
  const commonT = useTranslations("common");
  const projectsT = useTranslations("projects");
  const [selectedIcon, setSelectedIcon] = useState<ProjectIconInfo | null>(
    project?.icon?.source === "custom" ? project.icon : null,
  );
  const [automaticIcon, setAutomaticIcon] = useState<ProjectIconInfo | null>(
    project?.icon?.source !== "custom" ? (project?.icon ?? null) : null,
  );
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!project || saving || uploading) return;
    setSaving(true);
    setError(null);
    try {
      if (selectedIcon) {
        onSubmit(selectedIcon);
        return;
      }
      const response = await fetch("/api/project-icon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: project.path,
        }),
      });
      if (!response.ok) throw new Error(projectsT("iconSaveFailed"));
      const payload = await response.json();
      onSubmit(normalizeProjectIconResponse(payload.icon));
    } catch {
      setError(projectsT("iconSaveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const resetIcon = async () => {
    if (!project) return;
    setUploading(true);
    setError(null);
    try {
      const response = await fetch("/api/project-icon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: project.path }),
      });
      if (!response.ok) throw new Error("Unable to detect icon");
      const payload = await response.json();
      setAutomaticIcon(normalizeProjectIconResponse(payload.icon));
      setSelectedIcon(null);
    } catch {
      setError(projectsT("iconSaveFailed"));
    } finally {
      setUploading(false);
    }
  };
  const uploadIcon = async (file: File) => {
    setUploading(true);
    setError(null);
    let objectUrl: string | null = null;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Image too large");
      objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      const scale = Math.min(
        1,
        128 / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to process image");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setSelectedIcon({
        path: canvas.toDataURL("image/png"),
        mimeType: "image/png",
        source: "custom",
        mtimeMs: Date.now(),
      });
    } catch {
      setError(projectsT("iconSaveFailed"));
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUploading(false);
    }
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={target !== null}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl sm:p-8">
        <form className="space-y-6" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {projectsT("editProject")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="edit-project-name">{commonT("name")}</Label>
            <Input
              autoFocus
              id="edit-project-name"
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={commonT("enterName")}
              value={value}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="browse-project-icon">
              {projectsT("iconUpload")}
            </Label>
            <input
              ref={iconInputRef}
              hidden
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/avif,image/bmp,.ico"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadIcon(file);
              }}
              disabled={saving || uploading}
            />
            <div className="flex items-center gap-2">
              <button
                id="browse-project-icon"
                type="button"
                aria-label={projectsT("changeIcon")}
                title={projectsT("changeIcon")}
                aria-busy={uploading}
                className="group relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={saving || uploading}
                onClick={() => iconInputRef.current?.click()}
              >
                {uploading ? (
                  <Spinner className="size-5" />
                ) : project ? (
                  <ProjectTabIcon
                    className="size-8"
                    icon={selectedIcon ?? automaticIcon}
                    projectName={project.name}
                    projectPath={project.path}
                    fallback={<Folder className="size-6" />}
                  />
                ) : (
                  <Folder className="size-6" />
                )}
                <span
                  aria-hidden="true"
                  className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                >
                  <Pencil className="size-4" />
                </span>
              </button>
              {selectedIcon ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={projectsT("resetIcon")}
                  title={projectsT("resetIcon")}
                  disabled={saving || uploading}
                  onClick={() => void resetIcon()}
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button
              disabled={saving || uploading || value.trim().length === 0}
              type="submit"
            >
              {commonT("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
