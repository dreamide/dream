// Find in files: the text of every searchable file in a project, matched line
// by line against one query. Searchable is what the editor could open: text,
// at most `SEARCH_MAX_FILE_BYTES`, not ignored by git or the blocked
// directories (`walkProjectFiles`). Runs on whichever host has the project,
// so it uses nothing but Node.
import { promises as fs } from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import ignore from "ignore";
import { RouteError } from "../shared/json-route.js";
import { decodeTextBuffer, walkProjectFiles } from "./files.js";

export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** Longest line preview sent back; long (minified) lines are cut around the match. */
export const SEARCH_PREVIEW_MAX_CHARS = 240;
/** How much of the line a cut preview keeps before the first match. */
const SEARCH_PREVIEW_CONTEXT_CHARS = 40;
const SEARCH_READ_CONCURRENCY = 16;
const SEARCH_YIELD_INTERVAL = 256;
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

/** Null checkpoints let the host yield even for patterns with empty matches. */
function* iterateLineMatches(line, pattern, signal) {
  pattern.lastIndex = 0;
  let steps = 0;
  while (!signal?.aborted) {
    const match = pattern.exec(line);
    if (match === null) return;
    if (match[0].length === 0) {
      // An empty match (`a*`, `^`) highlights nothing; step past it.
      pattern.lastIndex += 1;
      if (pattern.lastIndex > line.length) break;
    } else {
      yield [match.index, match.index + match[0].length];
    }
    if (++steps % SEARCH_YIELD_INTERVAL === 0) yield null;
  }
}

/** Every non-empty match of `pattern` in `line`, as [start, end) offsets. */
export const findLineMatches = (line, pattern) =>
  [...iterateLineMatches(line, pattern)].filter((range) => range !== null);

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

/** One budget spans files; the first excess match proves truncation. */
function* scanText(text, pattern, budget, signal) {
  let offset = 0;
  let lineNumber = 1;
  while (offset <= text.length && !signal?.aborted) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const row = text.slice(
      offset,
      newline !== -1 && text[end - 1] === "\r" ? end - 1 : end,
    );
    const ranges = [];
    for (const range of iterateLineMatches(row, pattern, signal)) {
      if (range === null) {
        yield null;
      } else if (budget.remaining === 0) {
        budget.truncated = true;
        break;
      } else {
        budget.remaining -= 1;
        ranges.push(range);
      }
    }
    if (ranges.length > 0) {
      const [column, columnEnd] = ranges[0];
      yield {
        column,
        length: columnEnd - column,
        line: lineNumber,
        matchCount: ranges.length,
        ...buildLinePreview(row, ranges),
      };
    }
    if (budget.truncated || newline === -1) return;
    // Files with no matches also give cancellation a chance to run.
    if (lineNumber % SEARCH_YIELD_INTERVAL === 0) yield null;
    offset = newline + 1;
    lineNumber += 1;
  }
}

/** Each matching line of `text`, with its matches (without a result limit). */
export const searchText = (text, pattern) =>
  [
    ...scanText(text, pattern, { remaining: Infinity, truncated: false }),
  ].filter((line) => line !== null);

/**
 * Searches the project at `projectPath`. Results are in path order and stop
 * at `maxResults` individual matches. One excess match proves `truncated`;
 * an exact-limit complete result is not truncated. Stops early, answering
 * with what it has, once `signal` aborts (the client stopped waiting).
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
  const controller = new AbortController();
  const searchSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  if (searchSignal.aborted)
    return { files: [], matchCount: 0, truncated: false };
  const root = await fs.realpath(projectPath);

  const readText = async (relativePath) => {
    const absolutePath = path.join(root, relativePath);
    try {
      if (searchSignal.aborted) return null;
      const stats = await fs.stat(absolutePath);
      if (searchSignal.aborted) return null;
      if (stats.size === 0 || stats.size > SEARCH_MAX_FILE_BYTES) return null;
      const data = await fs.readFile(absolutePath, { signal: searchSignal });
      if (searchSignal.aborted || data.length > SEARCH_MAX_FILE_BYTES)
        return null;
      return decodeTextBuffer(data);
    } catch (error) {
      if (searchSignal.aborted && error?.name === "AbortError") return null;
      // Removed or unreadable since the walk listed it.
      if (error?.code === "ENOENT" || error?.code === "EACCES") return null;
      throw error;
    }
  };

  const files = [];
  const budget = { remaining: maxResults, truncated: false };
  const stopped = () => budget.truncated || searchSignal.aborted;

  let batch = [];
  let reads = [];
  const flush = async () => {
    // Read concurrently, but consume and match in path order. Capture errors
    // immediately so an unconsumed read can never reject without a handler.
    reads = batch.map(async (relativePath) => {
      try {
        return { path: relativePath, text: await readText(relativePath) };
      } catch (error) {
        return { error };
      }
    });
    batch = [];
    for (const read of reads) {
      if (stopped()) break;
      const result = await read;
      if (stopped()) break;
      if ("error" in result) throw result.error;
      if (!result.text) continue;
      // Preserve the fast whole-file rejection for literal queries. Regex
      // anchors must instead be evaluated against individual lines.
      if (!regexp) {
        pattern.lastIndex = 0;
        if (!pattern.test(result.text)) continue;
      }
      const lines = [];
      for (const line of scanText(result.text, pattern, budget, searchSignal)) {
        if (line === null) await yieldToEventLoop();
        else lines.push(line);
      }
      if (lines.length > 0) files.push({ lines, path: result.path });
    }
  };

  try {
    for await (const relativePath of walkProjectFiles(root, {
      signal: searchSignal,
      skipDirectory: excludeRules
        ? (relative) => excludeRules.ignores(`${relative}/`)
        : undefined,
    })) {
      if (excludeRules?.ignores(relativePath)) continue;
      if (includeRules && !includeRules.ignores(relativePath)) continue;
      batch.push(relativePath);
      if (batch.length >= SEARCH_READ_CONCURRENCY) {
        await flush();
        if (stopped()) break;
      }
    }
    if (!stopped()) await flush();
  } finally {
    controller.abort();
    await Promise.all(reads);
  }

  return {
    files,
    matchCount: maxResults - budget.remaining,
    truncated: budget.truncated,
  };
};
