// Git writes over the fake route client: what each sends, and the rules
// every write follows (its project's host, one at a time, one refresh, an
// outcome instead of a throw).
import { expect, test } from "vitest";
import { createStore } from "zustand/vanilla";
import { createApiClient } from "@/lib/api-client";
import { createFakeApiClient, fakeApiError } from "@/lib/api-client-fake";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { createGitWriteActions, GitWriteBusyError } from "./git-write-actions";
import type { IdeState } from "./ide-store-types";
import { createRuntimeActions } from "./runtime-actions";

const pushAnswer = {
  branch: "main",
  commit: null,
  pushed: true,
  upstreamBranch: "origin/main",
} as never;

const createTestStore = (
  handlers: Parameters<typeof createFakeApiClient>[0] = {},
) => {
  const local = createProjectConfig("/work/app", DEFAULT_SETTINGS);
  const remote = {
    ...createProjectConfig("/srv/app", DEFAULT_SETTINGS),
    hostId: "devbox",
  };
  const api = createFakeApiClient(handlers);
  const store = createStore<IdeState>(
    () =>
      ({
        closedProjects: [],
        gitWriteByProject: {},
        projectGitRefreshKeys: {},
        projects: [local, remote],
      }) as unknown as IdeState,
  );
  store.setState({
    ...createRuntimeActions(store.setState),
    ...createGitWriteActions(store.setState, store.getState, {
      api: api.client,
    }),
  });
  return { api, local, remote, store };
};

const refreshKey = (
  store: ReturnType<typeof createTestStore>["store"],
  id: string,
) => store.getState().projectGitRefreshKeys[id] ?? 0;

test("a commit sends the message and refreshes the project once", async () => {
  const { api, local, store } = createTestStore({
    gitCommit: () => ({}) as never,
  });

  const outcome = await store.getState().commitProject(local.id, {
    includeUnstaged: false,
    message: "Fix it",
    push: false,
  });

  expect(outcome.ok).toBe(true);
  expect(api.calls).toEqual([
    {
      name: "gitCommit",
      request: {
        includeUnstaged: false,
        message: "Fix it",
        projectPath: local.path,
      },
    },
  ]);
  expect(refreshKey(store, local.id)).toBe(1);
  expect(store.getState().gitWriteByProject).toEqual({});
});

test("commit and push is one push with the commit message", async () => {
  const { api, local, store } = createTestStore({
    gitPush: () => pushAnswer,
  });

  await store.getState().commitProject(local.id, {
    includeUnstaged: true,
    message: "Ship it",
    push: true,
  });

  expect(api.calls[0]).toEqual({
    name: "gitPush",
    request: {
      commitMessage: "Ship it",
      includeUnstaged: true,
      nextStep: "commit-push",
      projectPath: local.path,
    },
  });
});

test("a write that fails answers the error, and still refreshes once", async () => {
  const { local, store } = createTestStore({
    gitPull: () => {
      throw fakeApiError("gitPull", 409, "Local changes would be overwritten.");
    },
  });

  const outcome = await store.getState().pullProject(local.id);

  expect(outcome.ok).toBe(false);
  expect(outcome.ok ? null : (outcome.error as Error).message).toBe(
    "Local changes would be overwritten.",
  );
  expect(refreshKey(store, local.id)).toBe(1);
  expect(store.getState().gitWriteByProject).toEqual({});
});

test("one write at a time per project: a second is refused, another project's runs", async () => {
  let finishPush = () => {};
  const { api, local, remote, store } = createTestStore({
    gitFetch: () => ({ remote: "origin" }) as never,
    gitPush: () =>
      new Promise((resolve) => {
        finishPush = () => resolve(pushAnswer);
      }),
  });

  const push = store.getState().pushProject(local.id);
  expect(store.getState().gitWriteByProject).toEqual({ [local.id]: "push" });

  const refused = await store.getState().fetchProject(local.id);
  expect(refused.ok).toBe(false);
  expect(refused.ok ? null : refused.error).toBeInstanceOf(GitWriteBusyError);

  const elsewhere = await store.getState().fetchProject(remote.id);
  expect(elsewhere.ok).toBe(true);

  finishPush();
  await expect(push).resolves.toMatchObject({ ok: true });
  // The refused fetch never reached git and moved nothing.
  expect(api.calls.map((call) => call.name)).toEqual(["gitPush", "gitFetch"]);
  expect(refreshKey(store, local.id)).toBe(1);
  expect(refreshKey(store, remote.id)).toBe(1);
});

test("revert sends one file, or everything", async () => {
  const { api, local, store } = createTestStore({
    gitRevertAll: () => ({}) as never,
    gitRevertFile: () => ({}) as never,
  });

  await store.getState().revertProjectChanges(local.id, {
    addedLines: 1,
    path: "src/new.ts",
    previousPath: "src/old.ts",
    removedLines: 0,
    staged: false,
    status: "renamed",
    unstaged: true,
  });
  await store.getState().revertProjectChanges(local.id, "all");

  expect(api.calls).toEqual([
    {
      name: "gitRevertFile",
      request: {
        filePath: "src/new.ts",
        previousPath: "src/old.ts",
        projectPath: local.path,
        status: "renamed",
      },
    },
    { name: "gitRevertAll", request: { projectPath: local.path } },
  ]);
  expect(refreshKey(store, local.id)).toBe(2);
});

test("every write runs on its project's own host", async () => {
  const sent: { hostId: string | undefined; name: string }[] = [];
  const local = createProjectConfig("/work/app", DEFAULT_SETTINGS);
  const remote = {
    ...createProjectConfig("/srv/app", DEFAULT_SETTINGS),
    hostId: "devbox",
  };
  const store = createStore<IdeState>(
    () =>
      ({
        closedProjects: [],
        gitWriteByProject: {},
        projectGitRefreshKeys: {},
        projects: [local, remote],
      }) as unknown as IdeState,
  );
  store.setState({
    ...createRuntimeActions(store.setState),
    ...createGitWriteActions(store.setState, store.getState, {
      api: createApiClient(async ({ hostId, name }) => {
        sent.push({ hostId, name });
        return name === "gitCheckout"
          ? { branches: [], currentBranch: "feature" }
          : { url: "https://example/pr/1" };
      }),
    }),
  });

  const checkout = await store
    .getState()
    .checkoutProjectBranch(remote.id, "feature", { create: true });
  const pullRequest = await store
    .getState()
    .createProjectPullRequest(local.id, {
      baseBranch: "main",
      commitMessage: null,
      description: "Body",
      draft: true,
      includeUnstaged: true,
      nextStep: "create",
      openPrPage: false,
      title: "Title",
    });

  expect(checkout).toMatchObject({
    ok: true,
    result: { currentBranch: "feature" },
  });
  expect(pullRequest).toMatchObject({
    ok: true,
    result: { url: "https://example/pr/1" },
  });
  expect(sent).toEqual([
    { hostId: "devbox", name: "gitCheckout" },
    { hostId: "local", name: "gitCreatePullRequest" },
  ]);
});

test("deleting a branch sends the confirmed head and refreshes the project", async () => {
  const answer = {
    branches: [],
    currentBranch: "main",
    deleted: "topic",
    isRepo: true,
    repoRoot: "/work/app",
  };
  const { api, local, store } = createTestStore({
    gitBranchDelete: () => answer,
  });

  const merged = await store.getState().deleteProjectBranch(local.id, "topic");
  const unmerged = await store
    .getState()
    .deleteProjectBranch(local.id, "other", { confirmedHead: "abc" });

  expect(merged).toEqual({ ok: true, result: answer });
  expect(unmerged).toEqual({ ok: true, result: answer });
  expect(api.calls.map((call) => call.request)).toEqual([
    { branchName: "topic", confirmedHead: null, projectPath: local.path },
    { branchName: "other", confirmedHead: "abc", projectPath: local.path },
  ]);
  expect(refreshKey(store, local.id)).toBe(2);
  expect(store.getState().gitWriteByProject).toEqual({});
});

test("a refused branch delete answers the failure and still refreshes", async () => {
  const { local, store } = createTestStore({
    gitBranchDelete: () => {
      throw fakeApiError("gitBranchDelete", 409, "not merged");
    },
  });

  const outcome = await store.getState().deleteProjectBranch(local.id, "topic");

  expect(outcome.ok).toBe(false);
  expect(refreshKey(store, local.id)).toBe(1);
});

test("a project that is not open is not written to", async () => {
  const { api, store } = createTestStore();
  const outcome = await store.getState().pushProject("gone");
  expect(outcome.ok).toBe(false);
  expect(api.calls).toEqual([]);
});
