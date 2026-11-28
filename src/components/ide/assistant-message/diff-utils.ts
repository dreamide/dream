import { parsePatchFiles } from "@pierre/diffs";

const MAX_LCS_CELLS = 250_000;

export const buildLineDiff = (previousContent: string, nextContent: string) => {
  const allPreviousLines = previousContent.replace(/\r\n/g, "\n").split("\n");
  const allNextLines = nextContent.replace(/\r\n/g, "\n").split("\n");

  // The LCS table below is quadratic, so match the unchanged lines at both
  // ends first: a small edit to a large file then diffs only the edited span.
  const shorterLength = Math.min(allPreviousLines.length, allNextLines.length);
  let prefixLength = 0;
  while (
    prefixLength < shorterLength &&
    allPreviousLines[prefixLength] === allNextLines[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < shorterLength - prefixLength &&
    allPreviousLines[allPreviousLines.length - 1 - suffixLength] ===
      allNextLines[allNextLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const previousLines = allPreviousLines.slice(
    prefixLength,
    allPreviousLines.length - suffixLength,
  );
  const nextLines = allNextLines.slice(
    prefixLength,
    allNextLines.length - suffixLength,
  );
  const lines = allPreviousLines
    .slice(0, prefixLength)
    .map((line) => ` ${line}`);

  // Guard against quadratic memory/CPU spikes on huge full-file rewrites.
  if (previousLines.length * nextLines.length > MAX_LCS_CELLS) {
    for (const line of previousLines) lines.push(`-${line}`);
    for (const line of nextLines) lines.push(`+${line}`);
    for (
      let index = allPreviousLines.length - suffixLength;
      index < allPreviousLines.length;
      index += 1
    ) {
      lines.push(` ${allPreviousLines[index]}`);
    }
    return lines.join("\n");
  }

  const lengths = Array.from({ length: previousLines.length + 1 }, () =>
    Array<number>(nextLines.length + 1).fill(0),
  );

  for (let i = previousLines.length - 1; i >= 0; i -= 1) {
    for (let j = nextLines.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        previousLines[i] === nextLines[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  let previousIndex = 0;
  let nextIndex = 0;

  while (previousIndex < previousLines.length && nextIndex < nextLines.length) {
    if (previousLines[previousIndex] === nextLines[nextIndex]) {
      lines.push(` ${previousLines[previousIndex]}`);
      previousIndex += 1;
      nextIndex += 1;
    } else if (
      lengths[previousIndex + 1][nextIndex] >=
      lengths[previousIndex][nextIndex + 1]
    ) {
      lines.push(`-${previousLines[previousIndex]}`);
      previousIndex += 1;
    } else {
      lines.push(`+${nextLines[nextIndex]}`);
      nextIndex += 1;
    }
  }

  while (previousIndex < previousLines.length) {
    lines.push(`-${previousLines[previousIndex]}`);
    previousIndex += 1;
  }

  while (nextIndex < nextLines.length) {
    lines.push(`+${nextLines[nextIndex]}`);
    nextIndex += 1;
  }

  for (
    let index = allPreviousLines.length - suffixLength;
    index < allPreviousLines.length;
    index += 1
  ) {
    lines.push(` ${allPreviousLines[index]}`);
  }

  return lines.join("\n");
};

const getDiffLineCount = (content: string) =>
  content.length === 0 ? 0 : content.split("\n").length;

export const buildWriteDiff = ({
  content,
  filePath,
  mode,
  previousContent,
}: {
  content: string;
  filePath: string;
  mode: string | null;
  previousContent: string;
}) => {
  const nextContent =
    mode === "append" ? `${previousContent}${content}` : content;
  const previousLineCount = getDiffLineCount(previousContent);
  const nextLineCount = getDiffLineCount(nextContent);

  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -1,${previousLineCount} +1,${nextLineCount} @@`,
    buildLineDiff(previousContent, nextContent),
  ].join("\n");
};

export const parseSingleDiff = (diff: string, filePath?: string | null) => {
  try {
    const normalizedDiff =
      filePath && diff.trimStart().startsWith("@@")
        ? [`--- ${filePath}`, `+++ ${filePath}`, diff].join("\n")
        : diff;
    const parsedPatches = parsePatchFiles(normalizedDiff);
    if (parsedPatches.length !== 1) {
      return null;
    }

    const files = parsedPatches[0]?.files;
    if (!Array.isArray(files) || files.length !== 1) {
      return null;
    }

    return files[0] ?? null;
  } catch {
    return null;
  }
};

export const getDiffStats = (diff: ReturnType<typeof parseSingleDiff>) => {
  if (!diff) {
    return null;
  }

  const additions = diff.hunks.reduce(
    (total, hunk) => total + hunk.additionLines,
    0,
  );
  const deletions = diff.hunks.reduce(
    (total, hunk) => total + hunk.deletionLines,
    0,
  );

  if (additions === 0 && deletions === 0) {
    return null;
  }

  return { additions, deletions };
};

export const getWriteFileStateLabel = (
  diff: ReturnType<typeof parseSingleDiff>,
  mode: string | null,
  previousContent: string | null,
) => {
  if (diff) {
    if (diff.type === "new") {
      return "created";
    }
    if (diff.type === "deleted") {
      return "deleted";
    }
    if (diff.type === "rename-pure" || diff.type === "rename-changed") {
      return "renamed";
    }
    return "modified";
  }

  if (mode === "append" || previousContent !== null) {
    return "modified";
  }

  return null;
};
