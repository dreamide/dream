import { type ReactNode, useEffect, useState } from "react";
import type { ProjectIconInfo } from "@/types/ide";

export const areProjectIconsEqual = (
  left: ProjectIconInfo | null,
  right: ProjectIconInfo | null,
) =>
  left?.path === right?.path &&
  left?.mimeType === right?.mimeType &&
  left?.source === right?.source &&
  left?.mtimeMs === right?.mtimeMs;

const getProjectIconUrl = (projectPath: string, iconPath: string) =>
  `/api/project-file-raw?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(iconPath)}`;

export const normalizeProjectIconResponse = (
  value: unknown,
): ProjectIconInfo | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const icon = value as Partial<ProjectIconInfo>;
  const iconPath = typeof icon.path === "string" ? icon.path.trim() : "";
  if (!iconPath) {
    return null;
  }

  return {
    mimeType:
      typeof icon.mimeType === "string" && icon.mimeType.trim()
        ? icon.mimeType.trim()
        : "application/octet-stream",
    mtimeMs: typeof icon.mtimeMs === "number" ? icon.mtimeMs : 0,
    path: iconPath,
    source:
      typeof icon.source === "string" && icon.source.trim()
        ? icon.source.trim()
        : "unknown",
  };
};

export const ProjectTabIcon = ({
  fallback = null,
  icon,
  projectName,
  projectPath,
}: {
  fallback?: ReactNode;
  icon: ProjectIconInfo | null;
  projectName: string;
  projectPath: string;
}) => {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setFailed(false);
    setSrc(null);

    if (!icon) {
      return;
    }

    const abortController = new AbortController();
    let objectUrl: string | null = null;

    void fetch(getProjectIconUrl(projectPath, icon.path), {
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load project icon: ${response.status}`);
        }

        return response.blob();
      })
      .then((blob) => {
        if (abortController.signal.aborted) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((error: unknown) => {
        if (
          !abortController.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setFailed(true);
        }
      });

    return () => {
      abortController.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [icon, projectPath]);

  if (!icon || failed || !src) {
    return fallback;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0 rounded-sm object-contain"
      draggable={false}
      onError={() => setFailed(true)}
      src={src}
      title={projectName}
    />
  );
};
