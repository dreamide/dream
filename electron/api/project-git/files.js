import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import ignore from "ignore";

export const MIME_TYPES = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const BLOCKED_DIRECTORIES = new Set([
  ".angular",
  ".cache",
  ".git",
  ".claude",
  ".cursor",
  ".expo",
  ".gradle",
  ".hypothesis",
  ".idea",
  ".mypy_cache",
  ".netlify",
  ".next",
  ".nox",
  ".nuxt",
  ".nx",
  ".output",
  ".parcel-cache",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".serverless",
  ".svelte-kit",
  ".terraform",
  ".tox",
  ".turbo",
  ".venv",
  ".vercel",
  ".vite",
  ".vscode",
  ".wrangler",
  ".yarn",
  ".zed",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
  "venv",
]);

const BINARY_CONTROL_CHAR_RATIO = 0.1;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const isAllowedTextControlByte = (byte) =>
  byte === 9 || byte === 10 || byte === 12 || byte === 13;

const BINARY_SAMPLE_BYTES = 8_192;

/**
 * Decodes `buffer` as UTF-8 text in a single pass, returning null when the
 * buffer looks binary (NUL byte, excessive control bytes, or invalid UTF-8).
 */
export const decodeTextBuffer = (buffer) => {
  if (buffer.length === 0) return "";

  const sample =
    buffer.length > BINARY_SAMPLE_BYTES
      ? buffer.subarray(0, BINARY_SAMPLE_BYTES)
      : buffer;
  if (sample.includes(0)) return null;

  let controlByteCount = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const byte = sample[i];
    if (byte < 32 && !isAllowedTextControlByte(byte)) {
      controlByteCount += 1;
    }
  }

  if (controlByteCount / sample.length > BINARY_CONTROL_CHAR_RATIO) {
    return null;
  }

  // Also catch NUL bytes beyond the prefix sample via native memchr.
  if (
    buffer.length > BINARY_SAMPLE_BYTES &&
    buffer.includes(0, BINARY_SAMPLE_BYTES)
  ) {
    return null;
  }

  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return null;
  }
};

/**
 * Whether a file's bytes are binary rather than UTF-8 text: a NUL byte, too
 * many control characters, or invalid UTF-8.
 */
export const isLikelyBinaryBuffer = (buffer) =>
  decodeTextBuffer(buffer) === null;

export const normalizePath = (value) => value.replace(/\\/g, "/");

export const resolveProjectPath = (projectRoot, filePath) => {
  const root = path.resolve(projectRoot);
  const fullPath = path.resolve(root, filePath);
  if (fullPath === root) return fullPath;
  if (!fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path is outside of the project root.");
  }
  return fullPath;
};

/**
 * The project folder as the file system names it, with symlinks and Windows
 * short (8.3) names resolved: the spelling git uses for a repository root.
 * Falls back to the resolved path when the folder cannot be read.
 */
export const canonicalProjectRoot = (projectRoot) => {
  const root = path.resolve(projectRoot);
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
};

/**
 * A project file's path relative to the repository root, as git names it.
 * `projectRoot` is the project's `canonicalProjectRoot`.
 */
export const toRepoRelativePath = (repoRoot, projectRoot, filePath) =>
  normalizePath(
    path.relative(repoRoot, resolveProjectPath(projectRoot, filePath)),
  );

export const hashContent = (content) =>
  createHash("sha256").update(content, "utf8").digest("hex");

const readIgnoreFile = async (directory) => {
  try {
    return await fs.readFile(path.join(directory, ".gitignore"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
};

/**
 * Every regular file under the selected directory (the project root by
 * default), as project-relative POSIX paths in depth-first name
 * order. Skips the blocked directories and whatever any `.gitignore` on the
 * way down ignores (each relative to its own directory). Symlinks are not
 * followed, so the walk never leaves the project. `skipDirectory` prunes a
 * directory by its relative path; stops early once `signal` aborts or its
 * caller stops consuming. Subtree walks inherit the root/ancestor ignore
 * scopes without entering unrelated sibling directories.
 *
 * @param {string} projectRoot
 * @param {{ directory?: string, signal?: AbortSignal, skipDirectory?: (relative: string) => boolean }} [options]
 * @returns {AsyncGenerator<string>}
 */
export async function* walkProjectFiles(projectRoot, options = {}) {
  const { directory = ".", signal, skipDirectory } = options;
  if (signal?.aborted) return;
  const { directory: selectedDirectory, realProjectRoot: root } =
    await resolveRealProjectDirectory(projectRoot, directory);
  const subtree = selectedDirectory === "." ? "" : selectedDirectory;

  async function* walk(absoluteDirectory, relativeDirectory, matchers) {
    if (signal?.aborted) return;
    let ignoreText = null;
    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      if (signal?.aborted) return;
      if (
        entries.some(
          (entry) => entry.name === ".gitignore" && !entry.isDirectory(),
        )
      ) {
        ignoreText = await readIgnoreFile(absoluteDirectory);
        if (signal?.aborted) return;
      }
    } catch (error) {
      // A directory removed or unreadable mid-walk is skipped, not fatal.
      if (error?.code === "ENOENT" || error?.code === "EACCES") return;
      throw error;
    }
    const scope = ignoreText
      ? [
          ...matchers,
          { base: relativeDirectory, rules: ignore().add(ignoreText) },
        ]
      : matchers;
    const isIgnored = (relative, isDirectory) =>
      scope.some(({ base, rules }) => {
        const local = base ? relative.slice(base.length + 1) : relative;
        return rules.ignores(isDirectory ? `${local}/` : local);
      });

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (signal?.aborted) return;
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      // Visit only the selected subtree and the ancestors whose ignore
      // scopes it inherits. Ancestor siblings are never traversed.
      if (
        subtree &&
        relative !== subtree &&
        !relative.startsWith(`${subtree}/`) &&
        !subtree.startsWith(`${relative}/`)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        if (
          BLOCKED_DIRECTORIES.has(entry.name.toLowerCase()) ||
          isIgnored(relative, true) ||
          skipDirectory?.(relative)
        ) {
          continue;
        }
        yield* walk(path.join(absoluteDirectory, entry.name), relative, scope);
      } else if (entry.isFile() && !isIgnored(relative, false)) {
        yield relative;
      }
    }
  }

  yield* walk(root, "", []);
}

export const listProjectFiles = async (
  projectRoot,
  directory,
  maxResults,
  signal,
) => {
  const files = [];
  if (maxResults <= 0) return files;
  for await (const file of walkProjectFiles(projectRoot, {
    directory,
    signal,
  })) {
    files.push(file);
    if (files.length >= maxResults) break;
  }
  return files;
};

const resolveRealProjectDirectory = async (projectRoot, directory) => {
  const realProjectRoot = await fs.realpath(projectRoot);
  const targetDirectory = resolveProjectPath(realProjectRoot, directory);
  const relativeDirectory = path.relative(realProjectRoot, targetDirectory);
  let currentPath = realProjectRoot;

  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stats = await fs.lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Directory symlinks cannot be traversed.");
    }
  }

  const stats = await fs.lstat(currentPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }

  const realDirectory = await fs.realpath(currentPath);
  resolveProjectPath(realProjectRoot, realDirectory);

  return {
    directory:
      normalizePath(path.relative(realProjectRoot, realDirectory)) || ".",
    realDirectory,
    realProjectRoot,
  };
};

export const listProjectDirectory = async (projectRoot, directory) => {
  const {
    directory: relativeDirectory,
    realDirectory,
    realProjectRoot,
  } = await resolveRealProjectDirectory(projectRoot, directory);
  const directoryEntries = await fs.readdir(realDirectory, {
    withFileTypes: true,
  });
  const entries = directoryEntries.map((entry) => {
    const absolutePath = path.join(realDirectory, entry.name);
    const relativePath = normalizePath(
      path.relative(realProjectRoot, absolutePath),
    );
    const kind = entry.isDirectory()
      ? "directory"
      : entry.isSymbolicLink()
        ? "symlink"
        : "file";

    return { kind, path: relativePath };
  });

  entries.sort((left, right) => {
    const leftRank = left.kind === "directory" ? 0 : 1;
    const rightRank = right.kind === "directory" ? 0 : 1;
    return leftRank - rightRank || left.path.localeCompare(right.path);
  });

  return { directory: relativeDirectory, entries };
};

export const ensureProjectDirectory = async (projectPath) => {
  const stats = await fs.stat(projectPath);
  if (!stats.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }
};
