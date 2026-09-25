import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  createSkillRequest,
  isValidSkillName,
  SKILL_TARGETS,
  type SkillTarget,
  toSkillName,
} from "./skills-api";

export interface CreateSkillDialogProps {
  initialValue?: {
    body?: string;
    description?: string;
    name?: string;
    userInvocationOnly?: boolean;
  };
  onClose: () => void;
  onCreated?: (paths: string[]) => void;
  /** The project for project-scoped targets; user targets work without one. */
  projectPath: string | null;
}

/**
 * Scaffolds `<location>/<name>/SKILL.md`. Mount only while open so the form
 * initialises from `initialValue` without effects.
 */
export const CreateSkillDialog = ({
  initialValue,
  onClose,
  onCreated,
  projectPath,
}: CreateSkillDialogProps) => {
  const t = useTranslations("skills");
  const commonT = useTranslations("common");
  const [name, setName] = useState(toSkillName(initialValue?.name ?? ""));
  const [description, setDescription] = useState(
    initialValue?.description ?? "",
  );
  const [body, setBody] = useState(initialValue?.body ?? "");
  const [userInvocationOnly, setUserInvocationOnly] = useState(
    initialValue?.userInvocationOnly ?? false,
  );
  const [targets, setTargets] = useState<SkillTarget[]>(
    projectPath ? ["project-agents", "project-claude"] : ["user-agents"],
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit =
    isValidSkillName(name) &&
    description.trim().length > 0 &&
    targets.length > 0 &&
    !isSubmitting;

  const toggleTarget = (target: SkillTarget, checked: boolean) => {
    setTargets((current) =>
      checked
        ? current.includes(target)
          ? current
          : [...current, target]
        : current.filter((item) => item !== target),
    );
  };

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await createSkillRequest({
        body,
        description: description.trim(),
        name,
        projectPath: projectPath ?? undefined,
        targets,
        userInvocationOnly,
      });
      onCreated?.(result.paths);
      onClose();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : t("createFailed"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const targetLabels: Record<SkillTarget, string> = {
    "project-agents": t("locationProjectShared"),
    "project-claude": t("locationProjectClaude"),
    "user-agents": t("locationUserShared"),
    "user-claude": t("locationUserClaude"),
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
      <DialogContent className="sm:max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {t("createTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="create-skill-name">{t("nameLabel")}</Label>
            <Input
              autoFocus
              id="create-skill-name"
              onChange={(event) => setName(toSkillName(event.target.value))}
              placeholder={t("namePlaceholder")}
              value={name}
            />
            <p className="text-muted-foreground text-xs">{t("nameHelp")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-skill-description">
              {t("descriptionLabel")}
            </Label>
            <Textarea
              className="min-h-16"
              id="create-skill-description"
              maxLength={1024}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={2}
              value={description}
            />
            <p className="text-muted-foreground text-xs">
              {t("descriptionHelp")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-skill-body">{t("bodyLabel")}</Label>
            <Textarea
              className="max-h-[40vh] min-h-32 font-mono text-xs"
              id="create-skill-body"
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={t("bodyPlaceholder")}
              rows={8}
              value={body}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("locationLabel")}</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {SKILL_TARGETS.map((target) => {
                const disabled = target.startsWith("project-") && !projectPath;
                return (
                  <div
                    className="flex items-start gap-2 rounded-md border border-surface-200 p-2 text-sm dark:border-surface-800"
                    key={target}
                  >
                    <Checkbox
                      checked={targets.includes(target)}
                      disabled={disabled}
                      id={`create-skill-target-${target}`}
                      onCheckedChange={(checked) =>
                        toggleTarget(target, checked === true)
                      }
                    />
                    <Label
                      className={cn(
                        "font-normal",
                        disabled && "text-muted-foreground",
                      )}
                      htmlFor={`create-skill-target-${target}`}
                    >
                      {targetLabels[target]}
                    </Label>
                  </div>
                );
              })}
            </div>
            <p className="text-muted-foreground text-xs">{t("locationHelp")}</p>
          </div>
          <div className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={userInvocationOnly}
              id="create-skill-manual-only"
              onCheckedChange={(checked) =>
                setUserInvocationOnly(checked === true)
              }
            />
            <Label
              className="flex flex-col items-start gap-0.5 font-normal"
              htmlFor="create-skill-manual-only"
            >
              <span>{t("manualOnlyLabel")}</span>
              <span className="text-muted-foreground text-xs">
                {t("manualOnlyHelp")}
              </span>
            </Label>
          </div>
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
