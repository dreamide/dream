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
import { isDeepEqualData, type UIMessage } from "ai";
import {
  createDefaultChatConfig,
  createProjectConfig,
} from "@/lib/ide-defaults";
import type {
  AppSettings,
  ChatConfig,
  PersistedWorkspaceProject,
  ProjectConfig,
  ProjectUiState,
  ProjectWorktreeInfo,
} from "@/types/ide";
import {
  chatsByProjectOf,
  decodeCatalogEntries,
  ensureActiveChatForProject,
  ensureActiveProject,
  getProjectHostId,
  LOCAL_HOST_ID,
  mergeWorkspaceAndCatalog,
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

/**
 * The result of an operation that can take projects or chats out of the
 * document: the next document, and every project and chat that left it, so
 * the store drops what it keeps for them outside the document.
 */
export interface WorkspaceRemoval {
  doc: WorkspaceDocument;
  removedChatIds: string[];
  removedProjectIds: string[];
}

/** Host catalog changes made elsewhere, as raw rows. */
export interface CatalogChanges {
  chats?: unknown[];
  projects?: unknown[];
  removedChatIds?: string[];
  removedProjectIds?: string[];
}

/** A host's catalog as read from it, as raw rows. */
export interface HostCatalog {
  chats: unknown[];
  projects: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isLiveChatOf = (chat: ChatConfig, projectId: string) =>
  chat.projectId === projectId && chat.deletedAt === null;

/** The project at `path` on `hostId` (paths are unique per host). */
const findByPath = (
  projects: ProjectConfig[],
  path: string,
  hostId: string = LOCAL_HOST_ID,
) => {
  const pathKey = normalizeProjectPathKey(path);
  return projects.find(
    (project) =>
      getProjectHostId(project) === hostId &&
      normalizeProjectPathKey(project.path) === pathKey,
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

const allProjectsOf = (doc: WorkspaceDocument) => [
  ...doc.projects,
  ...doc.closedProjects,
];

/** Authentication merged two connection ids; retain every tab, chat and draft. */
export const reassignHost = (
  doc: WorkspaceDocument,
  from: string,
  to: string,
): WorkspaceDocument => {
  const reassign = (project: ProjectConfig) =>
    getProjectHostId(project) === from
      ? { ...project, hostId: to === "local" ? undefined : to }
      : project;
  return {
    ...doc,
    projects: doc.projects.map(reassign),
    closedProjects: doc.closedProjects.map(reassign),
  };
};

/** Everything that was in `before` and is not in `after`. */
const removalBetween = (
  before: WorkspaceDocument,
  after: WorkspaceDocument,
): WorkspaceRemoval => {
  const projectIds = new Set(allProjectsOf(after).map((project) => project.id));
  const chatIds = new Set(after.chats.map((chat) => chat.id));
  return {
    doc: after,
    removedChatIds: before.chats
      .map((chat) => chat.id)
      .filter((id) => !chatIds.has(id)),
    removedProjectIds: allProjectsOf(before)
      .map((project) => project.id)
      .filter((id) => !projectIds.has(id)),
  };
};

/** `record` without the entries `keep` rejects; itself when it keeps all. */
const filterRecord = <T>(
  record: Record<string, T>,
  keep: (key: string, value: T) => boolean,
): Record<string, T> => {
  const entries = Object.entries(record);
  const kept = entries.filter(([key, value]) => keep(key, value));
  return kept.length === entries.length ? record : Object.fromEntries(kept);
};

/** Drops drafts and transcripts of projects and chats no longer present. */
const pruneOrphans = (doc: WorkspaceDocument): WorkspaceDocument => {
  const projectIds = new Set(allProjectsOf(doc).map((project) => project.id));
  const chatIds = new Set(doc.chats.map((chat) => chat.id));
  return {
    ...doc,
    draftChatIdByProject: filterRecord(
      doc.draftChatIdByProject,
      (projectId, chatId) =>
        projectIds.has(projectId) && (chatId === null || chatIds.has(chatId)),
    ),
    messagesByChatId: filterRecord(doc.messagesByChatId, (chatId) =>
      chatIds.has(chatId),
    ),
  };
};

/** Each row, or the held row of its id when the two are equal. */
const holding = <T extends { id: string }>(
  rows: T[],
  held: ReadonlyMap<string, T>,
): T[] =>
  rows.map((row) => {
    const same = held.get(row.id);
    return same && same !== row && isDeepEqualData(row, same) ? same : row;
  });

/** `previous` when `next` holds the same rows in the same order. */
const sameRowsOr = <T>(next: T[], previous: T[]): T[] =>
  next.length === previous.length &&
  next.every((row, index) => row === previous[index])
    ? previous
    : next;

/**
 * Repairs raw project and chat lists with the codec (invalid rows dropped,
 * one project per path on each host) and settles the document around them.
 * Rows the document already holds are not decoded again, and a list whose
 * rows all held is the document's own: applying a host's change to one chat
 * leaves every other project and chat, and the lists, as they were.
 */
const settleRaw = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  raw: { chats: unknown[]; closedProjects: unknown[]; projects: unknown[] },
): WorkspaceDocument => {
  const kept = new Set<unknown>([...allProjectsOf(doc), ...doc.chats]);
  const decoded = decodeCatalogEntries(raw, settings, undefined, kept);
  // A row that arrived equal to the one held (a whole catalog reloaded) is
  // the held one.
  const heldProjects = new Map(
    allProjectsOf(doc).map((project) => [project.id, project]),
  );
  const heldChats = new Map(doc.chats.map((chat) => [chat.id, chat]));
  const next = settle(
    pruneOrphans({
      ...doc,
      chats: holding(decoded.chats, heldChats),
      closedProjects: holding(decoded.closedProjects, heldProjects),
      projects: holding(decoded.projects, heldProjects),
    }),
    settings,
  );
  return {
    ...next,
    chats: sameRowsOr(next.chats, doc.chats),
    closedProjects: sameRowsOr(next.closedProjects, doc.closedProjects),
    projects: sameRowsOr(next.projects, doc.projects),
  };
};

const isRecordWithId = (
  value: unknown,
): value is Record<string, unknown> & { id: string } =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as Record<string, unknown>).id === "string";

/** Stamps a host's row with its host, which its own catalog does not say. */
const withHost = (project: Record<string, unknown>, hostId: string) =>
  hostId === LOCAL_HOST_ID ? project : { ...project, hostId };

/**
 * Takes a chat out of a project's open chats. When it was the active one,
 * the open chat that took its place (else the one before it) becomes active.
 */
const withoutOpenChat = (
  ui: ProjectUiState,
  chatId: string,
): ProjectUiState => {
  const index = ui.openChatIds.indexOf(chatId);
  const openChatIds = ui.openChatIds.filter((openId) => openId !== chatId);
  return {
    ...ui,
    activeChatId:
      ui.activeChatId === chatId
        ? (openChatIds[index] ?? openChatIds[index - 1] ?? null)
        : ui.activeChatId,
    openChatIds,
  };
};

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
  // Each project reads only its own chats, grouped once.
  const chatsByProject = chatsByProjectOf(chats);
  const chatsOf = (projectId: string) => chatsByProject.get(projectId) ?? [];

  const sanitized = (project: ProjectConfig, activeChatId: string | null) => {
    const ui = sanitizeProjectUiForChats(
      chatsOf(project.id),
      project.id,
      project.ui,
      activeChatId,
    );
    return sameUi(ui, project.ui) ? project : { ...project, ui };
  };

  let projectsChanged = false;
  const projects = doc.projects.map((project) => {
    let activeChatId = ensureActiveChatForProject(
      chatsOf(project.id),
      project.id,
      project.ui.activeChatId,
    );
    if (!activeChatId) {
      const chat = createDefaultChatConfig(project, settings);
      chats = [...chats, chat];
      chatsByProject.set(project.id, [...chatsOf(project.id), chat]);
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
      ensureActiveChatForProject(
        chatsOf(project.id),
        project.id,
        project.ui.activeChatId,
      ),
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
  /** The host the path is on; the local host when absent. */
  hostId?: string;
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

  const hostId = options.hostId ?? LOCAL_HOST_ID;
  const openProject = findByPath(doc.projects, path, hostId);
  if (openProject) {
    project = withWorktree({ ...openProject, lastUsedAt });
    projects = replaceProject(doc.projects, project);
  } else {
    const closedProject = findByPath(doc.closedProjects, path, hostId);
    if (closedProject) {
      project = withWorktree({ ...closedProject, lastUsedAt, path });
      const pathKey = normalizeProjectPathKey(path);
      closedProjects = doc.closedProjects.filter(
        (item) =>
          item.id !== closedProject.id &&
          !(
            getProjectHostId(item) === hostId &&
            normalizeProjectPathKey(item.path) === pathKey
          ),
      );
    } else {
      project = withWorktree(createProjectConfig(path, settings));
      if (hostId !== LOCAL_HOST_ID) project = { ...project, hostId };
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

/**
 * Takes projects out of the document for good, open or closed, with their
 * chats. A removed active project hands over to the first open one.
 */
export const removeProjects = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectIds: Iterable<string>,
): WorkspaceRemoval => {
  const removed = new Set(projectIds);
  if (!allProjectsOf(doc).some((project) => removed.has(project.id))) {
    return removalBetween(doc, doc);
  }
  const keep = (project: ProjectConfig) => !removed.has(project.id);
  const projects = doc.projects.filter(keep);
  return removalBetween(
    doc,
    settle(
      pruneOrphans({
        ...doc,
        activeProjectId:
          doc.activeProjectId !== null && removed.has(doc.activeProjectId)
            ? (projects[0]?.id ?? null)
            : doc.activeProjectId,
        chats: doc.chats.filter((chat) => !removed.has(chat.projectId)),
        closedProjects: doc.closedProjects.filter(keep),
        projects,
      }),
      settings,
    ),
  );
};

/** Removes every project on `hostId`, with their chats. */
export const removeHostProjects = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  hostId: string,
): WorkspaceRemoval =>
  removeProjects(
    doc,
    settings,
    allProjectsOf(doc)
      .filter((project) => getProjectHostId(project) === hostId)
      .map((project) => project.id),
  );

/**
 * The document as loaded at startup. Each project's active chat that is
 * still empty is registered as its draft, so "new chat" shows it again
 * instead of creating another.
 */
export const restore = (
  loaded: Omit<WorkspaceDocument, "draftChatIdByProject">,
  settings: AppSettings,
): WorkspaceDocument => {
  const draftChatIdByProject: Record<string, string | null> = {};
  for (const project of [...loaded.projects, ...loaded.closedProjects]) {
    const activeChat = loaded.chats.find(
      (chat) => chat.id === project.ui.activeChatId,
    );
    if (
      activeChat &&
      activeChat.deletedAt === null &&
      activeChat.messageCount === 0
    ) {
      draftChatIdByProject[project.id] = activeChat.id;
    }
  }
  return settle(
    {
      ...loaded,
      activeProjectId: ensureActiveProject(
        loaded.projects,
        loaded.activeProjectId,
      ),
      draftChatIdByProject,
    },
    settings,
  );
};

// ---------------------------------------------------------------------------
// Hosts' catalogs
//
// What exists (projects, chats, their catalog fields) is the host's; whether
// a project is open, where it sits and what it shows are this window's.
// ---------------------------------------------------------------------------

/**
 * Applies catalog changes another client (or the host itself) made on
 * `hostId`. Catalog fields come from the host and this window's workspace
 * fields stay; a project this window did not know arrives closed. A host's
 * changes only ever remove that host's projects and their chats: another
 * host's project with an id it does not know is not gone.
 */
export const applyCatalogChanges = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  hostId: string,
  changes: CatalogChanges,
): WorkspaceRemoval => {
  const hostProjectIds = new Set(
    allProjectsOf(doc)
      .filter((project) => getProjectHostId(project) === hostId)
      .map((project) => project.id),
  );
  const removedProjectIds = new Set(
    (changes.removedProjectIds ?? []).filter((id) => hostProjectIds.has(id)),
  );
  const chatsById = new Map(doc.chats.map((chat) => [chat.id, chat]));
  const removedChatIds = new Set(
    (changes.removedChatIds ?? []).filter((id) => {
      const chat = chatsById.get(id);
      return !chat || hostProjectIds.has(chat.projectId);
    }),
  );
  const incomingProjects = new Map(
    (changes.projects ?? [])
      .filter(isRecordWithId)
      .map((project) => [project.id, withHost(project, hostId)]),
  );
  const incomingChats = new Map(
    (changes.chats ?? []).filter(isRecordWithId).map((chat) => [chat.id, chat]),
  );

  const mergeProject = (project: ProjectConfig): unknown => {
    const incoming = incomingProjects.get(project.id);
    return incoming
      ? {
          ...incoming,
          id: project.id,
          lastUsedAt: project.lastUsedAt,
          ui: project.ui,
        }
      : project;
  };
  const keepProject = (project: ProjectConfig) =>
    !removedProjectIds.has(project.id);
  const knownProjectIds = new Set(
    allProjectsOf(doc).map((project) => project.id),
  );

  return removalBetween(
    doc,
    settleRaw(doc, settings, {
      chats: [
        ...doc.chats
          .filter(
            (chat) =>
              !removedChatIds.has(chat.id) &&
              !removedProjectIds.has(chat.projectId),
          )
          .map((chat): unknown => {
            const incoming = incomingChats.get(chat.id);
            return incoming
              ? { ...incoming, messageCount: chat.messageCount }
              : chat;
          }),
        ...[...incomingChats.values()].filter(
          (chat) => !chatsById.has(chat.id),
        ),
      ],
      closedProjects: [
        ...doc.closedProjects.filter(keepProject).map(mergeProject),
        ...[...incomingProjects.values()].filter(
          (project) => !knownProjectIds.has(project.id as string),
        ),
      ],
      projects: doc.projects.filter(keepProject).map(mergeProject),
    }),
  );
};

/**
 * Loads a just-connected host's whole catalog. The host decides which of
 * its projects exist; this window's last saved workspace rows decide which
 * are open. Projects already showing (from the startup snapshot) keep where
 * they are, open or closed: the tabs may have moved while the host was
 * away. New ones go after them. Other hosts' projects are untouched.
 */
export const loadHostCatalog = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  hostId: string,
  {
    catalog,
    workspaceProjects,
  }: { catalog: HostCatalog; workspaceProjects: PersistedWorkspaceProject[] },
): WorkspaceRemoval => {
  const merged = mergeWorkspaceAndCatalog({
    catalog,
    hostId,
    workspace: { workspaceProjects },
  }) as { chats: unknown[]; closedProjects: unknown[]; projects: unknown[] };

  const onOtherHosts = (project: ProjectConfig) =>
    getProjectHostId(project) !== hostId;
  const otherProjectIds = new Set(
    allProjectsOf(doc)
      .filter(onOtherHosts)
      .map((project) => project.id),
  );

  const idOf = (project: unknown) => (project as { id: string }).id;
  const openIds = new Set(doc.projects.map((project) => project.id));
  const closedIds = new Set(doc.closedProjects.map((project) => project.id));
  const hostProjects = [...merged.projects, ...merged.closedProjects];
  const mergedOpenIds = new Set(merged.projects.map(idOf));
  const isOpen = (project: unknown) =>
    openIds.has(idOf(project)) ||
    (!closedIds.has(idOf(project)) && mergedOpenIds.has(idOf(project)));
  const inPlace = (list: unknown[], previous: ProjectConfig[]) => {
    const index = new Map(
      previous.map((project, position) => [project.id, position]),
    );
    const at = (project: unknown) =>
      index.get(idOf(project)) ?? Number.POSITIVE_INFINITY;
    return list
      .map((project, position) => ({ position, project }))
      .sort((a, b) => at(a.project) - at(b.project) || a.position - b.position)
      .map((item) => item.project);
  };

  return removalBetween(
    doc,
    settleRaw(doc, settings, {
      chats: [
        ...doc.chats.filter((chat) => otherProjectIds.has(chat.projectId)),
        ...merged.chats,
      ],
      closedProjects: inPlace(
        [
          ...doc.closedProjects.filter(onOtherHosts),
          ...hostProjects.filter((project) => !isOpen(project)),
        ],
        doc.closedProjects,
      ),
      projects: inPlace(
        [...doc.projects.filter(onOtherHosts), ...hostProjects.filter(isOpen)],
        doc.projects,
      ),
    }),
  );
};

/**
 * A project the host refused because it already has one at that path: the
 * host's project (`keptRow`, as the host has it) takes the refused one's
 * place, open or closed, with what this window showed in it, its chats and
 * its draft. Any other copy of the kept project in the document goes.
 */
export const adoptProject = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  hostId: string,
  refusedId: string,
  keptRow: Record<string, unknown> & { id: string },
): WorkspaceRemoval => {
  const keptId = keptRow.id;
  const refused = allProjectsOf(doc).find(
    (project) => project.id === refusedId,
  );
  if (!refused || keptId === refusedId) {
    return removalBetween(doc, doc);
  }

  const adopted: unknown = {
    ...refused,
    ...withHost(keptRow, hostId),
    id: keptId,
    lastUsedAt: refused.lastUsedAt,
    ui: refused.ui,
  };
  const swap = (projects: ProjectConfig[]): unknown[] =>
    projects.flatMap((project) =>
      project.id === refusedId
        ? [adopted]
        : project.id === keptId
          ? []
          : [project],
    );

  const { [refusedId]: draftChatId = null, ...draftChatIdByProject } =
    doc.draftChatIdByProject;
  return removalBetween(
    doc,
    settleRaw(
      {
        ...doc,
        activeProjectId:
          doc.activeProjectId === refusedId ? keptId : doc.activeProjectId,
        draftChatIdByProject: {
          ...draftChatIdByProject,
          ...(draftChatId ? { [keptId]: draftChatId } : {}),
        },
      },
      settings,
      {
        // Its chats go with it: the host refused them along with it.
        chats: doc.chats.map((chat) =>
          chat.projectId === refusedId ? { ...chat, projectId: keptId } : chat,
        ),
        closedProjects: swap(doc.closedProjects),
        projects: swap(doc.projects),
      },
    ),
  );
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
  const withoutChat = (ui: ProjectUiState) => withoutOpenChat(ui, chatId);
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

/**
 * Closes a chat's column in side-by-side chats; the chat itself stays. The
 * last open column cannot be closed.
 */
export const closeChatColumn = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
  chatId: string,
): WorkspaceDocument => {
  const project = doc.projects.find((item) => item.id === projectId);
  if (
    !project ||
    project.ui.openChatIds.length <= 1 ||
    !project.ui.openChatIds.includes(chatId)
  ) {
    return doc;
  }
  return settle(
    {
      ...doc,
      projects: updateUi(doc.projects, projectId, (ui) =>
        withoutOpenChat(ui, chatId),
      ),
    },
    settings,
  );
};

/** Moves an open chat's column from one position to another. */
export const reorderChatColumns = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
  fromIndex: number,
  toIndex: number,
): WorkspaceDocument => {
  const project = doc.projects.find((item) => item.id === projectId);
  const count = project?.ui.openChatIds.length ?? 0;
  if (
    !project ||
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= count ||
    toIndex >= count
  ) {
    return doc;
  }
  return settle(
    {
      ...doc,
      projects: updateUi(doc.projects, projectId, (ui) => {
        const openChatIds = [...ui.openChatIds];
        const [moved] = openChatIds.splice(fromIndex, 1);
        if (moved !== undefined) openChatIds.splice(toIndex, 0, moved);
        return { ...ui, openChatIds };
      }),
    },
    settings,
  );
};

/** Sets the widths of a project's chat columns; only open chats keep one. */
export const setChatColumnWidths = (
  doc: WorkspaceDocument,
  settings: AppSettings,
  projectId: string,
  widths: Record<string, number>,
): WorkspaceDocument =>
  settle(
    {
      ...doc,
      projects: updateUi(doc.projects, projectId, (ui) => ({
        ...ui,
        chatColumnWidths: widths,
      })),
    },
    settings,
  );

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
