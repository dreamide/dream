import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  hashContent,
  listProjectFiles,
  normalizePath,
  resolveProjectPath,
} from "../project-git/files.js";

export { hashContent, listProjectFiles, normalizePath, resolveProjectPath };

const buildLineDiff = (previousContent, nextContent) => {
  const previousLines = previousContent.split("\n");
  const nextLines = nextContent.split("\n");
  const lines = [];
  let previousIndex = 0;
  let nextIndex = 0;

  while (previousIndex < previousLines.length && nextIndex < nextLines.length) {
    if (previousLines[previousIndex] === nextLines[nextIndex]) {
      lines.push(` ${previousLines[previousIndex]}`);
      previousIndex += 1;
      nextIndex += 1;
      continue;
    }

    const nextInPrevious = previousLines.indexOf(
      nextLines[nextIndex],
      previousIndex + 1,
    );
    const previousInNext = nextLines.indexOf(
      previousLines[previousIndex],
      nextIndex + 1,
    );

    if (
      nextInPrevious !== -1 &&
      (previousInNext === -1 ||
        nextInPrevious - previousIndex <= previousInNext - nextIndex)
    ) {
      while (previousIndex < nextInPrevious) {
        lines.push(`-${previousLines[previousIndex]}`);
        previousIndex += 1;
      }
      continue;
    }

    if (previousInNext !== -1) {
      while (nextIndex < previousInNext) {
        lines.push(`+${nextLines[nextIndex]}`);
        nextIndex += 1;
      }
      continue;
    }

    lines.push(`-${previousLines[previousIndex]}`);
    lines.push(`+${nextLines[nextIndex]}`);
    previousIndex += 1;
    nextIndex += 1;
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

const getDiffLineCount = (content) =>
  content.length === 0 ? 0 : content.split("\n").length;

export const buildSavedWriteDiff = ({
  filePath,
  isNewFile,
  nextContent,
  previousContent,
}) => {
  const normalizedFilePath = normalizePath(filePath);
  const previousLineCount = getDiffLineCount(previousContent);
  const nextLineCount = getDiffLineCount(nextContent);

  return [
    `diff --git a/${normalizedFilePath} b/${normalizedFilePath}`,
    isNewFile ? "new file mode 100644" : null,
    `--- ${isNewFile ? "/dev/null" : `a/${normalizedFilePath}`}`,
    `+++ b/${normalizedFilePath}`,
    `@@ -${isNewFile ? 0 : 1},${previousLineCount} +1,${nextLineCount} @@`,
    buildLineDiff(previousContent, nextContent),
  ]
    .filter(Boolean)
    .join("\n");
};

export const searchInProjectFiles = async (projectRoot, query, maxResults) => {
  const files = await listProjectFiles(projectRoot, ".", 250);
  const matches = [];
  for (const relativePath of files) {
    if (matches.length >= maxResults) break;
    const absolutePath = resolveProjectPath(projectRoot, relativePath);
    let content = "";
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (!content.includes(query)) continue;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.includes(query)) continue;
      matches.push({ file: relativePath, line: index + 1, text: line.trim() });
      if (matches.length >= maxResults) break;
    }
  }
  return matches;
};

export const createClaudeProjectTools = ({
  claudePermissionMode,
  projectPath,
}) => ({
  listFiles: tool({
    description:
      "List project files recursively. Use this before reading or editing unfamiliar areas.",
    inputSchema: z.object({
      directory: z.string().default("."),
      maxResults: z.number().int().min(1).max(400).default(200),
    }),
    execute: async ({ directory, maxResults }) => {
      const files = await listProjectFiles(projectPath, directory, maxResults);
      return { count: files.length, files };
    },
  }),
  readFile: tool({
    description:
      "Read a UTF-8 file from the project. Optionally scope output by line range.",
    inputSchema: z.object({
      endLine: z.number().int().min(1).optional(),
      filePath: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
    }),
    execute: async ({ endLine, filePath, startLine }) => {
      const absolutePath = resolveProjectPath(projectPath, filePath);
      const fullText = await fs.readFile(absolutePath, "utf8");
      if (!startLine && !endLine) {
        return { filePath, content: fullText };
      }
      const lines = fullText.split(/\r?\n/);
      const safeStart = Math.max(1, startLine ?? 1);
      const safeEnd = Math.min(lines.length, endLine ?? lines.length);
      if (safeStart > safeEnd) {
        throw new Error("startLine cannot be greater than endLine.");
      }
      const content = lines.slice(safeStart - 1, safeEnd).join("\n");
      return { content, endLine: safeEnd, filePath, startLine: safeStart };
    },
  }),
  searchInFiles: tool({
    description:
      "Search text across project files and return matching file/line snippets.",
    inputSchema: z.object({
      maxResults: z.number().int().min(1).max(100).default(25),
      query: z.string().min(1),
    }),
    execute: async ({ maxResults, query }) => {
      const matches = await searchInProjectFiles(
        projectPath,
        query,
        maxResults,
      );
      return { count: matches.length, matches };
    },
  }),
  writeFile: tool({
    description:
      "Write UTF-8 content to a file in the project. Creates parent directories as needed.",
    inputSchema: z.object({
      content: z.string(),
      filePath: z.string().min(1),
      mode: z.enum(["overwrite", "append"]).default("overwrite"),
    }),
    requireApproval: claudePermissionMode === "ask-permissions",
    execute: async ({ content, filePath, mode }) => {
      const absolutePath = resolveProjectPath(projectPath, filePath);
      let previousContent;
      try {
        previousContent = await fs.readFile(absolutePath, "utf8");
      } catch {
        // File does not exist yet.
      }
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      if (mode === "append") {
        await fs.appendFile(absolutePath, content, "utf8");
      } else {
        await fs.writeFile(absolutePath, content, "utf8");
      }
      const beforeContent = previousContent ?? "";
      const nextContent =
        mode === "append" ? `${beforeContent}${content}` : content;
      return {
        bytesWritten: Buffer.byteLength(content, "utf8"),
        content,
        contentHash: hashContent(nextContent),
        diff: buildSavedWriteDiff({
          filePath,
          isNewFile: previousContent === undefined,
          nextContent,
          previousContent: beforeContent,
        }),
        diffFormat: "unified",
        filePath,
        mode,
        previousContentHash: hashContent(beforeContent),
        status: "ok",
        ...(previousContent !== undefined ? { previousContent } : {}),
      };
    },
  }),
});
