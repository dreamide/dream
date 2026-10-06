import {
  getFiletypeFromFileName,
  preloadHighlighter,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  FileDiff,
  type FileDiffProps,
  WorkerPoolContext,
} from "@pierre/diffs/react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { withDiffCacheKey } from "./diff-cache-key";
import { DiffPlaceholder } from "./diff-placeholder";
import {
  DIFF_HIGHLIGHTER,
  DIFF_THEMES,
  useDiffWorkerPool,
} from "./diff-worker-pool";
import {
  type DiffFeedbackTarget,
  InlineDiffFeedback,
} from "./inline-diff-feedback";

type DiffViewMode = "unified" | "split";
type PierreDiffOptions = NonNullable<
  FileDiffProps<undefined, undefined>["options"]
>;
type ParsedFileDiff = FileDiffProps<undefined, undefined>["fileDiff"];

export const DIFF_RENDER_CHANGED_LINE_LIMIT = 500;

const DIFF_UNMODIFIED_LINES_CSS = `
[data-separator='line-info'] {
  margin-block: 0;
  background-color: var(--color-muted);
}

[data-separator='line-info'] [data-separator-wrapper],
[data-separator='line-info'] [data-expand-button],
[data-separator='line-info'] [data-separator-content] {
  background-color: var(--color-muted);
}

[data-separator='line-info'] [data-separator-content] {
  padding-inline: 0;
}

[data-separator='line-info'] [data-expand-button] {
  border-right-color: transparent;
}

[data-separator='line-info'] [data-expand-up],
[data-separator='line-info'] [data-expand-down] {
  border-color: transparent;
}
`;

const getFileDiffChangedLineCount = (fileDiff: ParsedFileDiff) =>
  fileDiff?.hunks.reduce(
    (total, hunk) => total + hunk.additionLines + hunk.deletionLines,
    0,
  ) ?? 0;

export const LargeDiffGuard = ({
  changedLineCount,
  limit = DIFF_RENDER_CHANGED_LINE_LIMIT,
  onRenderAnyway,
}: {
  changedLineCount: number;
  limit?: number;
  onRenderAnyway: () => void;
}) => {
  const panelsT = useTranslations("panels");

  return (
    <div className="px-4 py-4 text-sm">
      <div className="font-medium text-foreground">
        {panelsT("diffTooLarge")}
      </div>
      <div className="mt-2 text-muted-foreground">
        {panelsT("diffLineLimit", { current: changedLineCount, limit })}
      </div>
      <Button
        className="mt-3"
        onClick={onRenderAnyway}
        size="sm"
        type="button"
        variant="outline"
      >
        {panelsT("renderAnyway")}
      </Button>
    </div>
  );
};

export const IdeDiffViewer = ({
  changedLineCount,
  className,
  diffStyle = "unified",
  fileDiff,
  feedback,
  onLineComment,
  selectedLines,
  largeDiffGuardEnabled = true,
  renderChangedLineLimit = DIFF_RENDER_CHANGED_LINE_LIMIT,
  wordWrap = false,
}: {
  changedLineCount?: number;
  className?: string;
  diffStyle?: DiffViewMode;
  fileDiff: ParsedFileDiff;
  feedback?: DiffFeedbackTarget;
  onLineComment?: (range: SelectedLineRange) => void;
  selectedLines?: SelectedLineRange | null;
  largeDiffGuardEnabled?: boolean;
  renderChangedLineLimit?: number;
  wordWrap?: boolean;
}) => {
  const { resolvedTheme } = useTheme();
  const [renderAnyway, setRenderAnyway] = useState(false);
  const resolvedChangedLineCount =
    changedLineCount ?? getFileDiffChangedLineCount(fileDiff);
  const guarded =
    largeDiffGuardEnabled &&
    resolvedChangedLineCount > renderChangedLineLimit &&
    !renderAnyway;
  const languages = useMemo(
    () =>
      fileDiff.lang
        ? [fileDiff.lang]
        : [
            ...new Set([
              getFiletypeFromFileName(fileDiff.prevName ?? fileDiff.name),
              getFiletypeFromFileName(fileDiff.name),
            ]),
          ],
    [fileDiff.lang, fileDiff.name, fileDiff.prevName],
  );
  // A content-derived cacheKey lets the pool pre-highlight this diff and
  // reuse the result when the same diff is opened again.
  const keyedDiff = useMemo(() => withDiffCacheKey(fileDiff), [fileDiff]);
  const { pool, ready: poolReady } = useDiffWorkerPool(!guarded);
  const poolWorking = poolReady && pool?.isWorkingPool() === true;
  // Without a working pool (no Worker support, or the workers failed), Pierre
  // highlights on the main thread and needs its resources loaded up front.
  const highlightOnMainThread = poolReady && !poolWorking;
  const [loadedLanguages, setLoadedLanguages] = useState<
    typeof languages | null
  >(null);
  const [highlightError, setHighlightError] = useState<string | null>(null);

  useEffect(() => {
    if (guarded || !highlightOnMainThread) return;
    let cancelled = false;
    setHighlightError(null);
    // A cold FileDiff mount can leave an empty <pre> that StrictMode's
    // remount hydrates as finished content. Load resources before mounting.
    void preloadHighlighter({
      themes: [DIFF_THEMES.dark, DIFF_THEMES.light],
      langs: languages,
      preferredHighlighter: DIFF_HIGHLIGHTER,
    }).then(
      () => {
        if (!cancelled) setLoadedLanguages(languages);
      },
      (error: unknown) => {
        if (!cancelled) setHighlightError(String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [guarded, highlightOnMainThread, languages]);

  // Mount FileDiff only once its highlighted result is in the pool's cache, so
  // it paints highlighted on its first frame instead of flashing plain text.
  // After that it stays mounted: Pierre keeps showing the previous highlighted
  // render while a changed diff is re-highlighted.
  const [workerHighlighted, setWorkerHighlighted] = useState(false);
  useEffect(() => {
    if (guarded || !poolWorking || !pool) return;
    let cancelled = false;
    // On failure Pierre falls back to plain or main-thread rendering itself.
    const reveal = () => {
      if (!cancelled) setWorkerHighlighted(true);
    };
    pool.primeDiffHighlightCache(keyedDiff).then(reveal, reveal);
    return () => {
      cancelled = true;
    };
  }, [guarded, keyedDiff, pool, poolWorking]);

  const highlighterReady = poolWorking
    ? workerHighlighted
    : highlightOnMainThread && loadedLanguages === languages;
  const diffOptions = useMemo<PierreDiffOptions>(
    () => ({
      diffIndicators: "bars",
      diffStyle,
      disableFileHeader: true,
      hunkSeparators: "line-info",
      lineDiffType: "none",
      overflow: wordWrap ? "wrap" : "scroll",
      preferredHighlighter: DIFF_HIGHLIGHTER,
      theme: DIFF_THEMES,
      themeType: resolvedTheme === "dark" ? "dark" : "light",
      unsafeCSS: DIFF_UNMODIFIED_LINES_CSS,
      ...(onLineComment
        ? {
            enableGutterUtility: true,
            onGutterUtilityClick: onLineComment,
            controlledSelection: true,
          }
        : {}),
    }),
    [diffStyle, resolvedTheme, wordWrap, onLineComment],
  );

  if (guarded) {
    return (
      <div className={cn("dream-diff-surface", className)}>
        <LargeDiffGuard
          changedLineCount={resolvedChangedLineCount}
          limit={renderChangedLineLimit}
          onRenderAnyway={() => setRenderAnyway(true)}
        />
      </div>
    );
  }

  if (highlightError) {
    return (
      <div className={cn("dream-diff-surface p-4", className)}>
        <p role="alert" className="text-sm text-destructive">
          {highlightError}
        </p>
      </div>
    );
  }

  if (!highlighterReady) {
    return (
      <div className={cn("dream-diff-surface", className)}>
        <DiffPlaceholder
          diffStyle={diffStyle}
          fileDiff={keyedDiff}
          wordWrap={wordWrap}
        />
      </div>
    );
  }

  return (
    <WorkerPoolContext.Provider value={pool}>
      <div className={cn("dream-diff-surface", className)}>
        {feedback ? (
          <InlineDiffFeedback
            fileDiff={keyedDiff}
            options={diffOptions}
            target={feedback}
          />
        ) : (
          <FileDiff
            className="dream-diff-viewer w-full min-w-0"
            fileDiff={keyedDiff}
            options={diffOptions}
            selectedLines={selectedLines}
          />
        )}
      </div>
    </WorkerPoolContext.Provider>
  );
};
