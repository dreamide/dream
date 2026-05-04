import { promises as fs } from "node:fs";
import path from "node:path";
import { MIME_TYPES, normalizePath, resolveProjectPath } from "./files.js";

const NEXT_ICON_CANDIDATES = [
  "src/app/favicon.ico",
  "app/favicon.ico",
  "src/app/icon.png",
  "src/app/icon.svg",
  "app/icon.png",
  "app/icon.svg",
  "src/app/apple-icon.png",
  "app/apple-icon.png",
];
const PUBLIC_ICON_CANDIDATES = [
  "public/favicon.ico",
  "public/favicon.svg",
  "public/icon.png",
  "public/icon.svg",
  "public/apple-touch-icon.png",
];
const ROOT_ICON_CANDIDATES = ["favicon.ico", "icon.png", "icon.svg"];
const WORKSPACE_DIRECTORY_NAMES = new Set(["apps", "packages"]);

const readJsonFile = async (absolutePath) => {
  try {
    return JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch {
    return null;
  }
};

const hasNextDependency = async (projectRoot) => {
  const packageJson = await readJsonFile(
    path.join(projectRoot, "package.json"),
  );
  if (!packageJson || typeof packageJson !== "object") {
    return false;
  }

  return Boolean(
    packageJson.dependencies?.next || packageJson.devDependencies?.next,
  );
};

const uniquePaths = (paths) => Array.from(new Set(paths.filter(Boolean)));

const getHtmlAttribute = (tag, attributeName) => {
  const pattern = new RegExp(
    `${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = tag.match(pattern);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
};

const resolveIconHrefCandidates = (href) => {
  const cleanHref = href.split(/[?#]/)[0]?.trim();
  if (
    !cleanHref ||
    cleanHref.startsWith("data:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(cleanHref)
  ) {
    return [];
  }

  const withoutLeadingDot = cleanHref.replace(/^\.\//, "");
  const withoutLeadingSlash = withoutLeadingDot.replace(/^\/+/, "");
  if (!withoutLeadingSlash) {
    return [];
  }

  return uniquePaths([
    withoutLeadingSlash,
    `public/${withoutLeadingSlash}`,
  ]).map(normalizePath);
};

const readIndexHtmlIconCandidates = async (projectRoot) => {
  let html = "";
  try {
    html = await fs.readFile(path.join(projectRoot, "index.html"), "utf8");
  } catch {
    return [];
  }

  const candidates = [];
  const linkPattern = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    const rel = getHtmlAttribute(tag, "rel").toLowerCase();
    if (!rel.split(/\s+/).includes("icon")) {
      continue;
    }

    candidates.push(
      ...resolveIconHrefCandidates(getHtmlAttribute(tag, "href")),
    );
  }

  return uniquePaths(candidates);
};

const findProjectIconCandidate = async (projectRoot, relativePath, source) => {
  const normalizedRelativePath = normalizePath(relativePath);
  const ext = path.extname(normalizedRelativePath).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType?.startsWith("image/")) {
    return null;
  }

  try {
    const absolutePath = resolveProjectPath(
      projectRoot,
      normalizedRelativePath,
    );
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return null;
    }

    return {
      path: normalizedRelativePath,
      mimeType,
      source,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
};

const detectIconAtProjectRoot = async (projectRoot) => {
  const isNextProject = await hasNextDependency(projectRoot);
  const htmlCandidates = await readIndexHtmlIconCandidates(projectRoot);
  const candidateGroups = isNextProject
    ? [
        ["next", NEXT_ICON_CANDIDATES],
        ["public", PUBLIC_ICON_CANDIDATES],
        ["root", ROOT_ICON_CANDIDATES],
        ["index-html", htmlCandidates],
      ]
    : [
        ["index-html", htmlCandidates],
        ["public", PUBLIC_ICON_CANDIDATES],
        ["root", ROOT_ICON_CANDIDATES],
        ["next", NEXT_ICON_CANDIDATES],
      ];

  for (const [source, candidates] of candidateGroups) {
    for (const candidate of candidates) {
      const icon = await findProjectIconCandidate(
        projectRoot,
        candidate,
        source,
      );
      if (icon) {
        return icon;
      }
    }
  }

  return null;
};

const getWorkspacePackagePatterns = async (projectRoot) => {
  const packageJson = await readJsonFile(
    path.join(projectRoot, "package.json"),
  );
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry) => typeof entry === "string");
  }
  if (Array.isArray(workspaces?.packages)) {
    return workspaces.packages.filter((entry) => typeof entry === "string");
  }
  return [];
};

const listWorkspaceRoots = async (projectRoot) => {
  const roots = [];
  const seen = new Set();
  const patterns = await getWorkspacePackagePatterns(projectRoot);
  for (const parentName of WORKSPACE_DIRECTORY_NAMES) {
    patterns.push(`${parentName}/*`);
  }

  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      continue;
    }

    const parent = pattern.slice(0, -2);
    let entries = [];
    try {
      entries = await fs.readdir(resolveProjectPath(projectRoot, parent), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const relativePath = normalizePath(path.join(parent, entry.name));
      if (seen.has(relativePath)) {
        continue;
      }

      seen.add(relativePath);
      roots.push({
        absolutePath: resolveProjectPath(projectRoot, relativePath),
        relativePath,
      });
    }
  }

  return roots.slice(0, 20);
};

export const detectProjectIcon = async (projectPath) => {
  const projectRoot = path.resolve(projectPath);
  const rootIcon = await detectIconAtProjectRoot(projectRoot);
  if (rootIcon) {
    return rootIcon;
  }

  for (const workspaceRoot of await listWorkspaceRoots(projectRoot)) {
    const workspaceIcon = await detectIconAtProjectRoot(
      workspaceRoot.absolutePath,
    );
    if (!workspaceIcon) {
      continue;
    }

    return {
      ...workspaceIcon,
      path: normalizePath(
        path.join(workspaceRoot.relativePath, workspaceIcon.path),
      ),
      source: `workspace:${workspaceRoot.relativePath}:${workspaceIcon.source}`,
    };
  }

  return null;
};
