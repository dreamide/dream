import { Undo } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type {
  ProjectGitDiffResponse,
  ProjectGitStatusEntry,
} from "@/types/ide";
import {
  DIFF_RENDER_CHANGED_LINE_LIMIT,
  IdeDiffViewer,
  LargeDiffGuard,
} from "../diff-viewer";
import { FileChangeHeader } from "./file-change-header";

export type DiffViewMode = "unified" | "split";

export interface ChangesPanelProps {
  active?: boolean;
  projectId?: string | null;
}

const DiffEmptyState = ({ diff }: { diff: string }) => {
  const panelsT = useTranslations("panels");
  if (diff.trim().length > 0) {
    return null;
  }

  return (
    <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
      {panelsT("noDiffOutput")}
    </pre>
  );
};

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const isImageFile = (filePath: string) => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
};

const getDeletedFileRawUrl = (projectPath: string, filePath: string) =>
  `/api/project-git-file-at-head-raw?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}`;

export const readResponseText = async (
  response: Response,
  fallback: string,
): Promise<string> => {
  const text = await response.text();
  return text.trim() || fallback;
};

const DeletedImagePreview = ({
  filePath,
  projectPath,
}: {
  filePath: string;
  projectPath: string;
}) => {
  const panelsT = useTranslations("panels");
  const uiT = useTranslations("ui");
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const loadImage = async () => {
      setError(null);
      setImageUrl(null);

      try {
        const response = await fetch(
          getDeletedFileRawUrl(projectPath, filePath),
        );
        if (!response.ok) {
          throw new Error(
            await readResponseText(
              response,
              uiT("requestFailedStatus", { status: response.status }),
            ),
          );
        }

        objectUrl = URL.createObjectURL(await response.blob());
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setImageUrl(objectUrl);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : panelsT("failedToReadImage"),
          );
        }
      }
    };

    void loadImage();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [filePath, panelsT, projectPath, uiT]);

  if (error) {
    return (
      <div className="p-4">
        <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-sm">
          {error}
        </div>
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
        <Spinner className="size-4" />
      </div>
    );
  }

  return (
    <div className="flex max-h-[560px] min-h-40 items-center justify-center overflow-auto bg-surface-100 p-6 dark:bg-surface-950">
      <img
        alt={filePath}
        className="max-h-[512px] max-w-full object-contain"
        src={imageUrl}
      />
    </div>
  );
};

const ExpandedDiffBody = ({
  change,
  diff,
  diffError,
  diffLoading,
  forceRenderDiff,
  mode,
  onForceRenderDiff,
  projectId,
  projectPath,
  wordWrap,
}: {
  change: ProjectGitStatusEntry;
  diff: ProjectGitDiffResponse | null;
  diffError: string | null;
  diffLoading: boolean;
  forceRenderDiff: boolean;
  mode: DiffViewMode;
  onForceRenderDiff: () => void;
  projectId: string;
  projectPath: string;
  wordWrap: boolean;
}) => {
  if (diffLoading && !diff) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
        <Spinner className="size-4" />
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="px-4 py-4">
        <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-sm">
          {diffError}
        </div>
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
        <Spinner className="size-4" />
      </div>
    );
  }

  const showDeletedImage =
    change.status === "deleted" && isImageFile(change.path);
  const changedLineCount = change.addedLines + change.removedLines;
  const diffTooLarge =
    changedLineCount > DIFF_RENDER_CHANGED_LINE_LIMIT && !forceRenderDiff;

  return (
    <div className="bg-surface-50 dark:bg-surface-900">
      {change.previousPath ? (
        <div className="border-b border-surface-200 dark:border-surface-800 px-4 py-2 text-muted-foreground text-xs">
          {`${change.previousPath} -> ${change.path}`}
        </div>
      ) : null}
      <div
        className={cn(
          "text-xs",
          wordWrap ? "overflow-x-hidden" : "overflow-x-auto",
        )}
      >
        {showDeletedImage ? (
          <DeletedImagePreview
            filePath={change.path}
            projectPath={projectPath}
          />
        ) : (
          <DiffEmptyState diff={diff.diff} />
        )}
        {!showDeletedImage && diff.diff.trim().length > 0 && diffTooLarge ? (
          <LargeDiffGuard
            changedLineCount={changedLineCount}
            onRenderAnyway={onForceRenderDiff}
          />
        ) : !showDeletedImage && diff.diff.trim().length > 0 ? (
          diff.parsedDiff ? (
            <>
              {diff.parsedDiff.type === "deleted" ? (
                <div className="flex justify-end px-3 py-2">
                  <CodeBlockCopyButton
                    text={diff.parsedDiff.deletionLines.join("")}
                  />
                </div>
              ) : null}
              <IdeDiffViewer
                changedLineCount={changedLineCount}
                className={wordWrap ? "min-w-0" : "min-w-[720px]"}
                diffStyle={mode}
                fileDiff={diff.parsedDiff}
                feedback={{
                  projectId,
                  filePath: change.path,
                  previousPath: change.previousPath,
                }}
                largeDiffGuardEnabled={false}
                wordWrap={wordWrap}
              />
            </>
          ) : (
            <pre
              className={cn(
                "dream-diff-viewer w-full bg-surface-100 dark:bg-surface-900 p-4 font-mono text-xs",
                wordWrap
                  ? "overflow-x-hidden whitespace-pre-wrap break-words"
                  : "overflow-x-auto whitespace-pre",
              )}
            >
              {diff.diff}
            </pre>
          )
        ) : null}
      </div>
    </div>
  );
};

export const ChangesRow = ({
  change,
  diff,
  diffError,
  diffLoading,
  expanded,
  forceRenderDiff,
  mode,
  onForceRenderDiff,
  onRevert,
  onToggle,
  projectId,
  projectPath,
  reverting,
  wordWrap,
}: {
  change: ProjectGitStatusEntry;
  diff: ProjectGitDiffResponse | null;
  diffError: string | null;
  diffLoading: boolean;
  expanded: boolean;
  forceRenderDiff: boolean;
  mode: DiffViewMode;
  onForceRenderDiff: () => void;
  onRevert: () => void;
  onToggle: () => void;
  projectId: string;
  projectPath: string;
  reverting: boolean;
  wordWrap: boolean;
}) => {
  const panelsT = useTranslations("panels");

  return (
    <div className="border-b border-surface-200 dark:border-surface-700 bg-background">
      <FileChangeHeader
        change={change}
        expanded={expanded}
        onToggle={onToggle}
        actions={
          <button
            aria-label={panelsT("revertNamedFile", { path: change.path })}
            className="pointer-events-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={reverting}
            onClick={onRevert}
            title={panelsT("revertFileChanges")}
            type="button"
          >
            {reverting ? (
              <Spinner className="size-3.5" />
            ) : (
              <Undo className="size-3.5" />
            )}
          </button>
        }
      />

      {expanded ? (
        <ExpandedDiffBody
          change={change}
          diff={diff}
          diffError={diffError}
          diffLoading={diffLoading}
          forceRenderDiff={forceRenderDiff}
          mode={mode}
          onForceRenderDiff={onForceRenderDiff}
          projectId={projectId}
          projectPath={projectPath}
          wordWrap={wordWrap}
        />
      ) : null}
    </div>
  );
};
