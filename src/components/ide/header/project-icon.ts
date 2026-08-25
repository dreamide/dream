import type { ProjectIconInfo } from "@/types/ide";

export const areProjectIconsEqual = (
  left: ProjectIconInfo | null,
  right: ProjectIconInfo | null,
) =>
  left?.path === right?.path &&
  left?.mimeType === right?.mimeType &&
  left?.source === right?.source &&
  left?.mtimeMs === right?.mtimeMs;

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
