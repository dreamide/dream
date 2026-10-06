import type { FileDiffMetadata } from "@pierre/diffs";

export type PlaceholderLineKind = "context" | "addition" | "deletion";

export interface PlaceholderLine {
  kind: PlaceholderLineKind;
  number: number;
  text: string;
  metadata?: "no-newline";
}

export type PlaceholderRow =
  | { type: "separator"; key: string }
  | { type: "line"; key: string; line: PlaceholderLine }
  | {
      type: "split";
      key: string;
      left: PlaceholderLine | null;
      right: PlaceholderLine | null;
    };

// Pierre keeps each line's terminator; the placeholder renders one row per line.
const stripLineEnding = (line: string | undefined) =>
  (line ?? "").replace(/\r?\n$/, "");

const noNewline = (line: PlaceholderLine): PlaceholderLine => ({
  ...line,
  text: "No newline at end of file",
  metadata: "no-newline",
});

/**
 * Rows for the plain-text stand-in shown while a diff is highlighted, laid out
 * the way Pierre lays out the finished diff: hunks separated by a collapsed
 * "unmodified lines" bar, deletions before additions in unified view, and
 * deletions beside additions in split view.
 */
export const buildPlaceholderRows = (
  fileDiff: FileDiffMetadata,
  diffStyle: "unified" | "split",
): PlaceholderRow[] => {
  const rows: PlaceholderRow[] = [];
  // Pierre omits the nonexistent side of added and deleted files.
  const singleColumn =
    diffStyle === "unified" ||
    fileDiff.type === "new" ||
    fileDiff.type === "deleted";

  fileDiff.hunks.forEach((hunk, hunkIndex) => {
    if (hunk.collapsedBefore > 0) {
      rows.push({ type: "separator", key: `separator-${hunkIndex}` });
    }

    const addition = (
      index: number,
      kind: PlaceholderLineKind = "addition",
    ): PlaceholderLine => ({
      kind,
      number: hunk.additionStart + index - hunk.additionLineIndex,
      text: stripLineEnding(fileDiff.additionLines[index]),
    });
    const deletion = (
      index: number,
      kind: PlaceholderLineKind = "deletion",
    ): PlaceholderLine => ({
      kind,
      number: hunk.deletionStart + index - hunk.deletionLineIndex,
      text: stripLineEnding(fileDiff.deletionLines[index]),
    });
    const lastAddition = hunk.additionLineIndex + hunk.additionCount - 1;
    const lastDeletion = hunk.deletionLineIndex + hunk.deletionCount - 1;
    const pushLine = (
      key: string,
      line: PlaceholderLine,
      missingNewline = false,
    ) => {
      rows.push({ type: "line", key, line });
      if (missingNewline) {
        rows.push({
          type: "line",
          key: `${key}-no-newline`,
          line: noNewline(line),
        });
      }
    };

    hunk.hunkContent.forEach((content, contentIndex) => {
      const key = (suffix: string) => `${hunkIndex}-${contentIndex}-${suffix}`;

      if (content.type === "context") {
        for (let i = 0; i < content.lines; i += 1) {
          const right = addition(content.additionLineIndex + i, "context");
          if (singleColumn) {
            pushLine(key(`c${i}`), right);
            if (
              hunk.noEOFCRDeletions &&
              content.deletionLineIndex + i === lastDeletion
            ) {
              rows.push({
                type: "line",
                key: key(`c${i}-deletion-no-newline`),
                line: noNewline(deletion(lastDeletion, "context")),
              });
            }
            if (
              hunk.noEOFCRAdditions &&
              content.additionLineIndex + i === lastAddition
            ) {
              rows.push({
                type: "line",
                key: key(`c${i}-addition-no-newline`),
                line: noNewline(right),
              });
            }
          } else {
            rows.push({
              type: "split",
              key: key(`c${i}`),
              left: deletion(content.deletionLineIndex + i, "context"),
              right,
            });
          }
        }
        return;
      }

      if (singleColumn) {
        for (let i = 0; i < content.deletions; i += 1) {
          const index = content.deletionLineIndex + i;
          pushLine(
            key(`d${i}`),
            deletion(index),
            hunk.noEOFCRDeletions && index === lastDeletion,
          );
        }
        for (let i = 0; i < content.additions; i += 1) {
          const index = content.additionLineIndex + i;
          pushLine(
            key(`a${i}`),
            addition(index),
            hunk.noEOFCRAdditions && index === lastAddition,
          );
        }
        return;
      }

      const height = Math.max(content.deletions, content.additions);
      for (let i = 0; i < height; i += 1) {
        rows.push({
          type: "split",
          key: key(`s${i}`),
          left:
            i < content.deletions
              ? deletion(content.deletionLineIndex + i)
              : null,
          right:
            i < content.additions
              ? addition(content.additionLineIndex + i)
              : null,
        });
      }
    });
    if (!singleColumn && (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions)) {
      // Split metadata shares a row, including when the two sides have
      // different lengths. Pierre places it after the final hunk row.
      const context = hunk.hunkContent.at(-1)?.type === "context";
      rows.push({
        type: "split",
        key: `${hunkIndex}-no-newline`,
        left: hunk.noEOFCRDeletions
          ? noNewline(deletion(lastDeletion, context ? "context" : "deletion"))
          : null,
        right: hunk.noEOFCRAdditions
          ? noNewline(addition(lastAddition, context ? "context" : "addition"))
          : null,
      });
    }
  });

  return rows;
};
