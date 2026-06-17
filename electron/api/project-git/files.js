import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
  ".git",
  ".claude",
  ".cursor",
  ".expo",
  ".idea",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".nx",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".turbo",
  ".vscode",
  ".zed",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

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

const walkFiles = async (root, current, maxResults, output) => {
  if (output.length >= maxResults) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= maxResults) return;
    if (entry.isDirectory() && BLOCKED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      await walkFiles(root, absolute, maxResults, output);
      continue;
    }
    output.push(relative);
  }
};

export const listProjectFiles = async (projectRoot, directory, maxResults) => {
  const targetDirectory = resolveProjectPath(projectRoot, directory);
  const stats = await fs.stat(targetDirectory);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }
  const files = [];
  await walkFiles(projectRoot, targetDirectory, maxResults, files);
  return files;
};

export const ensureProjectDirectory = async (projectPath) => {
  const stats = await fs.stat(projectPath);
  if (!stats.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }
};
