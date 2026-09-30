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
