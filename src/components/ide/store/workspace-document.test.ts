import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { AppSettings, ChatConfig, ProjectConfig } from "@/types/ide";
import * as workspace from "./workspace-document";

const SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  defaultModel: "gpt-5-codex",
  defaultPermissionMode: "ask",
  openAiSelectedModels: ["gpt-5-codex"],
};

const liveChatsOf = (doc: workspace.WorkspaceDocument, projectId: string) =>
  doc.chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );

/**
 * The invariant every operation must leave the document in: every open
 * project has a live chat, its active chat is one of them, its open chats
 * are live chats of that project with the active one among them, and the
 * active project is open. Closed projects may lack a chat but never name a
 * chat that is gone.
 */
const assertInvariant = (doc: workspace.WorkspaceDocument) => {
  for (const project of doc.projects) {
    const liveIds = new Set(liveChatsOf(doc, project.id).map((c) => c.id));
    assert.ok(liveIds.size > 0, `${project.name} has no live chat`);
    assert.ok(
      project.ui.activeChatId && liveIds.has(project.ui.activeChatId),
      `${project.name} active chat is not a live chat of it`,
    );
    for (const chatId of project.ui.openChatIds) {
      assert.ok(liveIds.has(chatId), `${project.name} shows a dead chat`);
    }
    assert.ok(
      project.ui.openChatIds.includes(project.ui.activeChatId),
      `${project.name} active chat is not open`,
    );
    if (!project.ui.multiChat) {
      assert.equal(project.ui.openChatIds.length, 1);
    }
    for (const chatId of Object.keys(project.ui.chatColumnWidths)) {
      assert.ok(project.ui.openChatIds.includes(chatId));
    }
  }
  for (const project of doc.closedProjects) {
    const liveIds = new Set(liveChatsOf(doc, project.id).map((c) => c.id));
    for (const chatId of project.ui.openChatIds) {
      assert.ok(
        liveIds.has(chatId),
        `closed ${project.name} shows a dead chat`,
      );
    }
  }
  assert.ok(
    doc.activeProjectId === null ||
      doc.projects.some((project) => project.id === doc.activeProjectId),
    "active project is not open",
  );
  for (const chat of doc.chats) {
    assert.ok(
      [...doc.projects, ...doc.closedProjects].some(
        (project) => project.id === chat.projectId,
      ),
      "chat of an unknown project",
    );
  }
};

const message = (id: string): UIMessage =>
  ({ id, parts: [{ text: id, type: "text" }], role: "user" }) as UIMessage;

const emptyDoc = (): workspace.WorkspaceDocument => ({
  activeProjectId: null,
  chats: [],
  closedProjects: [],
  draftChatIdByProject: {},
  messagesByChatId: {},
  projects: [],
});

/** A settled document with one project showing one chat. */
const seededDoc = () => {
  const project = createProjectConfig("/workspace/app", SETTINGS);
  project.model = "project-model";
  const chat = createChatConfig(project, { title: "First" });
  const doc = workspace.settle(
    {
      ...emptyDoc(),
      activeProjectId: project.id,
      chats: [chat],
      messagesByChatId: { [chat.id]: [message("m1")] },
      projects: [project],
    },
    SETTINGS,
  );
  assertInvariant(doc);
  return { chat, doc, project };
};

const projectIn = (doc: workspace.WorkspaceDocument, projectId: string) => {
  const project = doc.projects.find((item) => item.id === projectId);
  assert.ok(project, "project is open");
  return project as ProjectConfig;
};

test("opening a new project gives it a default chat on the default model", () => {
  const { doc, projectId, chatId } = workspace.openProject(
    emptyDoc(),
    SETTINGS,
    "/workspace/new",
  );

  assertInvariant(doc);
  const project = projectIn(doc, projectId);
  const chat = doc.chats.find((item) => item.id === chatId) as ChatConfig;
  assert.equal(doc.activeProjectId, projectId);
  assert.equal(project.ui.activeChatId, chatId);
  assert.equal(chat.model, "gpt-5-codex");
  assert.equal(chat.permissionMode, "ask");
  assert.deepEqual(doc.messagesByChatId[chat.id], []);
  // The fresh chat is the project's draft, reused by the next "new chat".
  assert.equal(doc.draftChatIdByProject[projectId], chatId);
});

test("reopening a closed project without chats gets the same default chat as opening one", () => {
  const { doc: initial, project } = seededDoc();
  const closed = workspace.closeProject(initial, SETTINGS, project.id);
  assertInvariant(closed);
  assert.equal(closed.activeProjectId, null);
  // Its only chat is removed for good while it is closed.
  const orphaned = workspace.removeChats(
    closed,
    SETTINGS,
    closed.chats.map((chat) => chat.id),
  );
  assertInvariant(orphaned);
  assert.equal(orphaned.chats.length, 0);

  const { doc, chatId } = workspace.openProject(
    orphaned,
    SETTINGS,
    project.path,
  );

  assertInvariant(doc);
  assert.equal(doc.closedProjects.length, 0);
  assert.equal(doc.projects[0]?.id, project.id);
  const chat = doc.chats.find((item) => item.id === chatId) as ChatConfig;
  // Both paths create the chat the same way: the default model, not the
  // project's own.
  assert.equal(chat.model, "gpt-5-codex");
  assert.equal(doc.draftChatIdByProject[project.id], chatId);
});

test("opening an open project brings it forward and keeps its chats", () => {
  const { chat, doc: initial, project } = seededDoc();
  const other = workspace.openProject(initial, SETTINGS, "/workspace/other");
  assert.equal(other.doc.activeProjectId, other.projectId);

  const { doc } = workspace.openProject(other.doc, SETTINGS, project.path);

  assertInvariant(doc);
  assert.equal(doc.activeProjectId, project.id);
  assert.equal(doc.projects.length, 2);
  assert.equal(projectIn(doc, project.id).ui.activeChatId, chat.id);
  assert.equal(doc.chats, other.doc.chats);

  const background = workspace.openProject(doc, SETTINGS, "/workspace/third", {
    activate: false,
  });
  assertInvariant(background.doc);
  assert.equal(background.doc.activeProjectId, project.id);
});

test("a seeded chat is shown alone and is not the project's draft", () => {
  const { doc: initial, project } = seededDoc();
  const worktree = createProjectConfig("/workspace/wt", SETTINGS);
  let seeded: ChatConfig | null = null;

  const { doc, chatId, projectId } = workspace.openProject(
    initial,
    SETTINGS,
    worktree.path,
    {
      create: (created) => ({ ...created, name: `${project.name} / wt` }),
      seed: (created) => {
        seeded = createChatConfig(created, { title: "Branched" });
        return { chat: seeded, messages: [message("m1"), message("m2")] };
      },
    },
  );

  assertInvariant(doc);
  assert.equal(chatId, (seeded as ChatConfig | null)?.id);
  const opened = projectIn(doc, projectId);
  assert.equal(opened.name, `${project.name} / wt`);
  assert.deepEqual(opened.ui.openChatIds, [chatId]);
  assert.equal(doc.messagesByChatId[chatId ?? ""]?.length, 2);
  assert.equal(doc.draftChatIdByProject[projectId], null);
  // Only the seeded chat was added: no default chat on top of it.
  assert.equal(liveChatsOf(doc, projectId).length, 1);
});

test("closing the active project shows the next one and keeps the closed one's chats", () => {
  const { chat, doc: initial, project } = seededDoc();
  const other = workspace.openProject(initial, SETTINGS, "/workspace/other", {
    activate: false,
  });

  const doc = workspace.closeProject(other.doc, SETTINGS, project.id);

  assertInvariant(doc);
  assert.equal(doc.activeProjectId, other.projectId);
  assert.equal(doc.projects.length, 1);
  assert.equal(doc.closedProjects[0]?.id, project.id);
  assert.equal(doc.closedProjects[0]?.ui.activeChatId, chat.id);
  assert.ok(doc.chats.some((item) => item.id === chat.id));
});

test("settle leaves untouched projects with their identity", () => {
  const { doc: initial } = seededDoc();
  const other = workspace.openProject(initial, SETTINGS, "/workspace/other");
  const before = other.doc;

  const after = workspace.settle(before, SETTINGS);

  assert.equal(after.projects, before.projects);
  assert.equal(after.chats, before.chats);
  assert.equal(after.closedProjects, before.closedProjects);

  // A reorder keeps each project object.
  const reordered = workspace.setProjects(
    before,
    SETTINGS,
    [...before.projects].reverse(),
  );
  assertInvariant(reordered);
  assert.equal(reordered.projects[0], before.projects[1]);
  assert.equal(reordered.projects[1], before.projects[0]);
});

test("settle repairs a project whose UI names chats that are gone", () => {
  const { chat, doc, project } = seededDoc();
  const broken: workspace.WorkspaceDocument = {
    ...doc,
    activeProjectId: "missing-project",
    projects: [
      {
        ...project,
        ui: {
          ...project.ui,
          activeChatId: "missing-chat",
          chatColumnWidths: { "missing-chat": 300 },
          openChatIds: ["missing-chat", chat.id],
        },
      },
    ],
  };

  const settled = workspace.settle(broken, SETTINGS);

  assertInvariant(settled);
  assert.equal(settled.activeProjectId, project.id);
  assert.equal(settled.projects[0]?.ui.activeChatId, chat.id);
  assert.deepEqual(settled.projects[0]?.ui.openChatIds, [chat.id]);
  assert.deepEqual(settled.projects[0]?.ui.chatColumnWidths, {});
  assert.equal(settled.chats.length, 1);
});

test("activateProject ignores unknown projects and null clears the selection", () => {
  const { doc, project } = seededDoc();

  const cleared = workspace.activateProject(doc, null);
  assert.equal(cleared.activeProjectId, null);
  const restored = workspace.activateProject(cleared, project.id);
  assert.equal(restored.activeProjectId, project.id);
  assert.ok(
    Date.parse(restored.projects[0]?.lastUsedAt ?? "") >=
      Date.parse(project.lastUsedAt ?? ""),
  );
  const fallback = workspace.activateProject(cleared, "missing");
  assert.equal(fallback.activeProjectId, project.id);
});

test("addChat creates a draft once and shows it again until it has messages", () => {
  const { chat: first, doc: initial, project } = seededDoc();

  const added = workspace.addChat(initial, SETTINGS, project.id, {
    title: "Second",
  });
  assertInvariant(added.doc);
  assert.equal(added.doc.chats.length, 2);
  assert.deepEqual(projectIn(added.doc, project.id).ui.openChatIds, [
    added.chatId,
  ]);
  assert.equal(added.doc.draftChatIdByProject[project.id], added.chatId);

  // Back to the first chat, then "new chat" again: the draft is reused.
  const refocused = workspace.focusChat(
    added.doc,
    SETTINGS,
    project.id,
    first.id,
  );
  assertInvariant(refocused);
  const again = workspace.addChat(refocused, SETTINGS, project.id);
  assertInvariant(again.doc);
  assert.equal(again.chatId, added.chatId);
  assert.equal(again.doc.chats.length, 2);
  assert.equal(projectIn(again.doc, project.id).ui.activeChatId, added.chatId);

  const forced = workspace.addChat(again.doc, SETTINGS, project.id, {
    forceNew: true,
  });
  assertInvariant(forced.doc);
  assert.equal(forced.doc.chats.length, 3);
  assert.equal(forced.doc.draftChatIdByProject[project.id], forced.chatId);

  const unknown = workspace.addChat(forced.doc, SETTINGS, "missing");
  assert.equal(unknown.chatId, null);
  assert.equal(unknown.doc, forced.doc);
});

test("addChatBeside opens a column and branchChat inserts after its source", () => {
  const { chat: first, doc: initial, project } = seededDoc();

  const beside = workspace.addChatBeside(initial, SETTINGS, project.id);
  assertInvariant(beside.doc);
  const ui = projectIn(beside.doc, project.id).ui;
  assert.equal(ui.multiChat, true);
  assert.deepEqual(ui.openChatIds, [first.id, beside.chatId]);
  assert.equal(ui.activeChatId, beside.chatId);

  const branched = createChatConfig(project, { title: "Branch of first" });
  const doc = workspace.branchChat(
    beside.doc,
    SETTINGS,
    { chat: branched, messages: [message("m1")] },
    first.id,
  );
  assertInvariant(doc);
  assert.deepEqual(projectIn(doc, project.id).ui.openChatIds, [
    first.id,
    branched.id,
    beside.chatId,
  ]);
  assert.equal(projectIn(doc, project.id).ui.activeChatId, branched.id);
  assert.equal(doc.messagesByChatId[branched.id]?.length, 1);

  // Outside multi-chat a branch shows alone.
  const single = workspace.toggleMultiChat(doc, SETTINGS, project.id);
  assertInvariant(single);
  const another = createChatConfig(project, { title: "Another branch" });
  const soloDoc = workspace.branchChat(
    single,
    SETTINGS,
    { chat: another, messages: [] },
    first.id,
  );
  assertInvariant(soloDoc);
  assert.deepEqual(projectIn(soloDoc, project.id).ui.openChatIds, [another.id]);
});

test("focusChat falls back to a live chat when the id is not one", () => {
  const { chat, doc, project } = seededDoc();

  const focused = workspace.focusChat(doc, SETTINGS, project.id, "missing");

  assertInvariant(focused);
  assert.equal(projectIn(focused, project.id).ui.activeChatId, chat.id);
});

test("toggleMultiChat keeps widths when turning on and drops them when turning off", () => {
  const { chat, doc, project } = seededDoc();
  const beside = workspace.addChatBeside(doc, SETTINGS, project.id);
  const widths = { [chat.id]: 400, [beside.chatId as string]: 300 };
  const withWidths: workspace.WorkspaceDocument = {
    ...beside.doc,
    projects: beside.doc.projects.map((item) => ({
      ...item,
      ui: { ...item.ui, chatColumnWidths: widths },
    })),
  };

  const single = workspace.toggleMultiChat(withWidths, SETTINGS, project.id);
  assertInvariant(single);
  assert.equal(projectIn(single, project.id).ui.multiChat, false);
  assert.deepEqual(projectIn(single, project.id).ui.chatColumnWidths, {});
  assert.deepEqual(projectIn(single, project.id).ui.openChatIds, [
    beside.chatId,
  ]);

  const multi = workspace.toggleMultiChat(single, SETTINGS, project.id);
  assertInvariant(multi);
  assert.equal(projectIn(multi, project.id).ui.multiChat, true);
});

test("deleteChat hands focus to the neighbour, and the last chat's deletion makes a fresh one", () => {
  const { chat: first, doc: initial, project } = seededDoc();
  const second = workspace.addChatBeside(initial, SETTINGS, project.id);
  const third = workspace.addChatBeside(second.doc, SETTINGS, project.id);
  const focusedMiddle = workspace.focusChat(
    third.doc,
    SETTINGS,
    project.id,
    second.chatId,
  );

  const afterMiddle = workspace.deleteChat(
    focusedMiddle,
    SETTINGS,
    second.chatId as string,
  );
  assertInvariant(afterMiddle);
  assert.deepEqual(projectIn(afterMiddle, project.id).ui.openChatIds, [
    first.id,
    third.chatId,
  ]);
  // The chat to the right of the deleted one takes its place.
  assert.equal(
    projectIn(afterMiddle, project.id).ui.activeChatId,
    third.chatId,
  );
  assert.ok(
    afterMiddle.chats.find((chat) => chat.id === second.chatId)?.deletedAt,
  );
  // The draft is the chat added last, which is still there.
  assert.equal(afterMiddle.draftChatIdByProject[project.id], third.chatId);

  const afterThird = workspace.deleteChat(
    afterMiddle,
    SETTINGS,
    third.chatId as string,
  );
  assertInvariant(afterThird);
  assert.equal(projectIn(afterThird, project.id).ui.activeChatId, first.id);
  // Deleting the draft forgets it.
  assert.equal(afterThird.draftChatIdByProject[project.id], null);

  const afterAll = workspace.deleteChat(afterThird, SETTINGS, first.id);
  assertInvariant(afterAll);
  const replacement = projectIn(afterAll, project.id).ui.activeChatId;
  assert.ok(replacement && replacement !== first.id);
  assert.equal(afterAll.draftChatIdByProject[project.id], replacement);
  assert.equal(liveChatsOf(afterAll, project.id).length, 1);

  assert.equal(workspace.deleteChat(afterAll, SETTINGS, "missing"), afterAll);
});

test("deleting a chat of a closed project trims its UI without creating a chat", () => {
  const { chat, doc: initial, project } = seededDoc();
  const other = workspace.openProject(initial, SETTINGS, "/workspace/other");
  const closed = workspace.closeProject(other.doc, SETTINGS, project.id);

  const doc = workspace.deleteChat(closed, SETTINGS, chat.id);

  assertInvariant(doc);
  assert.equal(liveChatsOf(doc, project.id).length, 0);
  assert.deepEqual(doc.closedProjects[0]?.ui.openChatIds, []);
  assert.equal(doc.closedProjects[0]?.ui.activeChatId, null);
});

test("removeChats drops chats and transcripts and restoreChats brings soft-deleted ones back", () => {
  const { chat: first, doc: initial, project } = seededDoc();
  const second = workspace.addChat(initial, SETTINGS, project.id, {
    title: "Second",
  });
  const deleted = workspace.deleteChat(second.doc, SETTINGS, first.id);
  assertInvariant(deleted);

  const restored = workspace.restoreChats(deleted, SETTINGS, [first.id]);
  assertInvariant(restored);
  assert.equal(
    restored.chats.find((chat) => chat.id === first.id)?.deletedAt,
    null,
  );

  const removed = workspace.removeChats(restored, SETTINGS, [
    second.chatId as string,
  ]);
  assertInvariant(removed);
  assert.equal(removed.chats.length, 1);
  assert.equal(removed.messagesByChatId[second.chatId as string], undefined);
  assert.equal(removed.draftChatIdByProject[project.id], null);
  assert.equal(projectIn(removed, project.id).ui.activeChatId, first.id);

  assert.equal(workspace.removeChats(removed, SETTINGS, ["missing"]), removed);
});

test("removing every chat of an open project leaves it with a fresh one", () => {
  const { chat, doc: initial, project } = seededDoc();

  const doc = workspace.removeChats(initial, SETTINGS, [chat.id]);

  assertInvariant(doc);
  assert.equal(doc.chats.length, 1);
  assert.notEqual(doc.chats[0]?.id, chat.id);
  assert.equal(projectIn(doc, project.id).ui.activeChatId, doc.chats[0]?.id);
});

// ---------------------------------------------------------------------------
// Removals and hosts' catalogs
// ---------------------------------------------------------------------------

const LOCAL = "local";

/** Two open projects, the second active, each showing one chat. */
const twoProjectDoc = () => {
  const { chat: firstChat, doc: seeded, project: first } = seededDoc();
  const opened = workspace.openProject(seeded, SETTINGS, "/workspace/other");
  assertInvariant(opened.doc);
  return {
    doc: opened.doc,
    first,
    firstChat,
    secondChatId: opened.chatId as string,
    secondId: opened.projectId,
  };
};

test("removeProjects takes projects and their chats out, reports both, and hands the active project over", () => {
  const { doc, first, secondChatId, secondId } = twoProjectDoc();
  assert.equal(doc.activeProjectId, secondId);
  assert.equal(doc.draftChatIdByProject[secondId], secondChatId);

  const removal = workspace.removeProjects(doc, SETTINGS, [secondId]);

  assertInvariant(removal.doc);
  assert.deepEqual(removal.removedProjectIds, [secondId]);
  assert.deepEqual(removal.removedChatIds, [secondChatId]);
  assert.deepEqual(
    removal.doc.projects.map((project) => project.id),
    [first.id],
  );
  assert.equal(removal.doc.activeProjectId, first.id);
  assert.equal(
    Object.hasOwn(removal.doc.draftChatIdByProject, secondId),
    false,
  );
  assert.equal(
    Object.hasOwn(removal.doc.messagesByChatId, secondChatId),
    false,
  );
});

test("removeProjects with no known id changes nothing", () => {
  const { doc } = seededDoc();
  const removal = workspace.removeProjects(doc, SETTINGS, ["nope"]);
  assert.equal(removal.doc, doc);
  assert.deepEqual(removal.removedProjectIds, []);
  assert.deepEqual(removal.removedChatIds, []);
});

test("removeHostProjects removes only that host's projects, open or closed", () => {
  const { doc: local, project } = seededDoc();
  const remote = workspace.openProject(local, SETTINGS, "/srv/app", {
    hostId: "devbox",
  });
  const withOld = workspace.openProject(remote.doc, SETTINGS, "/srv/old", {
    hostId: "devbox",
  });
  const remoteClosed = workspace.closeProject(
    withOld.doc,
    SETTINGS,
    withOld.projectId,
  );
  assert.equal(remoteClosed.closedProjects.length, 1);

  const removal = workspace.removeHostProjects(
    remoteClosed,
    SETTINGS,
    "devbox",
  );

  assertInvariant(removal.doc);
  assert.deepEqual(
    [...removal.doc.projects, ...removal.doc.closedProjects].map(
      (item) => item.id,
    ),
    [project.id],
  );
  assert.equal(removal.removedProjectIds.length, 2);
  assert.equal(removal.doc.activeProjectId, project.id);
});

test("a host removing an open project's last chat leaves the project a fresh draft", () => {
  const { chat, doc, project } = seededDoc();

  const removal = workspace.applyCatalogChanges(doc, SETTINGS, LOCAL, {
    removedChatIds: [chat.id],
  });

  assertInvariant(removal.doc);
  assert.deepEqual(removal.removedChatIds, [chat.id]);
  const fresh = liveChatsOf(removal.doc, project.id);
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0]?.id, chat.id);
  assert.equal(removal.doc.draftChatIdByProject[project.id], fresh[0]?.id);
  assert.equal(Object.hasOwn(removal.doc.messagesByChatId, chat.id), false);
});

test("catalog changes keep this window's workspace fields and its new-tab view", () => {
  const { doc: seeded, project } = seededDoc();
  const doc = workspace.activateProject(seeded, null);
  const shownUi = projectIn(doc, project.id).ui;

  const removal = workspace.applyCatalogChanges(doc, SETTINGS, LOCAL, {
    projects: [{ ...project, runCommand: "pnpm start", ui: {} }],
  });

  assertInvariant(removal.doc);
  assert.equal(removal.doc.activeProjectId, null);
  const updated = removal.doc.projects[0];
  assert.equal(updated?.runCommand, "pnpm start");
  assert.deepEqual(updated?.ui, shownUi);
  assert.deepEqual(removal.removedProjectIds, []);
});

/** A settled document with two projects of two chats each. */
const twoProjectsOfTwoChats = () => {
  const { doc: seeded } = seededDoc();
  const opened = workspace.openProject(seeded, SETTINGS, "/workspace/api");
  const first = opened.doc.projects[0] as ProjectConfig;
  const second = opened.doc.projects[1] as ProjectConfig;
  const doc = workspace.settle(
    {
      ...opened.doc,
      chats: [
        ...opened.doc.chats,
        createChatConfig(first, { title: "Second" }),
        createChatConfig(second, { title: "Other" }),
      ],
    },
    SETTINGS,
  );
  assertInvariant(doc);
  return doc;
};

test("a host's change to one chat leaves every other row, and the projects, as they were", () => {
  const doc = twoProjectsOfTwoChats();
  const target = doc.chats[1] as ChatConfig;

  const removal = workspace.applyCatalogChanges(doc, SETTINGS, LOCAL, {
    chats: [{ ...target, title: "Renamed elsewhere" }],
  });

  assertInvariant(removal.doc);
  const renamed = removal.doc.chats.find((chat) => chat.id === target.id);
  assert.equal(renamed?.title, "Renamed elsewhere");
  for (const [index, chat] of removal.doc.chats.entries()) {
    if (chat.id !== target.id) assert.equal(chat, doc.chats[index]);
  }
  assert.equal(removal.doc.projects, doc.projects);
  assert.equal(removal.doc.closedProjects, doc.closedProjects);
  assert.equal(removal.doc.messagesByChatId, doc.messagesByChatId);
  assert.equal(removal.doc.draftChatIdByProject, doc.draftChatIdByProject);
});

test("a host's catalog arriving equal to what is held changes nothing", () => {
  const doc = twoProjectsOfTwoChats();
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  const removal = workspace.applyCatalogChanges(doc, SETTINGS, LOCAL, {
    chats: doc.chats.map(copy),
    projects: doc.projects.map(copy),
  });

  assert.equal(removal.doc.chats, doc.chats);
  assert.equal(removal.doc.projects, doc.projects);
  assert.deepEqual(removal.removedChatIds, []);
  assert.deepEqual(removal.removedProjectIds, []);
});

test("a held chat still leaves with its project, and an incoming project still yields to one at its path", () => {
  const doc = twoProjectsOfTwoChats();
  const [first, second] = doc.projects as [ProjectConfig, ProjectConfig];

  const removal = workspace.applyCatalogChanges(doc, SETTINGS, LOCAL, {
    projects: [{ ...createProjectConfig(second.path, SETTINGS), id: "dup" }],
    removedProjectIds: [first.id],
  });

  assertInvariant(removal.doc);
  assert.deepEqual(
    removal.doc.projects.map((project) => project.id),
    [second.id],
  );
  assert.equal(removal.doc.projects[0], second);
  assert.equal(
    removal.doc.chats.some((chat) => chat.projectId === first.id),
    false,
  );
});

test("another host's catalog never removes a local project", () => {
  const { chat, doc, project } = seededDoc();

  const removal = workspace.applyCatalogChanges(doc, SETTINGS, "devbox", {
    removedChatIds: [chat.id],
    removedProjectIds: [project.id],
  });

  assert.deepEqual(removal.removedProjectIds, []);
  assert.deepEqual(removal.removedChatIds, []);
});

test("loading a host's catalog reports that host's projects it no longer has", () => {
  const { doc: local, project } = seededDoc();
  const remote = workspace.openProject(local, SETTINGS, "/srv/gone", {
    hostId: "devbox",
  });
  const remoteChatId = remote.chatId as string;

  const removal = workspace.loadHostCatalog(remote.doc, SETTINGS, "devbox", {
    catalog: { chats: [], projects: [] },
    workspaceProjects: [],
  });

  assertInvariant(removal.doc);
  assert.deepEqual(removal.removedProjectIds, [remote.projectId]);
  assert.deepEqual(removal.removedChatIds, [remoteChatId]);
  assert.deepEqual(
    removal.doc.projects.map((item) => item.id),
    [project.id],
  );
});

test("adoptProject puts the host's project in the refused one's place with its chats and draft", () => {
  const { doc: local, project: localProject } = seededDoc();
  const refused = workspace.openProject(local, SETTINGS, "/srv/app", {
    hostId: "devbox",
  });
  const draftId = refused.chatId as string;
  const kept = { ...createProjectConfig("/srv/app", SETTINGS), name: "App" };

  const removal = workspace.adoptProject(
    refused.doc,
    SETTINGS,
    "devbox",
    refused.projectId,
    kept as unknown as Record<string, unknown> & { id: string },
  );

  assertInvariant(removal.doc);
  assert.deepEqual(
    removal.doc.projects.map((item) => item.id),
    [localProject.id, kept.id],
  );
  assert.equal(removal.doc.projects[1]?.hostId, "devbox");
  assert.equal(removal.doc.projects[1]?.name, "App");
  assert.equal(removal.doc.activeProjectId, kept.id);
  assert.equal(
    removal.doc.chats.find((chat) => chat.id === draftId)?.projectId,
    kept.id,
  );
  assert.equal(removal.doc.draftChatIdByProject[kept.id], draftId);
  assert.deepEqual(removal.removedProjectIds, [refused.projectId]);
  assert.deepEqual(removal.removedChatIds, []);
});

test("restore registers each project's empty active chat as its draft", () => {
  const fresh = createProjectConfig("/workspace/fresh", SETTINGS);
  const used = createProjectConfig("/workspace/used", SETTINGS);
  const freshChat = createChatConfig(fresh, { title: "Fresh" });
  const usedChat = {
    ...createChatConfig(used, { title: "Used" }),
    messageCount: 3,
  };

  const doc = workspace.restore(
    {
      activeProjectId: null,
      chats: [freshChat, usedChat],
      closedProjects: [],
      messagesByChatId: {},
      projects: [
        { ...fresh, ui: { ...fresh.ui, activeChatId: freshChat.id } },
        { ...used, ui: { ...used.ui, activeChatId: usedChat.id } },
      ],
    },
    SETTINGS,
  );

  assertInvariant(doc);
  assert.equal(doc.activeProjectId, fresh.id);
  assert.deepEqual(doc.draftChatIdByProject, { [fresh.id]: freshChat.id });
});

// ---------------------------------------------------------------------------
// Chat columns
// ---------------------------------------------------------------------------

/** One project showing three chats side by side, the middle one active. */
const columnsDoc = () => {
  const { doc: seeded, project } = seededDoc();
  let doc = workspace.toggleMultiChat(seeded, SETTINGS, project.id);
  const second = workspace.addChatBeside(doc, SETTINGS, project.id);
  const third = workspace.addChatBeside(second.doc, SETTINGS, project.id);
  doc = workspace.focusChat(
    third.doc,
    SETTINGS,
    project.id,
    second.chatId as string,
  );
  const ids = projectIn(doc, project.id).ui.openChatIds;
  assert.equal(ids.length, 3);
  assertInvariant(doc);
  return { doc, ids, projectId: project.id };
};

test("closing the active column hands focus to the one that took its place", () => {
  const { doc, ids, projectId } = columnsDoc();

  const closed = workspace.closeChatColumn(
    doc,
    SETTINGS,
    projectId,
    ids[1] as string,
  );

  assertInvariant(closed);
  const ui = projectIn(closed, projectId).ui;
  assert.deepEqual(ui.openChatIds, [ids[0], ids[2]]);
  assert.equal(ui.activeChatId, ids[2]);
  // The chat itself stays; only its column closed.
  assert.ok(closed.chats.some((chat) => chat.id === ids[1]));
});

test("the last open column cannot be closed", () => {
  const { chat, doc, project } = seededDoc();
  assert.equal(
    workspace.closeChatColumn(doc, SETTINGS, project.id, chat.id),
    doc,
  );
});

test("reordering columns moves one and keeps the active chat", () => {
  const { doc, ids, projectId } = columnsDoc();

  const moved = workspace.reorderChatColumns(doc, SETTINGS, projectId, 0, 2);

  assertInvariant(moved);
  const ui = projectIn(moved, projectId).ui;
  assert.deepEqual(ui.openChatIds, [ids[1], ids[2], ids[0]]);
  assert.equal(ui.activeChatId, ids[1]);
  assert.equal(
    workspace.reorderChatColumns(doc, SETTINGS, projectId, 0, 9),
    doc,
  );
});

test("column widths are kept only for open chats", () => {
  const { doc, ids, projectId } = columnsDoc();

  const sized = workspace.setChatColumnWidths(doc, SETTINGS, projectId, {
    [ids[0] as string]: 320,
    gone: 400,
  });

  assertInvariant(sized);
  assert.deepEqual(projectIn(sized, projectId).ui.chatColumnWidths, {
    [ids[0] as string]: 320,
  });
});
