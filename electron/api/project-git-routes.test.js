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
