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
import {
  ensureActiveChatForProject,
  ensureActiveProject,
  normalizeProjectPathKey,
  sanitizeProjectUiForChats,
} from "../../../electron/shared/persisted-state-codec.js";

// The shape of persisted state, its defaults and the project/chat invariants
// are owned by the shared codec; the store reaches them through here.
export {
  ensureActiveChatForProject,
  ensureActiveProject,
  normalizeProjectPathKey,
  sanitizeProjectUiForChats,
};

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

export const areProjectListsEqualExceptLastUsedAt = (
  previous: ProjectConfig[],
  next: ProjectConfig[],
) =>
  previous === next ||
  (previous.length === next.length &&
    previous.every(
      (project, index) =>
        next[index] !== undefined &&
        areProjectsEqualExceptLastUsedAt(project, next[index]),
    ));

export const getChatsForProject = (chats: ChatConfig[], projectId: string) =>
  chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );

export const renderUserMessageText = (message: UIMessage): string => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const sections: string[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.trim();
      if (text) {
        sections.push(text);
      }
      continue;
    }

    if (part.type === "file") {
      const label =
        (typeof part.filename === "string" && part.filename.trim()) ||
        (typeof part.mediaType === "string" && part.mediaType.trim()) ||
        "attachment";
      sections.push(`[Attached file: ${label}]`);
    }
  }

  return sections.join("\n\n");
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
