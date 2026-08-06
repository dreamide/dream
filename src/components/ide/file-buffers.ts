export interface FileBuffer {
  diskContent: string;
  draftContent: string;
  status: "clean" | "dirty" | "saving" | "conflict";
  error: string | null;
}

export type FileBuffersState = Record<string, FileBuffer>;
export type FileLineEnding = "crlf" | "lf";

export const normalizeFileContentForEditor = (
  content: string,
  lineEnding: FileLineEnding,
) => (lineEnding === "crlf" ? content.replace(/\r\n/g, "\n") : content);

export const serializeEditorContent = (
  content: string,
  lineEnding: FileLineEnding,
) => (lineEnding === "crlf" ? content.replace(/\r?\n/g, "\r\n") : content);

export type FileBufferAction =
  | { type: "load"; key: string; content: string }
  | { type: "edit"; key: string; content: string }
  | { type: "save-start"; key: string }
  | { type: "save-success"; key: string; content: string }
  | { type: "save-failure"; key: string; error: string }
  | { type: "save-conflict"; key: string; error: string }
  | { type: "discard"; key: string }
  | { type: "invalidate"; key: string }
  | { type: "refresh-project"; projectId: string };

const FILE_BUFFER_KEY_SEPARATOR = "\0";

export const getFileBufferKey = (projectId: string, filePath: string) =>
  `${projectId}${FILE_BUFFER_KEY_SEPARATOR}${filePath}`;

const isProjectBufferKey = (key: string, projectId: string) =>
  key.startsWith(`${projectId}${FILE_BUFFER_KEY_SEPARATOR}`);

export const fileBuffersReducer = (
  state: FileBuffersState,
  action: FileBufferAction,
): FileBuffersState => {
  switch (action.type) {
    case "load": {
      if (state[action.key]) {
        return state;
      }

      return {
        ...state,
        [action.key]: {
          diskContent: action.content,
          draftContent: action.content,
          status: "clean",
          error: null,
        },
      };
    }
    case "edit": {
      const buffer = state[action.key];
      if (!buffer || buffer.status === "saving") {
        return state;
      }

      return {
        ...state,
        [action.key]: {
          ...buffer,
          draftContent: action.content,
          status:
            buffer.status === "conflict"
              ? "conflict"
              : action.content === buffer.diskContent
                ? "clean"
                : "dirty",
          error: buffer.status === "conflict" ? buffer.error : null,
        },
      };
    }
    case "save-start": {
      const buffer = state[action.key];
      if (!buffer || buffer.status === "clean" || buffer.status === "saving") {
        return state;
      }

      return {
        ...state,
        [action.key]: { ...buffer, status: "saving", error: null },
      };
    }
    case "save-success":
      if (!state[action.key]) {
        return state;
      }

      return {
        ...state,
        [action.key]: {
          diskContent: action.content,
          draftContent: action.content,
          status: "clean",
          error: null,
        },
      };
    case "save-failure": {
      const buffer = state[action.key];
      if (!buffer) {
        return state;
      }

      return {
        ...state,
        [action.key]: {
          ...buffer,
          status:
            buffer.draftContent === buffer.diskContent ? "clean" : "dirty",
          error: action.error,
        },
      };
    }
    case "save-conflict": {
      const buffer = state[action.key];
      if (!buffer) {
        return state;
      }

      return {
        ...state,
        [action.key]: {
          ...buffer,
          status: "conflict",
          error: action.error,
        },
      };
    }
    case "discard": {
      const buffer = state[action.key];
      if (!buffer) {
        return state;
      }

      return {
        ...state,
        [action.key]: {
          ...buffer,
          draftContent: buffer.diskContent,
          status: "clean",
          error: null,
        },
      };
    }
    case "invalidate": {
      if (!state[action.key]) {
        return state;
      }

      const next = { ...state };
      delete next[action.key];
      return next;
    }
    case "refresh-project": {
      let changed = false;
      const next: FileBuffersState = {};

      for (const [key, buffer] of Object.entries(state)) {
        if (
          isProjectBufferKey(key, action.projectId) &&
          buffer.status === "clean"
        ) {
          changed = true;
          continue;
        }
        next[key] = buffer;
      }

      return changed ? next : state;
    }
  }
};
