import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dream-test-user-data" },
}));

const {
  detectProjectFileLineEnding,
  registerProjectGitRoutes,
  serializeProjectFileContent,
} = await import("./project-git-routes.js");

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

const createProject = async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "dream-files-"));
  temporaryDirectories.push(projectPath);
  return projectPath;
};

const createApp = () => {
  const app = new Hono();
  registerProjectGitRoutes(app);
  return app;
};

const requestProjectFile = (app, projectPath, filePath) =>
  app.request("/api/project-file", {
    body: JSON.stringify({ filePath, projectPath }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

const requestProjectDirectory = (app, projectPath, directory = ".") =>
  app.request("/api/project-directory", {
    body: JSON.stringify({ directory, projectPath }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

test("project directory lists every immediate root entry", async () => {
  const projectPath = await createProject();
  await Promise.all([
    fs.mkdir(path.join(projectPath, ".git")),
    fs.mkdir(path.join(projectPath, "node_modules")),
    fs.mkdir(path.join(projectPath, "src")),
    fs.writeFile(path.join(projectPath, ".env"), "hidden\n"),
    fs.writeFile(path.join(projectPath, ".gitignore"), "ignored.txt\n"),
    fs.writeFile(path.join(projectPath, "ignored.txt"), "visible\n"),
  ]);
  await fs.writeFile(path.join(projectPath, "src", "grandchild.ts"), "");

  const response = await requestProjectDirectory(createApp(), projectPath);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    directory: ".",
    entries: [
      { kind: "directory", path: ".git" },
      { kind: "directory", path: "node_modules" },
      { kind: "directory", path: "src" },
      { kind: "file", path: ".env" },
      { kind: "file", path: ".gitignore" },
      { kind: "file", path: "ignored.txt" },
    ],
  });
});

test("project directory lists only immediate children and handles empty directories", async () => {
  const projectPath = await createProject();
  await fs.mkdir(path.join(projectPath, "parent", "child"), {
    recursive: true,
  });
  await fs.writeFile(path.join(projectPath, "parent", "child", "file.txt"), "");
  await fs.mkdir(path.join(projectPath, "empty"));
  const app = createApp();

  const parentResponse = await requestProjectDirectory(
    app,
    projectPath,
    "parent",
  );
  assert.deepEqual(await parentResponse.json(), {
    directory: "parent",
    entries: [{ kind: "directory", path: "parent/child" }],
  });

  const emptyResponse = await requestProjectDirectory(
    app,
    projectPath,
    "empty",
  );
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(await emptyResponse.json(), {
    directory: "empty",
    entries: [],
  });
});

test("project directory sorts directories before files and each group alphabetically", async () => {
  const projectPath = await createProject();
  await Promise.all([
    fs.mkdir(path.join(projectPath, "z-directory")),
    fs.mkdir(path.join(projectPath, "a-directory")),
    fs.writeFile(path.join(projectPath, "z-file.txt"), ""),
    fs.writeFile(path.join(projectPath, "a-file.txt"), ""),
  ]);

  const response = await requestProjectDirectory(createApp(), projectPath);
  const payload = await response.json();
  assert.deepEqual(
    payload.entries.map((entry) => entry.path),
    ["a-directory", "z-directory", "a-file.txt", "z-file.txt"],
  );
});

test("project directory rejects traversal and absolute paths outside the project", async () => {
  const projectPath = await createProject();
  const outsidePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "dream-outside-"),
  );
  temporaryDirectories.push(outsidePath);
  const app = createApp();

  for (const directory of ["..", outsidePath]) {
    const response = await requestProjectDirectory(app, projectPath, directory);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /outside of the project root/i);
  }
});

test.runIf(process.platform !== "win32")(
  "project directory exposes symlinks but never traverses escapes or cycles",
  async () => {
    const projectPath = await createProject();
    const outsidePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "dream-outside-"),
    );
    temporaryDirectories.push(outsidePath);
    await fs.symlink(outsidePath, path.join(projectPath, "outside-link"));
    await fs.symlink(projectPath, path.join(projectPath, "cycle"));
    const app = createApp();

    const rootResponse = await requestProjectDirectory(app, projectPath);
    assert.equal(rootResponse.status, 200);
    assert.deepEqual((await rootResponse.json()).entries, [
      { kind: "symlink", path: "cycle" },
      { kind: "symlink", path: "outside-link" },
    ]);

    for (const directory of ["outside-link", "cycle", "cycle/cycle"]) {
      const response = await requestProjectDirectory(
        app,
        projectPath,
        directory,
      );
      assert.equal(response.status, 400);
      assert.match(await response.text(), /symlink/i);
    }
  },
);

test("detects and serializes CRLF content", () => {
  assert.equal(detectProjectFileLineEnding("one\r\ntwo\r\n"), "crlf");
  assert.equal(detectProjectFileLineEnding("one\ntwo\n"), "lf");
  assert.equal(
    serializeProjectFileContent("changed\ncontent\n", "crlf"),
    "changed\r\ncontent\r\n",
  );
});

test("project file saves preserve CRLF line endings", async () => {
  const projectPath = await createProject();
  const filePath = "notes.txt";
  const absolutePath = path.join(projectPath, filePath);
  const originalContent = "first\r\nsecond\r\n";
  await fs.writeFile(absolutePath, originalContent);
  const app = createApp();

  const readResponse = await requestProjectFile(app, projectPath, filePath);
  assert.equal(readResponse.status, 200);
  const readPayload = await readResponse.json();
  assert.equal(readPayload.content, originalContent);
  assert.equal(readPayload.lineEnding, "crlf");
  assert.equal(readPayload.writable, true);

  const saveResponse = await app.request("/api/project-file", {
    body: JSON.stringify({
      content: "first changed\nsecond\n",
      expectedContent: originalContent,
      filePath,
      projectPath,
    }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  assert.equal(saveResponse.status, 200);
  const savePayload = await saveResponse.json();
  assert.equal(savePayload.content, "first changed\r\nsecond\r\n");
  assert.equal(
    await fs.readFile(absolutePath, "utf8"),
    "first changed\r\nsecond\r\n",
  );
});

test("empty text files can be loaded for editing", async () => {
  const projectPath = await createProject();
  await fs.writeFile(path.join(projectPath, "empty.unknown-extension"), "");

  const response = await requestProjectFile(
    createApp(),
    projectPath,
    "empty.unknown-extension",
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.content, "");
  assert.equal(payload.writable, true);
});

test("binary and oversized files remain unavailable", async () => {
  const projectPath = await createProject();
  await fs.writeFile(path.join(projectPath, "binary.dat"), Buffer.from([0, 1]));
  await fs.writeFile(
    path.join(projectPath, "oversized.txt"),
    Buffer.alloc(1024 * 1024 + 1, 97),
  );
  const app = createApp();

  const binaryResponse = await requestProjectFile(
    app,
    projectPath,
    "binary.dat",
  );
  assert.equal(binaryResponse.status, 415);

  const oversizedResponse = await requestProjectFile(
    app,
    projectPath,
    "oversized.txt",
  );
  assert.equal(oversizedResponse.status, 413);
});

test("external modifications cause a conflict without overwriting the file", async () => {
  const projectPath = await createProject();
  const filePath = "conflict.txt";
  const absolutePath = path.join(projectPath, filePath);
  await fs.writeFile(absolutePath, "original\n");
  const app = createApp();

  await fs.writeFile(absolutePath, "external\n");
  const response = await app.request("/api/project-file", {
    body: JSON.stringify({
      content: "local draft\n",
      expectedContent: "original\n",
      filePath,
      projectPath,
    }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });

  assert.equal(response.status, 409);
  assert.match(await response.text(), /changed on disk/i);
  assert.equal(await fs.readFile(absolutePath, "utf8"), "external\n");
});

test.runIf(process.platform !== "win32")(
  "read-only files report why editing is unavailable",
  async () => {
    const projectPath = await createProject();
    const filePath = "read-only.txt";
    const absolutePath = path.join(projectPath, filePath);
    await fs.writeFile(absolutePath, "content\n", { mode: 0o444 });
    const app = createApp();

    const response = await requestProjectFile(app, projectPath, filePath);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.writable, false);
    assert.match(payload.readOnlyReason, /permission/i);

    await fs.chmod(absolutePath, 0o644);
  },
);

test("symlinks resolving outside the project cannot be read", async () => {
  const projectPath = await createProject();
  const outsidePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "dream-outside-"),
  );
  temporaryDirectories.push(outsidePath);
  await fs.writeFile(path.join(outsidePath, "secret.txt"), "secret\n");
  await fs.symlink(
    path.join(outsidePath, "secret.txt"),
    path.join(projectPath, "link.txt"),
  );
  const app = createApp();

  const response = await requestProjectFile(app, projectPath, "link.txt");
  assert.equal(response.status, 400);
  assert.match(await response.text(), /outside of the project root/i);
});
