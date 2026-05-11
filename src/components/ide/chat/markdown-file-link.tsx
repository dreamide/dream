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

  if (candidatePath === normalizedProjectPath) {
    return null;
  }

  if (candidatePath.startsWith(`${normalizedProjectPath}/`)) {
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

const unwrapMarkdownLinkDestination = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
};

const escapeMarkdownLinkDestination = (value: string) =>
  value.replace(/>/g, "%3E");

export const normalizeProjectFileLinksInMarkdown = (
  value: string,
  projectPath: string,
) =>
  value.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (match, label, href) => {
    const unwrappedHref = unwrapMarkdownLinkDestination(href);
    const projectFilePath = getProjectFilePathFromHref(
      unwrappedHref,
      projectPath,
    );

    if (!projectFilePath) {
      return match;
    }

    const lineSuffix = getLineSuffix(
      normalizeFilePathCandidate(unwrappedHref.split("#", 1)[0] ?? ""),
    );
    return `[${label}](<${escapeMarkdownLinkDestination(
      `${PROJECT_FILE_LINK_PREFIX}${projectFilePath}`,
    )}${lineSuffix}>)`;
  });

export const MarkdownFileLink = ({
  className,
  href,
  node: _node,
  onClick,
  projectPath,
  ...props
}: MarkdownFileLinkProps) => {
  const openProjectFile = useIdeStore((state) => state.openProjectFile);
  const projectId = useIdeStore((state) => state.activeProjectId);
  const projectFilePath = useMemo(
    () => getProjectFilePathFromHref(href, projectPath),
    [href, projectPath],
  );

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!projectFilePath) {
      onClick?.(event);
      return;
    }

    if (event.button === 0) {
      event.preventDefault();
      event.stopPropagation();

      if (projectId) {
        openProjectFile(projectId, projectFilePath);
      }
    }
  };

  if (projectFilePath) {
    return (
      <a
        {...props}
        className={cn(
          "inline-flex max-w-full items-baseline gap-1 align-baseline font-medium text-info-foreground no-underline transition-colors hover:text-blue-500 dark:text-info-foreground dark:hover:text-blue-200",
          className,
        )}
        href={href}
        onClick={handleClick}
      >
        <MaterialFileIcon
          className="relative top-0.5 size-3.5 shrink-0"
          path={projectFilePath}
        />
        <span className="min-w-0 truncate">{props.children}</span>
      </a>
    );
  }

  return (
    <a
      {...props}
      className={cn(
        "font-medium text-primary underline decoration-primary-border underline-offset-3 transition-colors hover:decoration-primary",
        className,
      )}
      href={href}
      onClick={handleClick}
      rel="noreferrer"
      target="_blank"
    />
  );
};
