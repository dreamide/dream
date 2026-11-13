// Each host's catalog baseline, through its interface, over fake catalog
// routes per host: what a baseline holds, what a save sends and to whom,
// and what forgetting a host leaves.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { setHostResolver } from "@/lib/host-routing";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { catalogStateOn, createCatalogBaselines } from "./catalog-baselines";
import type { CatalogChangeSet, CatalogConflict } from "./catalog-sync";

afterEach(() => setHostResolver(() => "local"));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const project = (path: string, hostId?: string): ProjectConfig => ({
  ...createProjectConfig(path, DEFAULT_SETTINGS),
  ...(hostId ? { hostId } : {}),
});
const chat = (owner: ProjectConfig, title = "Chat"): ChatConfig =>
  createChatConfig(owner, { title }) as ChatConfig;

/** Baselines over routes that record what each host was sent. */
const setup = ({ conflicts = [] as CatalogConflict[] } = {}) => {
  const sent: { hostId: string; changes: CatalogChangeSet }[] = [];
  const transcripts: { hostId: string; payload: unknown }[] = [];
  const refused: { hostId: string; conflicts: CatalogConflict[] }[] = [];
  const baselines = createCatalogBaselines({
    onConflicts: (hostId, found) => refused.push({ conflicts: found, hostId }),
    routesFor: (hostId) => ({
      catalogChanges: vi.fn(async (changes) => {
        sent.push({ changes, hostId });
        return {
          chatIds: [],
          conflicts,
          projectIds: [],
          removedChatIds: [],
          removedProjectIds: [],
        };
      }),
      saveCatalogTranscript: vi.fn(async (payload) => {
        transcripts.push({ hostId, payload });
        return { saved: true };
      }),
    }),
  });
  return { baselines, refused, sent, transcripts };
};

// The local host's project and chat, and a project an SSH host owns, shown
// here from its snapshot.
const local = project("/local/app");
const localChat = chat(local);
const remote = project("/srv/app", "devbox");
const remoteChat = chat(remote);
const shown = {
  chats: [localChat, remoteChat],
  closedProjects: [],
  projects: [local, remote],
};

test("a host's part of the store is its own projects and their chats, nothing else", () => {
  assert.deepEqual(catalogStateOn("local", shown), {
    chats: [localChat],
    closedProjects: [],
    projects: [local],
  });
  assert.deepEqual(catalogStateOn("devbox", shown), {
    chats: [remoteChat],
    closedProjects: [],
    projects: [remote],
  });
});

test("a baseline holds only its host's part, so another host's snapshot is never removed from it", async () => {
  const { baselines, sent } = setup();
  baselines.adopt("local", shown);

  assert.equal(baselines.hasBaseline("local"), true);
  assert.equal(baselines.hasBaseline("devbox"), false);
  assert.equal(baselines.sync("local").isSynced("project", local.id), true);
  assert.equal(baselines.sync("local").isSynced("project", remote.id), false);

  // Saving the same state sends nothing: the local host already has it, and
  // the SSH host's project is not the local host's to remove or send.
  baselines.push(shown, shown);
  await flush();
  assert.deepEqual(sent, []);
});

test("a chat added after the catalog loaded is new to its host and is sent", async () => {
  const { baselines, sent } = setup();
  baselines.adopt("local", shown);
  const added = chat(local, "Added on restore");
  const now = { ...shown, chats: [...shown.chats, added] };

  baselines.push(now, now);
  await flush();
  assert.deepEqual(
    sent.map(({ changes, hostId }) => [
      hostId,
      changes.chats.map((sentChat: ChatConfig) => sentChat.id),
    ]),
    [["local", [added.id]]],
  );
});

test("a save goes only to hosts with a baseline, each with its own part", async () => {
  const { baselines, sent } = setup();
  baselines.adopt("local", { chats: [], closedProjects: [], projects: [] });

  baselines.push(shown, shown);
  await flush();
  assert.deepEqual(
    sent.map(({ hostId }) => hostId),
    ["local"],
  );
  assert.deepEqual(
    sent[0].changes.projects.map(
      (sentProject: ProjectConfig) => sentProject.id,
    ),
    [local.id],
  );

  baselines.adopt("devbox", { chats: [], closedProjects: [], projects: [] });
  assert.deepEqual([...baselines.hostIds()].sort(), ["devbox", "local"]);
});

test("forgetting a host drops its baseline and its link to the host", () => {
  const { baselines } = setup();
  baselines.adopt("devbox", shown);
  const link = baselines.sync("devbox");

  baselines.forget("devbox");
  assert.equal(baselines.hasBaseline("devbox"), false);
  assert.equal(baselines.hostIds().has("devbox"), false);
  // A link made later starts from nothing.
  assert.notEqual(baselines.sync("devbox"), link);
  assert.equal(baselines.sync("devbox").isSynced("project", remote.id), false);
});

test("projects a host refuses are reported with the host that refused them", async () => {
  const conflict = { existingId: "kept", id: local.id, path: local.path };
  const { baselines, refused } = setup({ conflicts: [conflict] });
  baselines.adopt("local", { chats: [], closedProjects: [], projects: [] });

  baselines.push(shown, shown);
  await flush();
  assert.deepEqual(refused, [{ conflicts: [conflict], hostId: "local" }]);
});

test("a transcript is saved on the host of its chat's project", async () => {
  const { baselines, transcripts } = setup();
  setHostResolver((hint) =>
    hint.chatId === remoteChat.id ? "devbox" : "local",
  );

  await baselines.saveTranscript(remoteChat.id, []);
  assert.deepEqual(
    transcripts.map(({ hostId }) => hostId),
    ["devbox"],
  );
});
