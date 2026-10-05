// A project's Git status is read once per refresh, however many places ask:
// the panels' hooks and the commit-message warm-up after a turn share it.
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const gitStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  apiClient: { gitStatus },
  getApiErrorMessage: () => "failed",
}));

const { readProjectGitStatus } = await import("./use-project-git-status");

const read = (projectPath: string, refreshToken: number, force = false) =>
  readProjectGitStatus({
    describeError: () => "failed",
    force,
    projectPath,
    refreshToken,
  });

beforeEach(() => {
  gitStatus.mockReset();
  gitStatus.mockImplementation(async ({ projectPath }) => ({
    branch: "main",
    changes: [],
    isRepo: true,
    repoRoot: projectPath,
  }));
});

test("reads at the same refresh share one request", async () => {
  const [first, second] = await Promise.all([read("/a", 1), read("/a", 1)]);
  const third = await read("/a", 1);

  assert.equal(gitStatus.mock.calls.length, 1);
  assert.equal(first, second);
  assert.equal(third, first);
});

test("a new refresh, or a forced read, asks the host again", async () => {
  await read("/b", 1);
  await read("/b", 2);
  await read("/b", 2, true);

  assert.equal(gitStatus.mock.calls.length, 3);
});

test("a failed read is kept with its message, not thrown", async () => {
  gitStatus.mockRejectedValueOnce(new Error("offline"));

  const entry = await read("/c", 1);

  assert.equal(entry.status, null);
  assert.equal(entry.error, "failed");
});
