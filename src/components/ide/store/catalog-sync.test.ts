import { expect, test, vi } from "vitest";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { createChatConfig } from "../../../../electron/shared/persisted-state-codec.js";
import { type CatalogState, createCatalogSync } from "./catalog-sync";

const setup = () => {
  const sent: unknown[] = [];
  const api = {
    catalogChanges: vi.fn(async (changes: unknown) => {
      sent.push(changes);
      return {
        chatIds: [],
        conflicts: [],
        projectIds: [],
        removedChatIds: [],
        removedProjectIds: [],
      };
    }),
    saveCatalogTranscript: vi.fn(async () => ({ saved: true })),
  };
  return { api, sent, sync: createCatalogSync({ api }) };
};

const project = (path: string): ProjectConfig =>
  createProjectConfig(path, DEFAULT_SETTINGS);

const chat = (owner: ProjectConfig, title = "Chat"): ChatConfig => ({
  ...(createChatConfig(owner, { title }) as ChatConfig),
});

const state = (
  projects: ProjectConfig[],
  chats: ChatConfig[] = [],
  closedProjects: ProjectConfig[] = [],
): CatalogState => ({ chats, closedProjects, projects });

test("only what changed since the host confirmed it is sent", async () => {
  const { sent, sync } = setup();
  const a = project("/work/a");
  const first = chat(a);
  sync.reset(state([a], [first]));

  const renamed = { ...first, title: "Renamed" };
  await sync.push(state([a], [renamed]), state([a], [renamed]));
  await sync.push(state([a], [renamed]), state([a], [renamed]));

  expect(sent).toEqual([
    {
      chats: [renamed],
      projects: [],
      removedChatIds: [],
      removedProjectIds: [],
    },
  ]);
});

test("a new message count alone is not worth sending", async () => {
  const { sent, sync } = setup();
  const a = project("/work/a");
  const first = chat(a);
  sync.reset(state([a], [first]));

  const counted = { ...first, messageCount: 7 };
  await sync.push(state([a], [counted]), state([a], [counted]));

  expect(sent).toEqual([]);
});

test("only a synced item that left the store is removed", async () => {
  const { sent, sync } = setup();
  const a = project("/work/a");
  const mine = chat(a, "Mine");
  const theirs = chat(a, "Theirs (an empty draft my encoder drops)");
  sync.reset(state([a], [mine, theirs]));

  // `theirs` is still in the store, just not in what I would save.
  await sync.push(state([a], [theirs]), state([a], []));

  expect(sent).toEqual([
    {
      chats: [],
      projects: [],
      removedChatIds: [mine.id],
      removedProjectIds: [],
    },
  ]);
});

test("a failed send is retried by the next save", async () => {
  const { api, sent, sync } = setup();
  const a = project("/work/a");
  sync.reset(state([]));
  api.catalogChanges.mockRejectedValueOnce(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await sync.push(state([a]), state([a]));
  await sync.push(state([a]), state([a]));

  expect(api.catalogChanges).toHaveBeenCalledTimes(2);
  expect(sent).toHaveLength(1);
  warn.mockRestore();
});

test("a transcript waits for the changes sent before it", async () => {
  const { api, sync } = setup();
  const order: string[] = [];
  let release: () => void = () => {};
  api.catalogChanges.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => {
          order.push("changes");
          resolve({
            chatIds: [],
            conflicts: [],
            projectIds: [],
            removedChatIds: [],
            removedProjectIds: [],
          });
        };
      }),
  );
  api.saveCatalogTranscript.mockImplementationOnce(async () => {
    order.push("transcript");
    return { saved: true };
  });
  const a = project("/work/a");
  sync.reset(state([]));

  const changes = sync.push(state([a]), state([a]));
  const transcript = sync.saveTranscript("c1", []);
  await Promise.resolve();
  release();
  await Promise.all([changes, transcript]);

  expect(order).toEqual(["changes", "transcript"]);
});

test("changes heard from the host are not sent back", async () => {
  const { sent, sync } = setup();
  const a = project("/work/a");
  sync.reset(state([a]));

  const fromElsewhere = chat(a, "From another window");
  sync.remember({ chats: [fromElsewhere] });
  await sync.push(state([a], [fromElsewhere]), state([a], [fromElsewhere]));

  expect(sent).toEqual([]);
});
