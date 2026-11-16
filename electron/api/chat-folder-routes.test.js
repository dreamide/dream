import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, test } from "vitest";
import {
  createChatFolder,
  getChatFolderName,
  getChatFoldersRoot,
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
