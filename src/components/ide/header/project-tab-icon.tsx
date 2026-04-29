import { useState } from "react";
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
  icon,
  projectName,
  projectPath,
}: {
  icon: ProjectIconInfo | null;
  projectName: string;
  projectPath: string;
}) => {
  const [failed, setFailed] = useState(false);

  if (!icon || failed) {
    return null;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0 rounded-sm object-contain"
      draggable={false}
      onError={() => setFailed(true)}
      src={getProjectIconUrl(projectPath, icon.path)}
      title={projectName}
    />
  );
};
