import type {
  DynamicToolUIPart,
  FileUIPart,
  ReasoningUIPart,
  SourceDocumentUIPart,
  SourceUrlUIPart,
  TextUIPart,
  ToolUIPart,
  UIMessage,
} from "ai";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { normalizeProjectPathKey } from "../../../electron/shared/persisted-state-codec.js";

// Project paths compare through the shared codec's key, the same one the
// main process dedupes projects with. The project/chat invariants are the
// workspace document's (store/workspace-document.ts).
export { normalizeProjectPathKey };

export const areProjectsEqualExceptLastUsedAt = (
  previous: ProjectConfig,
  next: ProjectConfig,
) => {
  if (previous === next) {
    return true;
  }

  const previousKeys = Object.keys(previous).filter(
    (key) => key !== "lastUsedAt",
  ) as Array<keyof ProjectConfig>;
  const nextKeys = Object.keys(next).filter(
    (key) => key !== "lastUsedAt",
  ) as Array<keyof ProjectConfig>;

  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key) => previous[key] === next[key])
  );
};

/**
 * The project at `path`. The same path can be a project on two hosts; the
 * active project wins, then the first in `projects`.
 */
export const findProjectForPath = <T extends ProjectConfig>(
  projects: readonly T[],
  activeProjectId: string | null,
  path: string,
): T | null => {
  const key = normalizeProjectPathKey(path);
  const matches = projects.filter(
    (project) => normalizeProjectPathKey(project.path) === key,
  );
  return (
    matches.find((project) => project.id === activeProjectId) ??
    matches[0] ??
    null
  );
};

export const getChatsForProject = (chats: ChatConfig[], projectId: string) =>
  chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );

export const byPinnedThenRecent = (left: ChatConfig, right: ChatConfig) => {
  const pinnedOrder = Number(right.pinned) - Number(left.pinned);
  if (pinnedOrder !== 0) return pinnedOrder;
  const leftUpdated = Date.parse(left.updatedAt || left.createdAt);
  const rightUpdated = Date.parse(right.updatedAt || right.createdAt);
  if (Number.isNaN(leftUpdated) || Number.isNaN(rightUpdated)) {
    return right.title.localeCompare(left.title);
  }
  return rightUpdated - leftUpdated;
};

export const stringifyPart = (
  value:
    | UIMessage
    | TextUIPart
    | ReasoningUIPart
    | ToolUIPart
    | DynamicToolUIPart
    | FileUIPart
    | SourceUrlUIPart
    | SourceDocumentUIPart
    | unknown,
) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
