import type { ComponentProps, MouseEvent } from "react";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useIdeStore } from "../ide-store";
import { MaterialFileIcon } from "../material-file-icon";

type MarkdownFileLinkProps = ComponentProps<"a"> & {
  node?: unknown;
  projectPath: string;
};

const PROJECT_FILE_LINK_PREFIX = "/__dream_project_file__/";

const stripLineSuffix = (value: string) =>
  value.replace(/:(\d+)(?::\d+)?$/, "");

const getLineSuffix = (value: string) =>
  value.match(/:(\d+)(?::\d+)?$/)?.[0] ?? "";

const normalizePath = (value: string) => value.replace(/\\/g, "/");

const normalizeFilePathCandidate = (value: string) =>
  normalizePath(decodePath(value)).replace(/^\/([a-z]:\/)/i, "$1");

const hasWindowsDrive = (value: string) => /^[a-z]:[/]/i.test(value);

const toComparablePath = (value: string) =>
  hasWindowsDrive(value) ? value.toLowerCase() : value;

const decodePath = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const getProjectFilePathFromHref = (
  href: string | undefined,
  projectPath: string,
) => {
  const rawHref = href?.trim();
  const normalizedProjectPath = normalizePath(projectPath.trim()).replace(
    /\/+$/,
    "",
  );
  if (!rawHref || !normalizedProjectPath) {
    return null;
  }

  const withoutFragment = rawHref.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  const withoutFileScheme = withoutFragment.startsWith("file://")
    ? withoutFragment.slice("file://".length)
    : withoutFragment;
  const candidatePath = stripLineSuffix(
    normalizeFilePathCandidate(withoutFileScheme),
  );

  if (candidatePath.startsWith(PROJECT_FILE_LINK_PREFIX)) {
    return candidatePath.slice(PROJECT_FILE_LINK_PREFIX.length);
  }

  // Windows paths are case-insensitive and drive letters commonly differ in
  // case between the stored project path and model output (e:/ vs E:/).
  const comparableCandidatePath = toComparablePath(candidatePath);
  const comparableProjectPath = toComparablePath(normalizedProjectPath);

  if (comparableCandidatePath === comparableProjectPath) {
    return null;
  }

  if (comparableCandidatePath.startsWith(`${comparableProjectPath}/`)) {
    return candidatePath.slice(normalizedProjectPath.length + 1);
  }

  if (
    !candidatePath.startsWith("/") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(candidatePath)
  ) {
    return candidatePath.replace(/^\.?\//, "");
  }

  return null;
};

const EXTERNAL_FILE_LINK_PREFIX = "/__dream_external_file__/";

const stripUrlExtras = (value: string) => {
  const withoutFragment = value.split("#", 1)[0]?.split("?", 1)[0] ?? "";
  return withoutFragment.startsWith("file://")
    ? withoutFragment.slice("file://".length)
    : withoutFragment;
};

// Absolute file paths that fall outside the active project can't open in the
// editor, so they are handed to the OS shell instead. Only POSIX-style absolute
// paths are considered external when the project itself is POSIX-style; on
// Windows a leading "/" is far more likely to be a project-relative path.
export const getExternalFilePathFromHref = (
  href: string | undefined,
  projectPath: string,
) => {
  const rawHref = href?.trim();
  if (!rawHref || getProjectFilePathFromHref(rawHref, projectPath)) {
    return null;
  }

  const candidatePath = stripLineSuffix(
    normalizeFilePathCandidate(stripUrlExtras(rawHref)),
  );

  if (candidatePath.startsWith(EXTERNAL_FILE_LINK_PREFIX)) {
    const encodedPath = candidatePath.slice(EXTERNAL_FILE_LINK_PREFIX.length);
    return hasWindowsDrive(encodedPath) ? encodedPath : `/${encodedPath}`;
  }

  if (candidatePath.startsWith(PROJECT_FILE_LINK_PREFIX)) {
    return null;
  }

  if (hasWindowsDrive(candidatePath)) {
    return candidatePath;
  }

  const projectIsPosix = !hasWindowsDrive(normalizePath(projectPath.trim()));
  if (projectIsPosix && candidatePath.startsWith("/")) {
    return candidatePath;
  }

  return null;
};

const unwrapMarkdownLinkDestination = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
};

const escapeMarkdownLinkDestination = (value: string) =>
  value.replace(/</g, "%3C").replace(/>/g, "%3E");

const MARKDOWN_LINK_CLASS_NAME =
  "font-medium text-current underline decoration-current/45 underline-offset-3 transition-colors hover:decoration-current";

export const normalizeProjectFileLinksInMarkdown = (
  value: string,
  projectPath: string,
) =>
  value.replace(
    // Raw destinations may contain balanced parentheses (e.g. Next.js route
    // groups like `app/(main)/page.tsx`), so allow one nesting level.
    /\[([^\]\n]+)\]\((<[^>\n]*>|(?:[^()\n]|\([^()\n]*\))+)\)/g,
    (match, label, href) => {
      const unwrappedHref = unwrapMarkdownLinkDestination(href);
      const projectFilePath = getProjectFilePathFromHref(
        unwrappedHref,
        projectPath,
      );

      const externalFilePath = projectFilePath
        ? null
        : getExternalFilePathFromHref(unwrappedHref, projectPath);

      if (!projectFilePath && !externalFilePath) {
        return match;
      }

      const lineSuffix = getLineSuffix(
        normalizeFilePathCandidate(stripUrlExtras(unwrappedHref)),
      );
      const destination = projectFilePath
        ? `${PROJECT_FILE_LINK_PREFIX}${projectFilePath}`
        : `${EXTERNAL_FILE_LINK_PREFIX}${(externalFilePath ?? "").replace(/^\//, "")}`;
      return `[${label}](<${escapeMarkdownLinkDestination(
        destination,
      )}${lineSuffix}>)`;
    },
  );

export const MarkdownFileLink = ({
  className,
  href,
  node: _node,
  onClick,
  projectPath,
  ...props
}: MarkdownFileLinkProps) => {
  const openProjectFile = useIdeStore((state) => state.openProjectFile);
  const openExternalPath = useIdeStore((state) => state.openExternalPath);
  const projectId = useIdeStore((state) => state.activeProjectId);
  const projectFilePath = useMemo(
    () => getProjectFilePathFromHref(href, projectPath),
    [href, projectPath],
  );
  const externalFilePath = useMemo(
    () =>
      projectFilePath ? null : getExternalFilePathFromHref(href, projectPath),
    [href, projectFilePath, projectPath],
  );
  const filePath = projectFilePath ?? externalFilePath;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!filePath) {
      onClick?.(event);
      return;
    }

    if (event.button === 0) {
      event.preventDefault();
      event.stopPropagation();

      if (projectFilePath) {
        if (projectId) {
          openProjectFile(projectId, projectFilePath);
        }
        return;
      }

      openExternalPath(filePath);
    }
  };

  if (filePath) {
    return (
      <a
        {...props}
        className={cn(
          className,
          "inline-flex max-w-full items-baseline gap-1 align-baseline",
          MARKDOWN_LINK_CLASS_NAME,
        )}
        href={href}
        onClick={handleClick}
        title={externalFilePath ?? props.title}
      >
        <MaterialFileIcon
          className="relative top-0.5 size-3.5 shrink-0"
          path={filePath}
        />
        <span className="min-w-0 truncate">{props.children}</span>
      </a>
    );
  }

  return (
    <a
      {...props}
      className={cn(className, MARKDOWN_LINK_CLASS_NAME)}
      href={href}
      onClick={handleClick}
      rel="noreferrer"
      target="_blank"
    />
  );
};
