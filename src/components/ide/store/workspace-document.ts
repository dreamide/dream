// The workspace document: the projects the user has open or closed, their
// chats, and which of them is showing. Every operation here is a pure
// function from one document to the next, and every one ends in `settle`,
// which enforces the single invariant the rest of the app relies on:
//
//   every open project has a live chat, its active chat is one of them, its
//   open chats are live chats of that project (the active one among them),
//   and the active project is an open project.
//
// The zustand actions are thin wrappers, `set(state => op(state, …))`; the
// "which chat is showing" question is answered in this file alone. The
// primitives (`sanitizeProjectUiForChats`, the default chat) come from the
// shared codec, so the main process settles persisted state the same way.
import type { UIMessage } from "ai";
import {
  createDefaultChatConfig,
  createProjectConfig,
} from "@/lib/ide-defaults";
import type {
  AppSettings,
  ChatConfig,
  ProjectConfig,
  ProjectUiState,
  ProjectWorktreeInfo,
} from "@/types/ide";
import {
  ensureActiveChatForProject,
  ensureActiveProject,
  normalizeProjectPathKey,
  sanitizeProjectUiForChats,
} from "../../../../electron/shared/persisted-state-codec.js";

export interface WorkspaceDocument {
  activeProjectId: string | null;
  chats: ChatConfig[];
  closedProjects: ProjectConfig[];
  /**
   * Per project, the empty chat `addChat` reuses instead of creating another
   * one. Registered when a default chat is created, cleared once it has
   * messages or is deleted.
   */
  draftChatIdByProject: Record<string, string | null>;
  messagesByChatId: Record<string, UIMessage[]>;
  projects: ProjectConfig[];
}

/** A chat with its transcript, as seeded into a project by a branch. */
export interface SeededChat {
  chat: ChatConfig;
  messages: UIMessage[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isLiveChatOf = (chat: ChatConfig, projectId: string) =>
  chat.projectId === projectId && chat.deletedAt === null;

const findByPath = (projects: ProjectConfig[], path: string) => {
  const pathKey = normalizeProjectPathKey(path);
  return projects.find(
    (project) => normalizeProjectPathKey(project.path) === pathKey,
  );
};

const replaceProject = (projects: ProjectConfig[], project: ProjectConfig) =>
  projects.map((item) => (item.id === project.id ? project : item));

const updateUi = (
  projects: ProjectConfig[],
  projectId: string,
  update: (ui: ProjectUiState) => ProjectUiState,
) =>
  projects.map((project) =>
    project.id === projectId ? { ...project, ui: update(project.ui) } : project,
  );

const sameRecord = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) => {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
};

/** Whether sanitizing changed anything, so untouched projects keep identity. */
const sameUi = (left: ProjectUiState, right: ProjectUiState) =>
  left.activeChatId === right.activeChatId &&
  left.multiChat === right.multiChat &&
  left.openChatIds.length === right.openChatIds.length &&
  left.openChatIds.every(
    (chatId, index) => right.openChatIds[index] === chatId,
  ) &&
  sameRecord(left.chatColumnWidths, right.chatColumnWidths);

/** Shows one chat alone: the single-column focus. */
const showOnly = (ui: ProjectUiState, chatId: string): ProjectUiState => ({
  ...ui,
  activeChatId: chatId,
  openChatIds: [chatId],
  chatColumnWidths: {},
});

/**
 * Enforces the invariant on every project and returns a document in which
 * anything that already held keeps its identity. An open project without a
 * live chat gets a default one, registered as its draft.
 */
export const settle = (
  doc: WorkspaceDocument,
  settings: AppSettings,
): WorkspaceDocument => {
  let chats = doc.chats;
  let messagesByChatId = doc.messagesByChatId;
  let draftChatIdByProject = doc.draftChatIdByProject;

  const sanitized = (project: ProjectConfig, activeChatId: string | null) => {
    const ui = sanitizeProjectUiForChats(
      chats,
      project.id,
      project.ui,
      activeChatId,
    );
    return sameUi(ui, project.ui) ? project : { ...project, ui };
  };

  let projectsChanged = false;
  const projects = doc.projects.map((project) => {
    let activeChatId = ensureActiveChatForProject(
      chats,
      project.id,
      project.ui.activeChatId,
    );
    if (!activeChatId) {
      const chat = createDefaultChatConfig(project, settings);
      chats = [...chats, chat];
      messagesByChatId = { ...messagesByChatId, [chat.id]: [] };
      draftChatIdByProject = { ...draftChatIdByProject, [project.id]: chat.id };
      activeChatId = chat.id;
    }
    const next = sanitized(project, activeChatId);
    projectsChanged ||= next !== project;
    return next;
  });

  let closedChanged = false;
  const closedProjects = doc.closedProjects.map((project) => {
    const next = sanitized(
      project,
      ensureActiveChatForProject(chats, project.id, project.ui.activeChatId),
    );
    closedChanged ||= next !== project;
    return next;
  });

  const activeProjectId =
    doc.activeProjectId === null
      ? null
      : ensureActiveProject(projects, doc.activeProjectId);

  return {
    activeProjectId,
    chats,
    closedProjects: closedChanged ? closedProjects : doc.closedProjects,
    draftChatIdByProject,
    messagesByChatId,
    projects: projectsChanged ? projects : doc.projects,
  };
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface OpenProjectOptions {
  /** `false` opens the project without switching to it. */
  activate?: boolean;
  /** Shapes a project that did not exist yet (name, model, initial view). */
  create?: (project: ProjectConfig) => ProjectConfig;
  /** A chat to seed into the project and show alone (a branched chat). */
  seed?: (project: ProjectConfig) => SeededChat | null;
  /**
   * Marks the project as a git worktree. Fills in projects without worktree
   * info; with `replaceWorktree`, a fresh record replaces a stale one.
   */
  worktree?: ProjectWorktreeInfo | null;
  replaceWorktree?: boolean;
}

/**
 * Opens the project at `path`: brings an open one forward, reopens a closed
 * one with its chats, or creates it. The result names the project and the
 * chat it shows.
 */
export const openProject = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  path: string,
  options: OpenProjectOptions = {},
): { doc: WorkspaceDocument; chatId: string | null; projectId: string } => {
  const activate = options.activate !== false;
  const lastUsedAt = new Date().toISOString();
  const worktree = options.worktree ?? null;
  const withWorktree = (project: ProjectConfig): ProjectConfig =>
    worktree && (options.replaceWorktree || !project.worktree)
      ? { ...project, worktree }
      : project;

  let project: ProjectConfig;
  let projects: ProjectConfig[];
  let closedProjects = doc.closedProjects;
  let draftChatIdByProject = doc.draftChatIdByProject;

  const openProject = findByPath(doc.projects, path);
  if (openProject) {
    project = withWorktree({ ...openProject, lastUsedAt });
    projects = replaceProject(doc.projects, project);
  } else {
    const closedProject = findByPath(doc.closedProjects, path);
    if (closedProject) {
      project = withWorktree({ ...closedProject, lastUsedAt, path });
      const pathKey = normalizeProjectPathKey(path);
      closedProjects = doc.closedProjects.filter(
        (item) =>
          item.id !== closedProject.id &&
          normalizeProjectPathKey(item.path) !== pathKey,
      );
    } else {
      project = withWorktree(createProjectConfig(path, settings));
      project = options.create?.(project) ?? project;
      draftChatIdByProject = { ...draftChatIdByProject, [project.id]: null };
    }
    projects = [...doc.projects, project];
  }

  let chats = doc.chats;
  let messagesByChatId = doc.messagesByChatId;
  const seeded = options.seed?.(project) ?? null;
  if (seeded) {
    chats = [...chats, seeded.chat];
    messagesByChatId = {
      ...messagesByChatId,
      [seeded.chat.id]: seeded.messages,
    };
    project = { ...project, ui: showOnly(project.ui, seeded.chat.id) };
    projects = replaceProject(projects, project);
  }

  const settled = settle(
    {
      activeProjectId: activate ? project.id : doc.activeProjectId,
      chats,
      closedProjects,
      draftChatIdByProject,
      messagesByChatId,
      projects,
    },
    settings,
  );
  const shown = settled.projects.find((item) => item.id === project.id);
  return {
    chatId: seeded?.chat.id ?? shown?.ui.activeChatId ?? null,
    doc: settled,
    projectId: project.id,
  };
};

/** Moves an open project to the closed list; the next open project shows. */
export const closeProject = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
): WorkspaceDocument => {
  const closedProject = doc.projects.find(
    (project) => project.id === projectId,
  );
  if (!closedProject) {
    return settle(doc, settings);
  }
  const pathKey = normalizeProjectPathKey(closedProject.path);
  const projects = doc.projects.filter((project) => project.id !== projectId);
  return settle(
    {
      ...doc,
      activeProjectId:
        doc.activeProjectId === projectId
          ? (projects[0]?.id ?? null)
          : doc.activeProjectId,
      closedProjects: [
        ...doc.closedProjects.filter(
          (project) =>
            project.id !== closedProject.id &&
            normalizeProjectPathKey(project.path) !== pathKey,
        ),
        { ...closedProject, lastUsedAt: new Date().toISOString() },
      ],
      projects,
    },
    settings,
  );
};

/** Replaces the open project list (a reorder, or the shell's sync). */
export const setProjects = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projects: ProjectConfig[],
): WorkspaceDocument => settle({ ...doc, projects }, settings);

/** Makes an open project the active one and marks it used. */
export const activateProject = (
  doc: WorkspaceDocument,
  projectId: string | null,
): WorkspaceDocument => {
  if (projectId === null) {
    return { ...doc, activeProjectId: null };
  }
  const activeProjectId = ensureActiveProject(doc.projects, projectId);
  if (!activeProjectId) {
    return { ...doc, activeProjectId };
  }
  const lastUsedAt = new Date().toISOString();
  return {
    ...doc,
    activeProjectId,
    projects: doc.projects.map((project) =>
      project.id === activeProjectId ? { ...project, lastUsedAt } : project,
    ),
  };
};

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/**
 * Shows a fresh chat alone in the project. The project's draft (an empty
 * chat from an earlier `addChat`) is shown again instead of a new one being
 * created, unless `forceNew`.
 */
export const addChat = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
  options: { forceNew?: boolean; title?: string } = {},
): { doc: WorkspaceDocument; chatId: string | null } => {
  const project = doc.projects.find((item) => item.id === projectId);
  if (!project) {
    return { chatId: null, doc };
  }

  const draftChatId = doc.draftChatIdByProject[projectId] ?? null;
  if (
    !options.forceNew &&
    draftChatId &&
    doc.chats.some(
      (chat) => chat.id === draftChatId && isLiveChatOf(chat, projectId),
    )
  ) {
    return {
      chatId: draftChatId,
      doc: settle(
        {
          ...doc,
          activeProjectId: projectId,
          projects: updateUi(doc.projects, projectId, (ui) =>
            showOnly(ui, draftChatId),
          ),
        },
        settings,
      ),
    };
  }

  const chat = createDefaultChatConfig(project, settings, {
    title: options.title,
  });
  return {
    chatId: chat.id,
    doc: settle(
      {
        activeProjectId: projectId,
        chats: [...doc.chats, chat],
        closedProjects: doc.closedProjects,
        draftChatIdByProject: {
          ...doc.draftChatIdByProject,
          [projectId]: chat.id,
        },
        messagesByChatId: { ...doc.messagesByChatId, [chat.id]: [] },
        projects: updateUi(doc.projects, projectId, (ui) =>
          showOnly(ui, chat.id),
        ),
      },
      settings,
    ),
  };
};

/** Opens a fresh chat in a new column beside the project's open chats. */
export const addChatBeside = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
): { doc: WorkspaceDocument; chatId: string | null } => {
  const project = doc.projects.find((item) => item.id === projectId);
  if (!project) {
    return { chatId: null, doc };
  }

  const chat = createDefaultChatConfig(project, settings);
  return {
    chatId: chat.id,
    doc: settle(
      {
        activeProjectId: projectId,
        chats: [...doc.chats, chat],
        closedProjects: doc.closedProjects,
        draftChatIdByProject: {
          ...doc.draftChatIdByProject,
          [projectId]: chat.id,
        },
        messagesByChatId: { ...doc.messagesByChatId, [chat.id]: [] },
        projects: updateUi(doc.projects, projectId, (ui) => ({
          ...ui,
          activeChatId: chat.id,
          multiChat: true,
          openChatIds: [...ui.openChatIds, chat.id],
        })),
      },
      settings,
    ),
  };
};

/**
 * Adds a chat branched from `sourceChatId`, with its transcript, and shows
 * it: beside the source in multi-chat, alone otherwise.
 */
export const branchChat = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  { chat, messages }: SeededChat,
  sourceChatId: string,
): WorkspaceDocument =>
  settle(
    {
      ...doc,
      activeProjectId: chat.projectId,
      chats: [...doc.chats, chat],
      messagesByChatId: { ...doc.messagesByChatId, [chat.id]: messages },
      projects: updateUi(doc.projects, chat.projectId, (ui) => {
        if (!ui.multiChat) {
          return showOnly(ui, chat.id);
        }
        const sourceIndex = ui.openChatIds.indexOf(sourceChatId);
        const insertAt =
          sourceIndex >= 0 ? sourceIndex + 1 : ui.openChatIds.length;
        return {
          ...ui,
          activeChatId: chat.id,
          openChatIds: [
            ...ui.openChatIds.slice(0, insertAt),
            chat.id,
            ...ui.openChatIds.slice(insertAt),
          ],
        };
      }),
    },
    settings,
  );

/**
 * Makes `chatId` the project's active chat (revealing it in multi-chat). An
 * id that is not a live chat of the project falls back to the first one.
 */
export const focusChat = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
  chatId: string | null,
): WorkspaceDocument =>
  settle(
    {
      ...doc,
      projects: updateUi(doc.projects, projectId, (ui) => ({
        ...ui,
        activeChatId: chatId,
      })),
    },
    settings,
  );

/** Switches a project between one chat at a time and chats side by side. */
export const toggleMultiChat = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
): WorkspaceDocument =>
  settle(
    {
      ...doc,
      projects: updateUi(doc.projects, projectId, (ui) => {
        const multiChat = !ui.multiChat;
        return {
          ...ui,
          activeChatId: ui.activeChatId ?? ui.openChatIds[0] ?? null,
          chatColumnWidths: multiChat ? ui.chatColumnWidths : {},
          multiChat,
        };
      }),
    },
    settings,
  );

/**
 * Soft-deletes a chat. Where it was showing, the neighbouring open chat
 * takes its place; a project left with no live chat gets a fresh one.
 */
export const deleteChat = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  chatId: string,
): WorkspaceDocument => {
  const chat = doc.chats.find((item) => item.id === chatId);
  if (!chat) {
    return doc;
  }

  const deletedAt = new Date().toISOString();
  const withoutChat = (ui: ProjectUiState): ProjectUiState => {
    const deletedIndex = ui.openChatIds.indexOf(chatId);
    const openChatIds = ui.openChatIds.filter((openId) => openId !== chatId);
    return {
      ...ui,
      activeChatId:
        ui.activeChatId === chatId
          ? (openChatIds[deletedIndex] ?? openChatIds[deletedIndex - 1] ?? null)
          : ui.activeChatId,
      openChatIds,
    };
  };
  const draftChatIdByProject =
    doc.draftChatIdByProject[chat.projectId] === chatId
      ? { ...doc.draftChatIdByProject, [chat.projectId]: null }
      : doc.draftChatIdByProject;

  return settle(
    {
      ...doc,
      chats: doc.chats.map((item) =>
        item.id === chatId ? { ...item, deletedAt } : item,
      ),
      closedProjects: updateUi(doc.closedProjects, chat.projectId, withoutChat),
      draftChatIdByProject,
      projects: updateUi(doc.projects, chat.projectId, withoutChat),
    },
    settings,
  );
};

/** Removes chats and their transcripts for good. */
export const removeChats = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  chatIds: Iterable<string>,
): WorkspaceDocument => {
  const removed = new Set(chatIds);
  const removedChats = doc.chats.filter((chat) => removed.has(chat.id));
  if (removedChats.length === 0) {
    return doc;
  }

  const messagesByChatId = { ...doc.messagesByChatId };
  const draftChatIdByProject = { ...doc.draftChatIdByProject };
  for (const chat of removedChats) {
    delete messagesByChatId[chat.id];
    if (draftChatIdByProject[chat.projectId] === chat.id) {
      draftChatIdByProject[chat.projectId] = null;
    }
  }

  return settle(
    {
      ...doc,
      chats: doc.chats.filter((chat) => !removed.has(chat.id)),
      draftChatIdByProject,
      messagesByChatId,
    },
    settings,
  );
};

/** Brings soft-deleted chats back. */
export const restoreChats = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  chatIds: Iterable<string>,
): WorkspaceDocument => {
  const restored = new Set(chatIds);
  return settle(
    {
      ...doc,
      chats: doc.chats.map((chat) =>
        restored.has(chat.id) ? { ...chat, deletedAt: null } : chat,
      ),
    },
    settings,
  );
};
