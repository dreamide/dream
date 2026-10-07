import type { FileDiffMetadata } from "@pierre/diffs";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  buildPlaceholderRows,
  type PlaceholderLine,
} from "./diff-placeholder-rows";

// Colours, gutter bars and separators come from .dream-diff-placeholder in
// globals.css, which mirrors how Pierre paints the finished diff.
const PlaceholderCell = ({
  fill,
  line,
  numberWidth,
  wordWrap,
}: {
  fill: boolean;
  line: PlaceholderLine | null;
  numberWidth: string;
  wordWrap: boolean;
}) => {
  if (!line) {
    return <div className="min-h-[1.5em]" data-kind="empty" />;
  }

  return (
    <div
      className={cn("flex min-h-[1.5em]", fill && "w-max min-w-full")}
      data-kind={line.kind}
      data-metadata={line.metadata}
    >
      <span
        className="shrink-0 select-none border-r-2 border-transparent pr-[1ch] text-right tabular-nums"
        data-number=""
        style={{ width: numberWidth }}
      >
        {line.metadata ? null : line.number}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 pl-[1ch]",
          line.metadata
            ? "select-none opacity-60"
            : wordWrap
              ? "whitespace-pre-wrap break-words"
              : "whitespace-pre",
        )}
      >
        {line.text}
      </span>
    </div>
  );
};

/**
 * The diff as plain, muted text, shown until its highlighted version is ready.
 * Keeps the finished diff's rows, gutter and add/delete tints so the swap only
 * changes the colour of the code, not the layout.
 */
export const DiffPlaceholder = ({
  className,
  diffStyle,
  fileDiff,
  wordWrap,
}: {
  className?: string;
  diffStyle: "unified" | "split";
  fileDiff: FileDiffMetadata;
  wordWrap: boolean;
}) => {
  const rows = useMemo(
    () => buildPlaceholderRows(fileDiff, diffStyle),
    [diffStyle, fileDiff],
  );
  // Pierre's gutter: 2ch + the widest line number + 1ch, plus a 2px border.
  const numberWidth = useMemo(() => {
    const largest = fileDiff.hunks.reduce(
      (max, hunk) =>
        Math.max(
          max,
          hunk.additionStart + hunk.additionCount,
          hunk.deletionStart + hunk.deletionCount,
        ),
      0,
    );
    return `calc(${String(largest).length + 3}ch + 2px)`;
  }, [fileDiff]);
  // Single-column rows scroll together, including added and deleted files.
  const fill =
    !wordWrap &&
    (diffStyle === "unified" ||
      fileDiff.type === "new" ||
      fileDiff.type === "deleted");

  return (
    // py-2: Pierre leaves 8px above the first row and below the last in every
    // layout, so the rows must start at the same height to avoid a jump.
    <div
      aria-busy="true"
      className={cn(
        "dream-diff-viewer dream-diff-placeholder w-full min-w-0 py-2 text-muted-foreground",
        // Pierre reserves the bottom 8px for scrolling. A native placeholder
        // scrollbar adds another row of pixels; hide it during this brief state
        // while preserving wheel/trackpad scrolling and the final row geometry.
        fill && "overflow-x-auto no-scrollbar",
        className,
      )}
    >
      {rows.map((row) => {
        if (row.type === "separator") {
          return <div data-separator="" key={row.key} />;
        }
        if (row.type === "line") {
          return (
            <PlaceholderCell
              fill={fill}
              key={row.key}
              line={row.line}
              numberWidth={numberWidth}
              wordWrap={wordWrap}
            />
          );
        }
        return (
          <div
            className="grid grid-cols-2 [&>*]:min-w-0 [&>*]:overflow-hidden"
            key={row.key}
          >
            <PlaceholderCell
              fill={false}
              line={row.left}
              numberWidth={numberWidth}
              wordWrap={wordWrap}
            />
            <PlaceholderCell
              fill={false}
              line={row.right}
              numberWidth={numberWidth}
              wordWrap={wordWrap}
            />
          </div>
        );
      })}
    </div>
  );
};
