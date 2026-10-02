import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, test } from "vitest";
import {
  registerHostDirectoryRoutes,
  resolveHostDirectory,
} from "./host-directory-routes.js";

const createHome = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dream-host-home-"));
  await mkdir(path.join(home, "projects", "app"), { recursive: true });
  await mkdir(path.join(home, "Beta"));
  await mkdir(path.join(home, ".config"));
  await writeFile(path.join(home, "notes.txt"), "not a folder");
  return home;
};

const list = (home, body) => {
  const app = new Hono();
  registerHostDirectoryRoutes(app, { home });
  return app.request("/api/host-directories", {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
};

test("lists the folders of the host's home by default, without files", async () => {
  const home = await createHome();

  const response = await list(home, {});
  expect(response.status).toBe(200);
  const listing = await response.json();

  expect(listing.path).toBe(home);
  expect(listing.home).toBe(home);
  expect(listing.parent).toBe(path.dirname(home));
  expect(listing.directories.map((entry) => entry.name)).toEqual([
    ".config",
    "Beta",
    "projects",
  ]);
  expect(listing.directories[0]).toMatchObject({
    hidden: true,
    path: path.join(home, ".config"),
  });
  expect(listing.truncated).toBe(false);
});

test("a path may be absolute, ~/..., or relative to home", async () => {
  const home = await createHome();
  const projects = path.join(home, "projects");

  for (const requested of [projects, "~/projects", "projects"]) {
    const listing = await (await list(home, { path: requested })).json();
    expect(listing.path).toBe(projects);
    expect(listing.directories.map((entry) => entry.name)).toEqual(["app"]);
  }
  expect(resolveHostDirectory("~", home)).toBe(home);
  expect(resolveHostDirectory("  ", home)).toBe(home);
});

test("a missing folder or a file says so", async () => {
  const home = await createHome();

  const missing = await list(home, { path: "nowhere" });
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("No folder at");

  const file = await list(home, { path: "notes.txt" });
  expect(file.status).toBe(400);
  expect(await file.text()).toContain("is not a folder");
});

test.skipIf(process.platform === "win32")(
  "a link to a folder counts as a folder; a dangling one does not",
  async () => {
    const home = await createHome();
    await symlink(path.join(home, "projects"), path.join(home, "linked"));
    await symlink(path.join(home, "gone"), path.join(home, "dangling"));

    const listing = await (await list(home, {})).json();
    expect(listing.directories.map((entry) => entry.name)).toContain("linked");
    expect(listing.directories.map((entry) => entry.name)).not.toContain(
      "dangling",
    );
  },
);
