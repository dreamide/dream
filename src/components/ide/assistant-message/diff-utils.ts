import { parsePatchFiles } from "@pierre/diffs";
import { isRecord, isString } from "./value-utils";

export const buildLineDiff = (previousContent: string, nextContent: string) => {
  const previousLines = previousContent.replace(/\r\n/g, "\n").split("\n");
  const nextLines = nextContent.replace(/\r\n/g, "\n").split("\n");
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

  const lines: string[] = [];
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

export const parseSingleDiff = (diff: string) => {
  try {
    const parsedPatches = parsePatchFiles(diff);
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

export const getFilePathFromOutputText = (output: unknown) => {
  if (!isString(output)) {
    return null;
  }

  const match = output.match(
    /(?:^|\b)(?:the\s+)?file\s+(.+?)\s+(?:has\s+been|was)\s+(?:updated|written|created)\b/i,
  );
  const rawPath = match?.[1]?.trim();
  if (!rawPath) {
    return null;
  }

  return rawPath.replace(/^['"`]+|['"`.]+$/g, "");
};

export const formatWriteOutputMessage = (output: unknown) => {
  const message = isString(output)
    ? output
    : isRecord(output) && isString(output.message)
      ? output.message
      : null;

  if (!message) {
    return null;
  }

  return message
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\\/g, "/");
};

export const getAgentOutputText = (output: unknown): string | null => {
  if (!isString(output) || output.length === 0) {
    return null;
  }

  const withoutUsage = output.replace(/\n*<usage>[\s\S]*?<\/usage>\s*$/i, "");
  const withoutAgentId = withoutUsage.replace(
    /\n*agentId:[^\n]*(?:\n|$)/i,
    "\n",
  );
  const trimmed = withoutAgentId.trim();

  return trimmed.length > 0 ? trimmed : null;
};
