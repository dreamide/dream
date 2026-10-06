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

export const getChatsForProject = (chats: ChatConfig[], projectId: string) =>
  chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );

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
