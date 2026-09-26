import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Package,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SavedPrompt } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { CreateSkillDialog } from "../skills/create-skill-dialog";
import { SavedPromptDialog } from "./saved-prompt-dialog";

type DialogState =
  | { mode: "create" }
  | { mode: "edit"; savedPrompt: SavedPrompt }
  | null;

/**
 * Settings > Prompts: the app-wide list of saved prompts. They are run from the
 * Run prompt menu in a chat's composer, not from here. The list sits on the
 * left; the selected prompt's text is shown on the right.
 */
export const SavedPromptsSettingsSection = () => {
  const t = useTranslations("savedPrompts");
  const commonT = useTranslations("common");
  const skillsT = useTranslations("skills");
  const savedPrompts = useIdeStore((state) => state.savedPrompts);
  const activeProjectPath = useIdeStore(
    (state) =>
      state.projects.find((project) => project.id === state.activeProjectId)
        ?.path ?? null,
  );
  const [skillSource, setSkillSource] = useState<SavedPrompt | null>(null);
  const addSavedPrompt = useIdeStore((state) => state.addSavedPrompt);
  const updateSavedPrompt = useIdeStore((state) => state.updateSavedPrompt);
  const deleteSavedPrompt = useIdeStore((state) => state.deleteSavedPrompt);
  const moveSavedPrompt = useIdeStore((state) => state.moveSavedPrompt);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Fall back to the first prompt when nothing (or a deleted prompt) is selected.
  const selectedPrompt =
    savedPrompts.find((savedPrompt) => savedPrompt.id === selectedId) ??
    savedPrompts[0] ??
    null;

  // Deleting asks for a second click on the same button.
  const handleDelete = (savedPrompt: SavedPrompt) => {
    if (pendingDeleteId !== savedPrompt.id) {
      setPendingDeleteId(savedPrompt.id);
      return;
    }
    deleteSavedPrompt(savedPrompt.id);
    setPendingDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{t("title")}</h3>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
        <Button
          onClick={() => setDialog({ mode: "create" })}
          size="sm"
          type="button"
        >
          <Plus className="size-4" />
          {t("newPrompt")}
        </Button>
      </div>

      {savedPrompts.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-dashed border-surface-200 p-4 text-center dark:border-surface-800">
          <p className="text-muted-foreground text-sm">{t("emptyShort")}</p>
        </div>
      ) : (
        <div className="grid min-h-[480px] grid-cols-[minmax(0,24rem)_minmax(0,1fr)] overflow-hidden rounded-lg border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-950">
          <ul className="min-w-0 space-y-1 border-r p-2">
            {savedPrompts.map((savedPrompt, index) => {
              const isSelected = savedPrompt.id === selectedPrompt?.id;
              return (
                <li
                  className={cn(
                    "flex items-center gap-1 rounded-md pr-2",
                    isSelected ? "bg-muted" : "bg-muted/50 hover:bg-muted",
                  )}
                  data-saved-prompt={savedPrompt.id}
                  key={savedPrompt.id}
                >
                  <button
                    aria-current={isSelected ? "true" : undefined}
                    className="min-w-0 flex-1 truncate px-3 py-2.5 text-left font-medium text-sm outline-none focus-visible:underline"
                    onClick={() => setSelectedId(savedPrompt.id)}
                    onDoubleClick={() =>
                      setDialog({ mode: "edit", savedPrompt })
                    }
                    title={savedPrompt.name}
                    type="button"
                  >
                    {savedPrompt.name}
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      aria-label={t("moveUp")}
                      disabled={index === 0}
                      onClick={() => moveSavedPrompt(savedPrompt.id, index - 1)}
                      size="icon-sm"
                      title={t("moveUp")}
                      type="button"
                      variant="ghost"
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      aria-label={t("moveDown")}
                      disabled={index === savedPrompts.length - 1}
                      onClick={() => moveSavedPrompt(savedPrompt.id, index + 1)}
                      size="icon-sm"
                      title={t("moveDown")}
                      type="button"
                      variant="ghost"
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      aria-label={skillsT("saveAsSkill")}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setSkillSource(savedPrompt)}
                      size="icon-sm"
                      title={skillsT("saveAsSkill")}
                      type="button"
                      variant="ghost"
                    >
                      <Package className="size-4" />
                    </Button>
                    <Button
                      aria-label={commonT("edit")}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setDialog({ mode: "edit", savedPrompt })}
                      size="icon-sm"
                      title={commonT("edit")}
                      type="button"
                      variant="ghost"
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      aria-label={commonT("delete")}
                      className={
                        pendingDeleteId === savedPrompt.id
                          ? undefined
                          : "text-muted-foreground hover:text-foreground"
                      }
                      onBlur={() =>
                        setPendingDeleteId((current) =>
                          current === savedPrompt.id ? null : current,
                        )
                      }
                      onClick={() => handleDelete(savedPrompt)}
                      size={
                        pendingDeleteId === savedPrompt.id ? "sm" : "icon-sm"
                      }
                      title={commonT("delete")}
                      type="button"
                      variant={
                        pendingDeleteId === savedPrompt.id
                          ? "destructive"
                          : "ghost"
                      }
                    >
                      {pendingDeleteId === savedPrompt.id ? (
                        t("deleteConfirm")
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="relative min-w-0 overflow-auto p-4">
            {selectedPrompt ? (
              <>
                <CopyPromptButton
                  key={selectedPrompt.id}
                  text={selectedPrompt.prompt}
                />
                <p className="whitespace-pre-wrap break-words pr-10 text-sm leading-6">
                  {selectedPrompt.prompt}
                </p>
              </>
            ) : null}
          </div>
        </div>
      )}

      {dialog ? (
        <SavedPromptDialog
          initialValue={dialog.mode === "edit" ? dialog.savedPrompt : null}
          key={dialog.mode === "edit" ? dialog.savedPrompt.id : "create"}
          onClose={() => setDialog(null)}
          onSubmit={(value) => {
            if (dialog.mode === "edit") {
              updateSavedPrompt(dialog.savedPrompt.id, value);
            } else {
              addSavedPrompt(value);
            }
            setDialog(null);
          }}
        />
      ) : null}
      {skillSource ? (
        <CreateSkillDialog
          initialValue={{
            body: skillSource.prompt,
            description: skillSource.name,
            name: skillSource.name,
            userInvocationOnly: true,
          }}
          onClose={() => setSkillSource(null)}
          projectPath={activeProjectPath}
        />
      ) : null}
    </div>
  );
};

const CopyPromptButton = ({ text }: { text: string }) => {
  const commonT = useTranslations("common");
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  const handleCopy = async () => {
    if (!navigator?.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; there is nothing useful to show.
    }
  };

  return (
    <Button
      aria-label={commonT("copy")}
      className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
      size="icon-sm"
      title={commonT("copy")}
      type="button"
      variant="ghost"
    >
      {isCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
};
