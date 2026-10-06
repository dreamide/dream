// The client's project resources over the real store and a mocked Route
// client: a bumped refresh key is what makes a shown resource read again,
// readers share, and a summary status is the full one narrowed.
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { ProjectGitStatusResponse } from "@/types/ide";

const api = vi.hoisted(() => ({
  gitBranches: vi.fn(),
  gitStatus: vi.fn(),
  projectFiles: vi.fn(),
}));
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiClient: { ...actual.apiClient, ...api } };
});

const { useIdeStore } = await import("./ide-store");
const {
  narrowGitStatusToSummary,
  projectResourceKey,
  projectResources,
  readProjectResource,
} = await import("./project-resources");

const PROJECT_PATH = "/work/app";

const fullStatus = (): ProjectGitStatusResponse => ({
  addedLines: 5,
  aheadCount: 1,
  baseBranch: "main",
  behindCount: 0,
  branch: "main",
  changes: [
    {
      addedLines: 3,
      path: "src/app.ts",
      previousPath: null,
      removedLines: 1,
      staged: false,
      status: "modified",
      unstaged: true,
    },
    {
      addedLines: 2,
      path: "notes.txt",
      previousPath: null,
      removedLines: 0,
      staged: false,
      status: "untracked",
      unstaged: true,
    },
  ],
  fileCount: 2,
  hasStagedChanges: false,
  hasUnstagedChanges: true,
  isRepo: true,
  remoteName: "origin",
  removedLines: 1,
  repoRoot: PROJECT_PATH,
  stagedCount: 0,
  unstagedCount: 2,
  upstreamBranch: "origin/main",
});

let projectId = "";
beforeEach(() => {
  projectResources.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.gitStatus.mockImplementation(async () => fullStatus());
  api.projectFiles.mockImplementation(async ({ maxResults }) => {
    const files = ["a.ts", "b.ts", "c.ts"].slice(0, maxResults);
    return { count: files.length, files };
  });
  const project = createProjectConfig(PROJECT_PATH, DEFAULT_SETTINGS);
  projectId = project.id;
  useIdeStore.setState({
    closedProjects: [],
    projectFilesRefreshKeys: {},
    projectGitRefreshKeys: {},
    projects: [project],
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const statusKey = (detail: "full" | "summary") =>
  projectResourceKey("gitStatus", PROJECT_PATH, { params: { detail } });

test("readers at one refresh share a read; a bump makes the next read again", async () => {
  await Promise.all([
    readProjectResource(statusKey("full")),
    readProjectResource(statusKey("full")),
    readProjectResource(statusKey("summary")),
  ]);
  assert.equal(api.gitStatus.mock.calls.length, 1);

  await readProjectResource(statusKey("full"));
  assert.equal(api.gitStatus.mock.calls.length, 1);

  useIdeStore.getState().bumpProjectGitRefreshKey(projectId);
  await readProjectResource(statusKey("full"));
  assert.equal(api.gitStatus.mock.calls.length, 2);
});

test("a bump reads again only what is being shown", async () => {
  const shown = projectResources.subscribe(statusKey("full"), () => {}, true);
  const hidden = projectResources.subscribe(
    projectResourceKey("gitBranches", PROJECT_PATH),
    () => {},
    false,
  );
  await settle();
  assert.equal(api.gitStatus.mock.calls.length, 1);
  assert.equal(api.gitBranches.mock.calls.length, 0);

  useIdeStore.getState().bumpProjectGitRefreshKey(projectId);
  await settle();

  assert.equal(api.gitStatus.mock.calls.length, 2);
  assert.equal(api.gitBranches.mock.calls.length, 0);
  shown.unsubscribe();
  hidden.unsubscribe();
});

test("a files bump leaves git resources fresh, and the reverse", async () => {
  await readProjectResource(statusKey("full"));
  const files = projectResourceKey("projectFiles", PROJECT_PATH, {
    params: { maxResults: 3 },
  });
  await readProjectResource(files);

  useIdeStore.getState().bumpProjectFilesRefreshKey(projectId);
  assert.equal(projectResources.snapshot(statusKey("full")).fresh, true);
  assert.equal(projectResources.snapshot(files).fresh, false);

  useIdeStore.getState().bumpProjectGitRefreshKey(projectId);
  assert.equal(projectResources.snapshot(statusKey("full")).fresh, false);
});

test("the composer's short list is taken from the explorer's long one", async () => {
  await readProjectResource(
    projectResourceKey("projectFiles", PROJECT_PATH, {
      params: { maxResults: 3 },
    }),
  );
  const short = await readProjectResource(
    projectResourceKey("projectFiles", PROJECT_PATH, {
      params: { maxResults: 2 },
    }),
  );

  assert.deepEqual(short, { count: 2, files: ["a.ts", "b.ts"] });
  assert.equal(api.projectFiles.mock.calls.length, 1);
});

test("a summary is the full status as the host would have narrowed it", () => {
  const summary = narrowGitStatusToSummary(fullStatus());

  assert.deepEqual(
    summary.changes.map((change) => [change.path, change.addedLines]),
    [["src/app.ts", 0]],
  );
  assert.equal(summary.fileCount, 1);
  assert.equal(summary.unstagedCount, 1);
  assert.equal(summary.upstreamBranch, null);
  assert.equal(summary.aheadCount, 0);
  assert.equal(summary.branch, "main");
});
