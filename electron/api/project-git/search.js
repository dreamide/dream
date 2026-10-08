// Find in files: the text of every searchable file in a project, matched line
// by line against one query. Searchable is what the editor could open: text,
// at most `SEARCH_MAX_FILE_BYTES`, not ignored by git or the blocked
// directories (`walkProjectFiles`). Runs on whichever host has the project,
// so it uses nothing but Node.
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { RouteError } from "../shared/json-route.js";
import { isLikelyBinaryBuffer, walkProjectFiles } from "./files.js";

export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** Longest line preview sent back; long (minified) lines are cut around the match. */
export const SEARCH_PREVIEW_MAX_CHARS = 240;
/** How much of the line a cut preview keeps before the first match. */
const SEARCH_PREVIEW_CONTEXT_CHARS = 40;
const SEARCH_READ_CONCURRENCY = 16;
const ELLIPSIS = "…";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The query as a global RegExp. A literal query is escaped; `wholeWord`
 * wraps it in word boundaries. An invalid pattern is a 400.
 */
export const buildSearchPattern = ({
  caseSensitive = false,
  query,
  regexp = false,
  wholeWord = false,
}) => {
  const source = regexp ? query : escapeRegExp(query);
  try {
    return new RegExp(
      wholeWord ? `\\b(?:${source})\\b` : source,
      caseSensitive ? "g" : "gi",
    );
  } catch (error) {
    throw new RouteError(
      error instanceof Error ? error.message : "Invalid regular expression.",
      400,
    );
  }
};

/**
 * Comma-separated gitignore-style patterns (`src, *.test.ts`) as one matcher,
 * or null when there are none.
 */
export const parseFilePatterns = (text) => {
  const patterns = text
    .split(",")
    .map((pattern) => pattern.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  return patterns.length > 0 ? ignore().add(patterns) : null;
};

/** Every non-empty match of `pattern` in `line`, as [start, end) offsets. */
export const findLineMatches = (line, pattern) => {
  const ranges = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(line);
  while (match !== null) {
    if (match[0].length === 0) {
      // An empty match (`a*`, `^`) highlights nothing; step past it.
      pattern.lastIndex += 1;
      if (pattern.lastIndex > line.length) break;
    } else {
      ranges.push([match.index, match.index + match[0].length]);
    }
    match = pattern.exec(line);
  }
  return ranges;
};

/**
 * The part of `line` to show for its matches, without leading indentation,
 * cut to at most `SEARCH_PREVIEW_MAX_CHARS` around the first match, with the
 * ranges moved into the preview's offsets.
 */
export const buildLinePreview = (line, ranges) => {
  const firstStart = ranges[0][0];
  let start = 0;
  while (start < firstStart && (line[start] === " " || line[start] === "\t")) {
    start += 1;
  }
  if (firstStart - start > SEARCH_PREVIEW_CONTEXT_CHARS) {
    start = firstStart - SEARCH_PREVIEW_CONTEXT_CHARS;
  }
  const end = Math.min(line.length, start + SEARCH_PREVIEW_MAX_CHARS);
  const prefix = line.slice(0, start).trim() ? ELLIPSIS : "";
  const suffix = end < line.length ? ELLIPSIS : "";
  const shift = prefix.length - start;

  return {
    preview: `${prefix}${line.slice(start, end)}${suffix}`,
    ranges: ranges
      .filter(([rangeStart]) => rangeStart < end)
      .map(([rangeStart, rangeEnd]) => [
        Math.max(rangeStart, start) + shift,
        Math.min(rangeEnd, end) + shift,
      ]),
  };
};

/** Each matching line of `text`, with its matches. */
export const searchText = (text, pattern) => {
  const lines = [];
  const rows = text.split(/\r?\n/);
  for (let index = 0; index < rows.length; index += 1) {
    const ranges = findLineMatches(rows[index], pattern);
    if (ranges.length === 0) continue;
    const [column, columnEnd] = ranges[0];
    lines.push({
      column,
      length: columnEnd - column,
      line: index + 1,
      matchCount: ranges.length,
      ...buildLinePreview(rows[index], ranges),
    });
  }
  return lines;
};

/**
 * Searches the project at `projectPath`. Results are in path order and stop
 * at `maxResults` matches (`truncated`). Stops early, answering with what it
 * has, once `signal` aborts (the client stopped waiting).
 */
export const searchProjectFiles = async (
  {
    caseSensitive,
    exclude,
    include,
    maxResults,
    projectPath,
    query,
    regexp,
    wholeWord,
  },
  signal,
) => {
  const pattern = buildSearchPattern({
    caseSensitive,
    query,
    regexp,
    wholeWord,
  });
  const includeRules = parseFilePatterns(include);
  const excludeRules = parseFilePatterns(exclude);
  const root = await fs.realpath(projectPath);

  const searchFile = async (relativePath) => {
    const absolutePath = path.join(root, relativePath);
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.size === 0 || stats.size > SEARCH_MAX_FILE_BYTES) return null;
      const data = await fs.readFile(absolutePath);
      if (isLikelyBinaryBuffer(data)) return null;
      const text = data.toString("utf8");
      // Quick whole-file rejection; a regular expression may use line
      // anchors, so it is only safe for literal queries.
      if (!regexp) {
        pattern.lastIndex = 0;
        if (!pattern.test(text)) return null;
      }
      const lines = searchText(text, pattern);
      return lines.length > 0 ? { lines, path: relativePath } : null;
    } catch (error) {
      // Removed or unreadable since the walk listed it.
      if (error?.code === "ENOENT" || error?.code === "EACCES") return null;
      throw error;
    }
  };

  const files = [];
  let matchCount = 0;
  let truncated = false;

  const collect = (result) => {
    if (!result) return;
    const lines = [];
    for (const line of result.lines) {
      if (matchCount >= maxResults) {
        truncated = true;
        break;
      }
      lines.push(line);
      matchCount += line.matchCount;
    }
    if (lines.length > 0) files.push({ lines, path: result.path });
  };

  let batch = [];
  const flush = async () => {
    const results = await Promise.all(batch.map(searchFile));
    batch = [];
    for (const result of results) {
      if (truncated) break;
      collect(result);
    }
  };

  for await (const relativePath of walkProjectFiles(root, {
    signal,
    skipDirectory: excludeRules
      ? (relative) => excludeRules.ignores(`${relative}/`)
      : undefined,
  })) {
    if (excludeRules?.ignores(relativePath)) continue;
    if (includeRules && !includeRules.ignores(relativePath)) continue;
    batch.push(relativePath);
    if (batch.length >= SEARCH_READ_CONCURRENCY) {
      await flush();
      if (truncated || signal?.aborted) break;
    }
  }
  if (!truncated && !signal?.aborted) await flush();

  return { files, matchCount, truncated };
};
