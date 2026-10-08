import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
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

/**
 * Whether a file's bytes are binary rather than UTF-8 text: a NUL byte, too
 * many control characters, or invalid UTF-8.
 */
export const isLikelyBinaryBuffer = (buffer) => {
  if (buffer.length === 0) return false;

  let controlByteCount = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 32 && !isAllowedTextControlByte(byte)) {
      controlByteCount += 1;
    }
  }

  if (controlByteCount / buffer.length > BINARY_CONTROL_CHAR_RATIO) {
    return true;
  }

  try {
    utf8Decoder.decode(buffer);
    return false;
  } catch {
    return true;
  }
};

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

export const hashContent = (content) =>
  createHash("sha256").update(content, "utf8").digest("hex");

const loadProjectIgnore = async (root) => {
  const projectIgnore = ignore();

  try {
    projectIgnore.add(await fs.readFile(path.join(root, ".gitignore"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return projectIgnore;
};

const walkFiles = async (root, current, maxResults, output, projectIgnore) => {
  if (output.length >= maxResults) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= maxResults) return;
    if (
      entry.isDirectory() &&
      BLOCKED_DIRECTORIES.has(entry.name.toLowerCase())
    ) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      if (projectIgnore.ignores(`${relative}/`)) {
        continue;
      }
      await walkFiles(root, absolute, maxResults, output, projectIgnore);
      continue;
    }
    if (projectIgnore.ignores(relative)) {
      continue;
    }
    output.push(relative);
  }
};

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
 * Every file under the project root, as root-relative POSIX paths in name
 * order. Skips the blocked directories and whatever any `.gitignore` on the
 * way down ignores (each relative to its own directory). Symlinks are not
 * followed, so the walk never leaves the project. `skipDirectory` prunes a
 * directory by its relative path; stops early once `signal` aborts.
 *
 * @param {string} projectRoot
 * @param {{ signal?: AbortSignal, skipDirectory?: (relative: string) => boolean }} [options]
 * @returns {AsyncGenerator<string>}
 */
export async function* walkProjectFiles(projectRoot, options = {}) {
  const { signal, skipDirectory } = options;
  const root = path.resolve(projectRoot);

  async function* walk(absoluteDirectory, relativeDirectory, matchers) {
    if (signal?.aborted) return;
    const ignoreText = await readIgnoreFile(absoluteDirectory);
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

    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      // A directory removed or unreadable mid-walk is skipped, not fatal.
      if (error?.code === "ENOENT" || error?.code === "EACCES") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (signal?.aborted) return;
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
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

export const listProjectFiles = async (projectRoot, directory, maxResults) => {
  const targetDirectory = resolveProjectPath(projectRoot, directory);
  const stats = await fs.stat(targetDirectory);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }

  const projectIgnore = await loadProjectIgnore(path.resolve(projectRoot));
  const files = [];
  await walkFiles(
    path.resolve(projectRoot),
    targetDirectory,
    maxResults,
    files,
    projectIgnore,
  );
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
