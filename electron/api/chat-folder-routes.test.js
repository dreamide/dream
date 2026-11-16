import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createChatFolder,
  getChatFolderName,
  getChatFoldersRoot,
  sweepChatFolders,
} from "../host/chat-folders.js";
import { registerChatFolderRoutes } from "./chat-folder-routes.js";

const createHome = () => mkdtemp(path.join(os.tmpdir(), "dream-chat-home-"));

const noGit = async () => null;

const create = (home, body, options = {}) => {
  const app = new Hono();
  registerChatFolderRoutes(app, { findGitTopLevel: noGit, home, ...options });
  return app.request("/api/chat-folders", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
};

test("names a chat folder after the local date and the Project id's start", () => {
  expect(
    getChatFolderName(
      "1a2b3c4d-0000-4000-8000-000000000000",
      new Date(2026, 0, 5),
    ),
  ).toBe("2026-01-05-1a2b3c4d");
});

test("creates an empty folder under ~/.dream/chats and returns its path", async () => {
  const home = await createHome();

  const response = await create(home, {
    projectId: "1a2b3c4d-0000-4000-8000-000000000000",
  });

  expect(response.status).toBe(200);
  const { path: folder } = await response.json();
  expect(path.dirname(folder)).toBe(path.join(home, ".dream", "chats"));
  expect(path.basename(folder)).toMatch(/^\d{4}-\d{2}-\d{2}-1a2b3c4d$/);
  expect((await stat(folder)).isDirectory()).toBe(true);
  expect(await readdir(folder)).toEqual([]);
});

test("distinct Projects get distinct folders; an existing folder is refused", async () => {
  const home = await createHome();
  const now = new Date(2026, 10, 16);

  const first = await createChatFolder({
    findGitTopLevel: noGit,
    home,
    now,
    projectId: "aaaaaaaa-1",
  });
  const second = await createChatFolder({
    findGitTopLevel: noGit,
    home,
    now,
    projectId: "bbbbbbbb-1",
  });
  expect(first.path).not.toBe(second.path);

  // Same date and id prefix as `first`: its folder is never handed out again.
  await expect(
    createChatFolder({
      findGitTopLevel: noGit,
      home,
      now,
      projectId: "aaaaaaaa-2",
    }),
  ).rejects.toMatchObject({ code: "exists" });
});

test("refuses, naming the repository, when the root is inside a git work tree", async () => {
  const home = await createHome();
  const findGitTopLevel = async (folder) => {
    // The root does not exist yet: the check starts from home.
    expect(folder).toBe(home);
    return home;
  };

  const response = await create(
    home,
    { projectId: "1a2b3c4d" },
    { findGitTopLevel },
  );

  expect(response.status).toBe(409);
  expect(await response.text()).toContain(home);
  await expect(stat(getChatFoldersRoot(home))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("the default check finds a real git repository around the root", async () => {
  const home = await createHome();
  try {
    execFileSync("git", ["init", "-q", home]);
  } catch {
    return; // No git on this machine: nothing to find.
  }
  await mkdir(path.join(home, ".dream"));

  await expect(
    createChatFolder({ home, projectId: "1a2b3c4d" }),
  ).rejects.toMatchObject({ code: "inside-git" });
});

test("a projectId that cannot name a folder is rejected", async () => {
  const home = await createHome();

  for (const projectId of ["../escape", "short", ""]) {
    const response = await create(home, { projectId });
    expect(response.status).toBe(400);
  }
});

describe("sweeping chat folders", () => {
  const HOUR = 60 * 60 * 1000;
  const catalogOf = (paths) => ({
    list: async () => ({ projects: paths.map((path) => ({ path })) }),
  });
  const folderIn = async (home, name, files = []) => {
    const folder = path.join(getChatFoldersRoot(home), name);
    await mkdir(folder, { recursive: true });
    for (const file of files) {
      const target = path.join(folder, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "x");
    }
    return folder;
  };
  const exists = (folder) =>
    stat(folder).then(
      () => true,
      () => false,
    );

  test("removes empty and node_modules-only folders no Project owns", async () => {
    const home = await createHome();
    const empty = await folderIn(home, "2026-11-01-aaaaaaaa");
    const modules = await folderIn(home, "2026-11-01-bbbbbbbb", [
      "node_modules/pkg/index.js",
    ]);

    const removed = await sweepChatFolders(catalogOf([]), {
      home,
      now: Date.now() + 2 * HOUR,
    });

    expect(removed.sort()).toEqual([empty, modules].sort());
    expect(await exists(empty)).toBe(false);
    expect(await exists(modules)).toBe(false);
  });

  test("keeps a folder holding anything else, even with no Project", async () => {
    const home = await createHome();
    const kept = await folderIn(home, "2026-11-01-cccccccc", [
      "notes.md",
      "node_modules/pkg/index.js",
    ]);

    await sweepChatFolders(catalogOf([]), { home, now: Date.now() + 2 * HOUR });

    expect(await exists(kept)).toBe(true);
  });

  test("never removes a folder a Project owns, standalone or promoted", async () => {
    const home = await createHome();
    const owned = await folderIn(home, "2026-11-01-dddddddd");

    await sweepChatFolders(catalogOf([owned]), {
      home,
      now: Date.now() + 2 * HOUR,
    });

    expect(await exists(owned)).toBe(true);
  });

  test("skips folders younger than the grace period", async () => {
    const home = await createHome();
    const fresh = await folderIn(home, "2026-11-16-eeeeeeee");

    expect(await sweepChatFolders(catalogOf([]), { home })).toEqual([]);
    expect(await exists(fresh)).toBe(true);
  });

  test("does not follow a symlink out of the root", async () => {
    const home = await createHome();
    const outside = await mkdtemp(path.join(os.tmpdir(), "dream-outside-"));
    await mkdir(getChatFoldersRoot(home), { recursive: true });
    const link = path.join(getChatFoldersRoot(home), "2026-11-01-ffffffff");
    try {
      await symlink(outside, link, "junction");
    } catch {
      return; // No permission to make links here.
    }

    await sweepChatFolders(catalogOf([]), { home, now: Date.now() + 2 * HOUR });

    expect(await exists(outside)).toBe(true);
  });

  test("a missing root is nothing to sweep", async () => {
    const home = await createHome();
    expect(await sweepChatFolders(catalogOf([]), { home })).toEqual([]);
  });
});
