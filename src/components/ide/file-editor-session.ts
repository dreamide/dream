/**
 * The Files panel's open files, one session per project, outside React.
 *
 * A session owns a project's file tabs, the buffer of each open text file
 * (what is on disk and the unsaved draft), how each was read, and a pending
 * reveal for the editor. It reads a file when its tab is showing, writes it
 * on save, forgets it when its tab closes, and keeps unsaved drafts through
 * a refresh. Panels are views: they render a session's snapshot and call its
 * actions, so a panel that remounts (its host went away and came back)
 * finds its drafts where it left them.
 *
 * This module knows nothing of the store. The store creates the sessions,
 * opens files through `openProjectFile` (which resolves the path and calls
 * the project's session), and tells the sessions when a project's files
 * changed on disk (`refresh`) or when a project stopped being open (`drop`).
 * Errors are kept as thrown, for the panel to put into words.
 */
import { type ApiClient, ApiError } from "@/lib/api-client";
import type { ProjectScope } from "@/lib/project-resource-cache";
import {
  type FileBufferAction,
  type FileBuffersState,
  type FileLineEnding,
  fileBuffersReducer,
  isBufferDirty,
} from "./file-buffers";
import {
  EMPTY_FILE_TABS,
  type FileTab,
  type FileTabsAction,
  type FileTabsState,
  fileTabsReducer,
} from "./file-tabs";
import type { ProjectFilePosition } from "./store/ide-store-types";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

/** Images show as a picture, never as text in an editor. */
export const isImageFile = (filePath: string): boolean => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
};

/** Too large or binary: shown as a notice rather than an error. */
const isPreviewUnavailable = (error: unknown) =>
  error instanceof ApiError && (error.status === 413 || error.status === 415);

/** How an open file was read. */
export interface FileMetadata {
  lineEnding: FileLineEnding;
  readOnlyReason: string | null;
  writable: boolean;
}

/** An open text file's read: under way, done, or why it could not be. */
export interface OpenFileRead {
  status: "loading" | "ready" | "unavailable" | "failed";
  metadata: FileMetadata | null;
  /** The read's failure: a notice when unavailable, an error when failed. */
  error: unknown;
}

/** A position for the editor of one open file to select and scroll to. */
export interface FileReveal extends ProjectFilePosition {
  path: string;
  /** Also move keyboard focus into the editor. */
  focus: boolean;
  /** A new id reveals the same position again. */
  requestId: number;
}

export interface FileEditorSnapshot {
  activePath: string | null;
  tabs: readonly FileTab[];
  /** Keyed by path: disk content, the draft, and whether it is saving. */
  buffers: FileBuffersState;
  /** Keyed by path: each open text file's read. */
  reads: Readonly<Record<string, OpenFileRead>>;
  reveal: FileReveal | null;
}

export interface OpenFileOptions {
  /** A tab of its own, rather than the preview tab the next open replaces. */
  pin?: boolean;
  position?: ProjectFilePosition;
  /** With a position: move keyboard focus into the editor too. */
  focus?: boolean;
}

export interface FileEditorSession {
  getSnapshot(): FileEditorSnapshot;
  subscribe(listener: () => void): () => void;
  /** Shows a file (opening its tab if needed), optionally at a position. */
  open(path: string, options?: OpenFileOptions): void;
  /** Shows a file whose tab is already open. */
  activate(path: string): void;
  reorder(fromIndex: number, toIndex: number): void;
  /** Replaces a file's draft. A preview tab with unsaved changes is pinned. */
  edit(path: string, content: string): void;
  /**
   * Closes a tab and forgets the file, so reopening it reads disk. A file
   * with unsaved changes stays open and the answer is "confirm": the caller
   * asks, then calls `saveAndClose` or `discardAndClose`.
   */
  close(path: string): "closed" | "confirm";
  discardAndClose(path: string): void;
  /** Writes a dirty, writable file's draft. True only when it reached disk. */
  save(path: string): Promise<boolean>;
  /** Saves, then closes; on failure the tab stays and shows the error. */
  saveAndClose(path: string): Promise<boolean>;
  /** Drops the file's draft and reads it from disk again. */
  reload(path: string): void;
  /** The file is no longer on disk: its tab closes. */
  forgetMissing(path: string): void;
}

export interface FileEditorSessionDependencies {
  api: Pick<ApiClient, "readProjectFile" | "writeProjectFile">;
  /**
   * The project's folder on its Host (`projectScope`), or null when it is
   * no longer open. Reads and writes go to that Host, even when another
   * Project has the same path on another Host.
   */
  getProjectScope: (projectId: string) => ProjectScope | null;
  /** A file was written: the project's git state changed. */
  onSaved?: (projectId: string) => void;
}

export interface FileEditorSessions {
  /** The project's session, created on first use. */
  session(projectId: string): FileEditorSession;
  /**
   * The project's files changed on disk: files without unsaved changes are
   * read again when shown; drafts stay.
   */
  refresh(projectId: string): void;
  /** The project is no longer open: its session and drafts go. */
  drop(projectId: string): void;
}

export const EMPTY_FILE_EDITOR_SNAPSHOT: FileEditorSnapshot = {
  activePath: null,
  buffers: {},
  reads: {},
  reveal: null,
  tabs: [],
};

const omit = <T>(record: Readonly<Record<string, T>>, key: string) => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

const createSession = (
  projectId: string,
  deps: FileEditorSessionDependencies,
): FileEditorSession & { refresh(): void } => {
  let tabState: FileTabsState = EMPTY_FILE_TABS;
  let buffers: FileBuffersState = {};
  let reads: Readonly<Record<string, OpenFileRead>> = {};
  let reveal: FileReveal | null = null;
  let revealCount = 0;
  let snapshot = EMPTY_FILE_EDITOR_SNAPSHOT;
  const listeners = new Set<() => void>();
  // The read under way for each path; a result for any other is stale.
  const pendingReads = new Map<string, symbol>();

  const emit = () => {
    snapshot = {
      activePath: tabState.activePath,
      buffers,
      reads,
      reveal,
      tabs: tabState.tabs,
    };
    for (const listener of listeners) listener();
  };

  const reduceBuffers = (action: FileBufferAction) => {
    buffers = fileBuffersReducer(buffers, action);
  };

  const setRead = (path: string, read: OpenFileRead) => {
    reads = { ...reads, [path]: read };
  };

  /** Drops what is held for a file; a read under way for it is ignored. */
  const forget = (path: string) => {
    pendingReads.delete(path);
    reduceBuffers({ type: "invalidate", key: path });
    reads = omit(reads, path);
  };

  const read = (path: string) => {
    const scope = deps.getProjectScope(projectId);
    if (!scope) return;
    const token = Symbol(path);
    pendingReads.set(path, token);
    setRead(path, { error: null, metadata: null, status: "loading" });

    const settle = (apply: () => void) => {
      if (pendingReads.get(path) !== token) return;
      pendingReads.delete(path);
      apply();
      emit();
    };
    deps.api
      .readProjectFile(
        { filePath: path, projectPath: scope.projectPath },
        { hostId: scope.hostId },
      )
      .then(
        (payload) =>
          settle(() => {
            reduceBuffers({
              type: "load",
              key: path,
              content: payload.content,
            });
            setRead(path, {
              error: null,
              metadata: {
                lineEnding: payload.lineEnding,
                readOnlyReason: payload.readOnlyReason,
                writable: payload.writable,
              },
              status: "ready",
            });
          }),
        (error: unknown) =>
          settle(() =>
            setRead(path, {
              error,
              metadata: null,
              status: isPreviewUnavailable(error) ? "unavailable" : "failed",
            }),
          ),
      );
  };

  /**
   * The showing file is read if nothing is held for it yet, or its last
   * read failed (showing it again retries).
   */
  const readActive = () => {
    const path = tabState.activePath;
    if (!path || isImageFile(path) || buffers[path]) return;
    const status = reads[path]?.status;
    if (status && status !== "failed") return;
    read(path);
  };

  const reduceTabs = (action: FileTabsAction) => {
    const next = fileTabsReducer(tabState, action);
    if (next === tabState) return false;
    tabState = next;
    return true;
  };

  /** Closes a tab and forgets its file, plus any preview it replaced. */
  const closeTab = (path: string) => {
    reduceTabs({ type: "close", path });
    forget(path);
    readActive();
    emit();
  };

  const session: FileEditorSession & { refresh(): void } = {
    getSnapshot: () => snapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    open: (path, options = {}) => {
      const replaced = options.pin
        ? null
        : (tabState.tabs.find((tab) => !tab.pinned)?.path ?? null);
      reduceTabs({ type: options.pin ? "pin" : "preview", path });
      // A preview tab another file took over is closed: forget its file.
      if (
        replaced &&
        replaced !== path &&
        !tabState.tabs.some((tab) => tab.path === replaced)
      ) {
        forget(replaced);
      }
      if (options.position) {
        revealCount += 1;
        reveal = {
          ...options.position,
          focus: options.focus ?? false,
          path,
          requestId: revealCount,
        };
      }
      readActive();
      emit();
    },

    activate: (path) => {
      if (!reduceTabs({ type: "activate", path })) return;
      readActive();
      emit();
    },

    reorder: (fromIndex, toIndex) => {
      if (reduceTabs({ type: "reorder", fromIndex, toIndex })) emit();
    },

    edit: (path, content) => {
      const before = buffers;
      reduceBuffers({ type: "edit", key: path, content });
      if (buffers === before) return;
      // A draft is never silently swapped out by the next single-click.
      const tab = tabState.tabs.find((item) => item.path === path);
      if (tab && !tab.pinned && isBufferDirty(buffers[path])) {
        reduceTabs({ type: "pin", path });
      }
      emit();
    },

    close: (path) => {
      if (isBufferDirty(buffers[path])) return "confirm";
      closeTab(path);
      return "closed";
    },

    discardAndClose: (path) => closeTab(path),

    save: async (path) => {
      const scope = deps.getProjectScope(projectId);
      const buffer = buffers[path];
      if (
        !scope ||
        !buffer ||
        buffer.status !== "dirty" ||
        !reads[path]?.metadata?.writable
      ) {
        return false;
      }

      reduceBuffers({ type: "save-start", key: path });
      emit();
      try {
        const payload = await deps.api.writeProjectFile(
          {
            content: buffer.draftContent,
            expectedContent: buffer.diskContent,
            filePath: path,
            projectPath: scope.projectPath,
          },
          { hostId: scope.hostId },
        );
        reduceBuffers({
          type: "save-success",
          key: path,
          content: payload.content,
        });
        emit();
        deps.onSaved?.(projectId);
        return true;
      } catch (error) {
        reduceBuffers({
          // 409: the file changed on disk since it was read.
          type:
            error instanceof ApiError && error.status === 409
              ? "save-conflict"
              : "save-failure",
          key: path,
          error,
        });
        emit();
        return false;
      }
    },

    saveAndClose: async (path) => {
      if (await session.save(path)) {
        closeTab(path);
        return true;
      }
      session.activate(path);
      return false;
    },

    reload: (path) => {
      forget(path);
      if (tabState.activePath === path) readActive();
      emit();
    },

    forgetMissing: (path) => closeTab(path),

    refresh: () => {
      reduceBuffers({ type: "refresh" });
      // A read under way may have started before the change; read again.
      for (const [path, entry] of Object.entries(reads)) {
        if (!buffers[path] || entry.status !== "ready") {
          pendingReads.delete(path);
          reads = omit(reads, path);
        }
      }
      readActive();
      emit();
    },
  };
  return session;
};

export const createFileEditorSessions = (
  deps: FileEditorSessionDependencies,
): FileEditorSessions => {
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  return {
    session: (projectId) => {
      let session = sessions.get(projectId);
      if (!session) {
        session = createSession(projectId, deps);
        sessions.set(projectId, session);
      }
      return session;
    },
    refresh: (projectId) => sessions.get(projectId)?.refresh(),
    drop: (projectId) => {
      sessions.delete(projectId);
    },
  };
};
