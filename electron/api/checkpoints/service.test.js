import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, beforeAll, test, vi } from "vitest";
import { configureHostDataDirectory } from "../../host/host-paths.js";

const userDataDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), "dream-checkpoints-userdata-"),
);

configureHostDataDirectory(userDataDirectory);

const {
  captureTurnCheckpoint,
  createCheckpoint,
  deleteChatCheckpoints,
  deleteProjectCheckpoints,
  finalizeCheckpoint,
  getCheckpointFileDiff,
  getShadowRepoDirectory,
  listCheckpointChanges,
  restoreCheckpointFiles,
} = await import("./service.js");
const { registerCheckpointRoutes } = await import("../checkpoint-routes.js");
const { isCliCommandAvailable } = await import("../shared/cli.js");

let gitAvailable = false;
const temporaryDirectories = [];

// Each test runs several git commands in a fresh repository: on Windows
// under a full parallel test run that is close to the default 5 s.
vi.setConfig({ testTimeout: 20_000 });

// On Windows the lookup starts PowerShell, which can take longer than the
// default hook timeout on a busy CI runner.
beforeAll(async () => {
  gitAvailable = await isCliCommandAvailable("git");
}, 30_000);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

const createProject = async () => {
  const projectPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "dream-checkpoint-project-")),
  );
  temporaryDirectories.push(projectPath);
  return projectPath;
};

const writeProjectFile = async (projectPath, filePath, content) => {
  const absolutePath = path.join(projectPath, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
};

const readProjectFile = (projectPath, filePath) =>
  fs.readFile(path.join(projectPath, filePath), "utf8");

const fileExists = async (projectPath, filePath) => {
  try {
    await fs.access(path.join(projectPath, filePath));
    return true;
  } catch {
    return false;
  }
};

const chatId = "chat-1";

const runTurn = async (projectPath, mutate) => {
  const { checkpointId } = await createCheckpoint({ chatId, projectPath });
  await mutate();
  await finalizeCheckpoint({ chatId, checkpointId, projectPath });
  return checkpointId;
};

const byPath = (files) =>
  Object.fromEntries(files.map((file) => [file.filePath, file]));

test("checkpoint reports files added, modified, deleted and renamed in a turn", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "src/app.ts", "line 1\nline 2\n");
  await writeProjectFile(projectPath, "src/old.ts", "old\n");
  await writeProjectFile(projectPath, "README.md", "readme\n");
  await writeProjectFile(projectPath, ".gitignore", "ignored.txt\n");
  await writeProjectFile(projectPath, "ignored.txt", "ignored\n");
  await writeProjectFile(projectPath, "node_modules/pkg/index.js", "x\n");

  const checkpointId = await runTurn(projectPath, async () => {
    await writeProjectFile(projectPath, "src/app.ts", "line 1\nline two\n");
    await writeProjectFile(projectPath, "src/new.ts", "new\n");
    await fs.rm(path.join(projectPath, "README.md"));
    await fs.rename(
      path.join(projectPath, "src/old.ts"),
      path.join(projectPath, "src/renamed.ts"),
    );
    await writeProjectFile(projectPath, "ignored.txt", "changed\n");
    await writeProjectFile(projectPath, "node_modules/pkg/index.js", "y\n");
  });

  const changes = await listCheckpointChanges({
    chatId,
    checkpointId,
    projectPath,
  });
  assert.equal(changes.complete, true);
  const files = byPath(changes.files);
  assert.deepEqual(Object.keys(files).sort(), [
    "README.md",
    "src/app.ts",
    "src/new.ts",
    "src/renamed.ts",
  ]);
  assert.equal(files["src/app.ts"].status, "modified");
  assert.equal(files["src/app.ts"].additions, 1);
  assert.equal(files["src/app.ts"].deletions, 1);
  assert.equal(files["src/app.ts"].modifiedSince, false);
  assert.equal(files["src/new.ts"].status, "added");
  assert.equal(files["README.md"].status, "deleted");
  assert.equal(files["src/renamed.ts"].status, "renamed");
  assert.equal(files["src/renamed.ts"].previousPath, "src/old.ts");

  assert.equal(
    (await fs.stat(getShadowRepoDirectory(projectPath))).isDirectory(),
    true,
  );
});

test("checkpoint diff returns a parsed patch for a changed file", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "a.txt", "one\ntwo\n");
  const checkpointId = await runTurn(projectPath, () =>
    writeProjectFile(projectPath, "a.txt", "one\n2\n"),
  );

  const diff = await getCheckpointFileDiff({
    chatId,
    checkpointId,
    filePath: "a.txt",
    projectPath,
  });
  assert.equal(diff.status, "modified");
  assert.match(diff.diff, /-two\n\+2/);
  assert.ok(diff.parsedDiff);
});

test("merge restore reverts the turn's hunks while keeping later edits", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  await writeProjectFile(projectPath, "a.txt", `${original}\n`);
  const checkpointId = await runTurn(projectPath, () =>
    writeProjectFile(
      projectPath,
      "a.txt",
      `${original.replace("line 2", "agent edit")}\n`,
    ),
  );

  await writeProjectFile(
    projectPath,
    "a.txt",
    `${original.replace("line 2", "agent edit").replace("line 19", "user edit")}\n`,
  );

  const changes = await listCheckpointChanges({
    chatId,
    checkpointId,
    projectPath,
  });
  assert.equal(changes.files[0].modifiedSince, true);

  const restore = await restoreCheckpointFiles({
    chatId,
    checkpointId,
    filePaths: ["a.txt"],
    projectPath,
  });
  assert.deepEqual(restore.results, [
    { filePath: "a.txt", message: null, status: "restored" },
  ]);
  assert.equal(
    await readProjectFile(projectPath, "a.txt"),
    `${original.replace("line 19", "user edit")}\n`,
  );
});

test("overlapping later edits produce a conflict and can be overwritten", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "a.txt", "alpha\nbeta\n");
  const checkpointId = await runTurn(projectPath, () =>
    writeProjectFile(projectPath, "a.txt", "alpha\nagent\n"),
  );
  await writeProjectFile(projectPath, "a.txt", "alpha\nuser\n");

  const merge = await restoreCheckpointFiles({
    chatId,
    checkpointId,
    filePaths: ["a.txt"],
    projectPath,
  });
  assert.equal(merge.results[0].status, "conflict");
  assert.equal(await readProjectFile(projectPath, "a.txt"), "alpha\nuser\n");

  const overwrite = await restoreCheckpointFiles({
    chatId,
    checkpointId,
    filePaths: ["a.txt"],
    mode: "overwrite",
    projectPath,
  });
  assert.equal(overwrite.results[0].status, "restored");
  assert.equal(await readProjectFile(projectPath, "a.txt"), "alpha\nbeta\n");
});

test("restore removes files added in the turn and recreates deleted ones", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "keep.txt", "keep\n");
  await writeProjectFile(projectPath, "gone.txt", "gone\n");
  const checkpointId = await runTurn(projectPath, async () => {
    await writeProjectFile(projectPath, "added.txt", "added\n");
    await fs.rm(path.join(projectPath, "gone.txt"));
  });

  const restore = await restoreCheckpointFiles({
    chatId,
    checkpointId,
    filePaths: ["added.txt", "gone.txt", "keep.txt"],
    projectPath,
  });
  assert.deepEqual(
    restore.results.map((result) => [result.filePath, result.status]),
    [
      ["added.txt", "restored"],
      ["gone.txt", "restored"],
      ["keep.txt", "error"],
    ],
  );
  assert.equal(await fileExists(projectPath, "added.txt"), false);
  assert.equal(await readProjectFile(projectPath, "gone.txt"), "gone\n");
});

test("missing after snapshot is captured on demand and reported as incomplete", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "a.txt", "before\n");
  const { checkpointId } = await createCheckpoint({ chatId, projectPath });
  await writeProjectFile(projectPath, "a.txt", "after\n");

  const first = await listCheckpointChanges({
    chatId,
    checkpointId,
    projectPath,
  });
  assert.equal(first.complete, false);
  assert.equal(first.files[0].filePath, "a.txt");

  const second = await listCheckpointChanges({
    chatId,
    checkpointId,
    projectPath,
  });
  assert.equal(second.complete, true);
});

test("checkpoint routes reject unknown checkpoints and escaped paths", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "a.txt", "one\n");
  const checkpointId = await runTurn(projectPath, () =>
    writeProjectFile(projectPath, "a.txt", "two\n"),
  );

  const app = new Hono();
  registerCheckpointRoutes(app);
  const post = (route, body) =>
    app.request(route, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

  const missing = await post("/api/checkpoint-changes", {
    chatId,
    checkpointId: "does-not-exist",
    projectPath,
  });
  assert.equal(missing.status, 404);

  const changes = await post("/api/checkpoint-changes", {
    chatId,
    checkpointId,
    projectPath,
  });
  assert.equal(changes.status, 200);
  assert.equal((await changes.json()).files[0].filePath, "a.txt");

  const escaped = await post("/api/checkpoint-diff", {
    chatId,
    checkpointId,
    filePath: "../outside.txt",
    projectPath,
  });
  assert.equal(escaped.status, 400);

  const restore = await post("/api/checkpoint-restore", {
    chatId,
    checkpointId,
    filePaths: ["../outside.txt"],
    projectPath,
  });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json()).results[0].status, "error");
});

test("deleting chat checkpoints removes only that chat's refs", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "a.txt", "one\n");
  const checkpointId = await runTurn(projectPath, () =>
    writeProjectFile(projectPath, "a.txt", "two\n"),
  );
  const other = await createCheckpoint({ chatId: "chat-2", projectPath });
  await finalizeCheckpoint({
    chatId: "chat-2",
    checkpointId: other.checkpointId,
    projectPath,
  });

  const app = new Hono();
  registerCheckpointRoutes(app);
  const response = await app.request("/api/checkpoint-delete-chats", {
    body: JSON.stringify({ chatIds: [chatId], projectPath }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deletedRefs: 2 });

  await assert.rejects(
    listCheckpointChanges({ chatId, checkpointId, projectPath }),
    /Checkpoint not found/,
  );
  const survivor = await listCheckpointChanges({
    chatId: "chat-2",
    checkpointId: other.checkpointId,
    projectPath,
  });
  assert.equal(survivor.complete, true);
  assert.equal(await deleteChatCheckpoints({ chatId, projectPath }), 0);

  await deleteProjectCheckpoints(projectPath);
  await assert.rejects(fs.access(getShadowRepoDirectory(projectPath)));
});

const git = async (...args) =>
  (await promisify(execFile)("git", args, { windowsHide: true })).stdout.trim();

// Loose objects are the files under objects/<two hex digits>/.
const countLooseObjects = async (gitDir) => {
  const objects = path.join(gitDir, "objects");
  let count = 0;
  for (const entry of await fs.readdir(objects)) {
    if (/^[0-9a-f]{2}$/.test(entry))
      count += (await fs.readdir(path.join(objects, entry))).length;
  }
  return count;
};

const refsOf = (projectPath, chat) =>
  git(
    "--git-dir",
    getShadowRepoDirectory(projectPath),
    "for-each-ref",
    "--format=%(refname)",
    `refs/dream/${chat}`,
  );

test("a first capture is packed and gives the tree plain git add gives", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  for (let index = 0; index < 30; index++)
    await writeProjectFile(
      projectPath,
      `src/part-${index % 3}/file-${index}.ts`,
      `export const n = ${index};\n`,
    );
  await writeProjectFile(projectPath, "docs/with space é.md", "# Notes\n");
  await writeProjectFile(projectPath, "empty.txt", "");
  // Converted by git on the way in: its stored blob is not its bytes.
  await writeProjectFile(projectPath, ".gitattributes", "*.txt text=auto\n");
  await writeProjectFile(projectPath, "crlf.txt", "one\r\ntwo\r\n");

  const { beforeTree } = await createCheckpoint({ chatId, projectPath });

  const plain = await fs.mkdtemp(
    path.join(os.tmpdir(), "dream-checkpoint-plain-"),
  );
  temporaryDirectories.push(plain);
  await git("init", "-q", "--bare", plain);
  const plainGit = [
    "--git-dir",
    plain,
    "--work-tree",
    projectPath,
    "-c",
    "core.autocrlf=false",
  ];
  await git(...plainGit, "add", "-A");
  assert.equal(beforeTree, await git(...plainGit, "write-tree"));
  // Plain git writes every blob and tree on its own; the first capture
  // only the file git converted.
  assert.ok((await countLooseObjects(plain)) > 30);
  assert.equal(await countLooseObjects(getShadowRepoDirectory(projectPath)), 1);

  // Later captures go through git add alone and see the same tree.
  const again = await createCheckpoint({ chatId, projectPath });
  assert.equal(again.beforeTree, beforeTree);
});

test("a restarted host does not configure a shadow repository again", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "a.txt", "one\n");
  await createCheckpoint({ chatId, projectPath });
  const shadow = ["--git-dir", getShadowRepoDirectory(projectPath)];
  await git(...shadow, "config", "--local", "core.quotepath", "true");

  // A new host process: a fresh module, the same data directory.
  const restart = async () => {
    vi.resetModules();
    const paths = await import("../../host/host-paths.js");
    paths.configureHostDataDirectory(userDataDirectory);
    const service = await import("./service.js");
    await service.createCheckpoint({ chatId, projectPath });
  };
  await restart();
  assert.equal(
    await git(...shadow, "config", "--local", "core.quotepath"),
    "true",
  );

  // Without its record of being set up, it is set up again.
  await fs.rm(path.join(getShadowRepoDirectory(projectPath), "dream-config"));
  await restart();
  assert.equal(
    await git(...shadow, "config", "--local", "core.quotepath"),
    "false",
  );
});

test("a turn waits for its snapshot, not past Stop or its budget, and an abandoned capture pins nothing", async (context) => {
  if (!gitAvailable) return context.skip();

  const projectPath = await createProject();
  await writeProjectFile(projectPath, "a.txt", "one\n");

  const checkpointId = await captureTurnCheckpoint({ chatId, projectPath });
  assert.ok(checkpointId);
  await writeProjectFile(projectPath, "a.txt", "two\n");
  await finalizeCheckpoint({ chatId, checkpointId, projectPath });
  const { files } = await listCheckpointChanges({
    chatId,
    checkpointId,
    projectPath,
  });
  assert.deepEqual(
    files.map((file) => [file.filePath, file.status]),
    [["a.txt", "modified"]],
  );

  const stopped = new AbortController();
  stopped.abort();
  assert.equal(
    await captureTurnCheckpoint({
      chatId: "stopped",
      projectPath,
      signal: stopped.signal,
    }),
    null,
  );
  // Running already when its budget ends: it finishes, and is not kept.
  assert.equal(
    await captureTurnCheckpoint({ chatId: "late", projectPath, waitMs: 0 }),
    null,
  );
  // Queued behind both, so it runs once they have settled.
  await createCheckpoint({ chatId: "after", projectPath });
  assert.equal(await refsOf(projectPath, "stopped"), "");
  assert.equal(await refsOf(projectPath, "late"), "");
});
