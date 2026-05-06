import type { ComponentProps, MouseEvent } from "react";
import { useMemo } from "react";
import { useIdeStore } from "../ide-store";

type MarkdownFileLinkProps = ComponentProps<"a"> & {
  node?: unknown;
  projectPath: string;
};

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

const toSafeRelativeMarkdownDestination = (value: string) =>
  value.startsWith("/") || value.startsWith("./") || value.startsWith("../")
    ? value
    : `./${value}`;

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
      toSafeRelativeMarkdownDestination(projectFilePath),
    )}${lineSuffix}>)`;
  });

export const MarkdownFileLink = ({
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
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      !projectId ||
      !projectFilePath
    ) {
      return;
    }

    event.preventDefault();
    openProjectFile(projectId, projectFilePath);
  };

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      rel={projectFilePath ? undefined : "noreferrer"}
      target={projectFilePath ? undefined : "_blank"}
    />
  );
};
