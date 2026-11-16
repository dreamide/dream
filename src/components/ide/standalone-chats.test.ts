import { expect, test } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ProjectConfig } from "@/types/ide";
import {
  listStandaloneChats,
  standaloneProjectsById,
} from "./standalone-chats";

const standalone = (path: string, hostId?: string): ProjectConfig => ({
  ...createProjectConfig(path, DEFAULT_SETTINGS),
  ...(hostId ? { hostId } : {}),
  standalone: { createdAt: "2026-11-16T00:00:00.000Z" },
});

test("lists live standalone chats of every Host, open or closed, pinned then newest", () => {
  const open = standalone("/chats/a");
  const closed = standalone("/chats/b", "ssh-1");
  const plain = createProjectConfig("/workspace/app", DEFAULT_SETTINGS);
  const at = (updatedAt: string) => ({ messageCount: 1, updatedAt });

  const older = {
    ...createChatConfig(open, { title: "Older" }),
    ...at("2026-11-01T00:00:00.000Z"),
  };
  const newer = {
    ...createChatConfig(closed, { title: "Newer" }),
    ...at("2026-11-10T00:00:00.000Z"),
  };
  const pinned = {
    ...createChatConfig(open, { title: "Pinned" }),
    ...at("2026-10-01T00:00:00.000Z"),
    pinned: true,
  };
  const empty = {
    ...createChatConfig(open, { title: "Empty" }),
    messageCount: 0,
  };
  const deleted = {
    ...createChatConfig(closed, { title: "Deleted" }),
    ...at("2026-11-12T00:00:00.000Z"),
    deletedAt: "2026-11-13T00:00:00.000Z",
  };
  const project = {
    ...createChatConfig(plain, { title: "Project chat" }),
    ...at("2026-11-14T00:00:00.000Z"),
  };

  const projects = standaloneProjectsById([open, plain], [closed]);
  expect([...projects.keys()]).toEqual([open.id, closed.id]);
  expect(
    listStandaloneChats(
      [older, newer, pinned, empty, deleted, project],
      projects,
    ).map((chat) => chat.title),
  ).toEqual(["Pinned", "Newer", "Older"]);
});
