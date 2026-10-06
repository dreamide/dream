import type { FileDiffMetadata } from "@pierre/diffs";

export type PlaceholderLineKind = "context" | "addition" | "deletion";

export interface PlaceholderLine {
  kind: PlaceholderLineKind;
  number: number;
  text: string;
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

    hunk.hunkContent.forEach((content, contentIndex) => {
      const key = (suffix: string) => `${hunkIndex}-${contentIndex}-${suffix}`;

      if (content.type === "context") {
        for (let i = 0; i < content.lines; i += 1) {
          const right = addition(content.additionLineIndex + i, "context");
          rows.push(
            diffStyle === "unified"
              ? { type: "line", key: key(`c${i}`), line: right }
              : {
                  type: "split",
                  key: key(`c${i}`),
                  left: deletion(content.deletionLineIndex + i, "context"),
                  right,
                },
          );
        }
        return;
      }

      if (diffStyle === "unified") {
        for (let i = 0; i < content.deletions; i += 1) {
          rows.push({
            type: "line",
            key: key(`d${i}`),
            line: deletion(content.deletionLineIndex + i),
          });
        }
        for (let i = 0; i < content.additions; i += 1) {
          rows.push({
            type: "line",
            key: key(`a${i}`),
            line: addition(content.additionLineIndex + i),
          });
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
  });

  return rows;
};
