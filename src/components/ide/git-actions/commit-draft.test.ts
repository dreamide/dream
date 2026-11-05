import { expect, test, vi } from "vitest";
import { fakeApiError } from "@/lib/api-client-fake";
import type {
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";
import type { CommitMessageRequest } from "../git-generated-text";
import {
  CommitDraft,
  type CommitDraftInputs,
  type CommitRequest,
} from "./commit-draft";

const change = (
  path: string,
  { staged = false, unstaged = true } = {},
): ProjectGitStatusEntry => ({
  addedLines: 1,
  path,
  previousPath: null,
  removedLines: 0,
  staged,
  status: "modified",
  unstaged,
});

const statusOf = (
  changes: ProjectGitStatusEntry[],
  { upstream = true } = {},
): ProjectGitStatusResponse =>
  ({
    changes,
    isRepo: true,
    remoteName: upstream ? "origin" : null,
    upstreamBranch: upstream ? "origin/main" : null,
  }) as ProjectGitStatusResponse;

const settings = {
  model: "gpt-5-codex",
  modelSpeed: "standard",
  provider: "openai",
  reasoningEffort: null,
} as const;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A draft over a fake route client and a generator the test controls. */
const createDraft = ({
  cached = new Map<string, string>(),
  failCommit = false,
}: {
  cached?: Map<string, string>;
  failCommit?: boolean;
} = {}) => {
  const generations: {
    request: CommitMessageRequest;
    resolve: (message: string) => void;
    reject: (error: unknown) => void;
  }[] = [];
  // The store's commitProject, as far as the draft can tell.
  const commits: CommitRequest[] = [];
  const commit = async (request: CommitRequest) => {
    commits.push(request);
    return failCommit
      ? {
          error: fakeApiError("gitCommit", 500, "nothing to commit"),
          ok: false as const,
        }
      : { ok: true as const, result: {} };
  };
  const pushFailures: unknown[] = [];
  const draft = new CommitDraft({
    commit,
    onPushFailure: (error) => pushFailures.push(error),
    text: {
      cached: (request) =>
        cached.get(request.changes.map((item) => item.path).join(",")),
      generate: (request) =>
        new Promise<string>((resolve, reject) =>
          generations.push({ reject, request, resolve }),
        ),
    },
  });
  const inputs = (
    status: ProjectGitStatusResponse | null,
    canGenerate = true,
  ): CommitDraftInputs => ({
    ...settings,
    canGenerate,
    hostId: "local",
    projectPath: "/work/app",
    status,
  });
  return { commits, draft, generations, inputs, pushFailures };
};

test("a message already generated for these changes shows at once", () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { draft, generations, inputs } = createDraft({ cached });

  draft.update(inputs(statusOf([change("a.ts")])));

  expect(draft.getSnapshot()).toMatchObject({
    canCommit: true,
    generating: false,
    message: "Fix the thing",
  });
  expect(generations).toHaveLength(0);
});

test("otherwise the message is generated; committing waits for it", async () => {
  const { draft, generations, inputs } = createDraft();
  draft.update(inputs(statusOf([change("a.ts")])));

  expect(draft.getSnapshot()).toMatchObject({
    canCommit: false,
    generating: true,
  });
  generations[0]?.resolve("Add a.ts");
  await flush();

  expect(draft.getSnapshot()).toMatchObject({
    canCommit: true,
    generating: false,
    message: "Add a.ts",
  });
});

test("a failed generation is an error; the user can still write one", async () => {
  const { draft, generations, inputs } = createDraft();
  draft.update(inputs(statusOf([change("a.ts")])));
  generations[0]?.reject(new Error("model down"));
  await flush();

  expect(draft.getSnapshot()).toMatchObject({
    error: { kind: "generate" },
    generating: false,
  });

  draft.setAutoGenerate(false);
  draft.setMessage("Written by hand");
  expect(draft.getSnapshot().canCommit).toBe(true);
});

test("a generation the changes have overtaken is ignored", async () => {
  const { draft, generations, inputs } = createDraft();
  draft.update(inputs(statusOf([change("a.ts")])));
  draft.update(inputs(statusOf([change("a.ts"), change("b.ts")])));

  generations[0]?.resolve("Only a");
  await flush();
  expect(draft.getSnapshot().message).toBe("");

  generations[1]?.resolve("Both a and b");
  await flush();
  expect(draft.getSnapshot().message).toBe("Both a and b");
});

test("while generation may not run, the message stays as it is", async () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { draft, generations, inputs } = createDraft({ cached });
  draft.update(inputs(statusOf([change("a.ts")])));

  // An agent starts writing: the status moves on, generation waits.
  draft.update(inputs(statusOf([change("a.ts"), change("b.ts")]), false));

  expect(draft.getSnapshot().message).toBe("Fix the thing");
  expect(generations).toHaveLength(0);
});

test("without unstaged changes, a commit takes only the staged ones", () => {
  const { draft, inputs } = createDraft();
  draft.setAutoGenerate(false);
  draft.update(
    inputs(statusOf([change("a.ts"), change("b.ts", { staged: true })])),
  );
  draft.setIncludeUnstaged(false);

  expect(draft.getSnapshot().changes.map((item) => item.path)).toEqual([
    "b.ts",
  ]);
});

test("turning generation off clears the message for the user to write", () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { draft, inputs } = createDraft({ cached });
  draft.update(inputs(statusOf([change("a.ts")])));

  draft.setAutoGenerate(false);
  expect(draft.getSnapshot()).toMatchObject({ canCommit: false, message: "" });
});

test("commit and commit-and-push send what the draft holds", async () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { commits, draft, inputs } = createDraft({ cached });
  draft.update(inputs(statusOf([change("a.ts")])));

  await expect(draft.submit("commit-push")).resolves.toBe(true);
  expect(commits).toEqual([
    { includeUnstaged: true, message: "Fix the thing", push: true },
  ]);
  // A sent draft starts over.
  expect(draft.getSnapshot().message).toBe("");
});

test("commit-and-push needs somewhere to push to", async () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { commits, draft, inputs } = createDraft({ cached });
  draft.update(inputs(statusOf([change("a.ts")], { upstream: false })));

  expect(draft.getSnapshot()).toMatchObject({
    canCommit: true,
    canCommitPush: false,
  });
  await expect(draft.submit("commit-push")).resolves.toBe(false);
  expect(commits).toHaveLength(0);
});

test("a commit that fails keeps the message and says why", async () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { draft, inputs } = createDraft({ cached, failCommit: true });
  draft.update(inputs(statusOf([change("a.ts")])));

  await expect(draft.submit("commit")).resolves.toBe(false);

  expect(draft.getSnapshot()).toMatchObject({
    error: { action: "commit", kind: "submit" },
    message: "Fix the thing",
    submitting: null,
  });
});

test("a failed commit-and-push is reported past the composer", async () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { draft, inputs, pushFailures } = createDraft({
    cached,
    failCommit: true,
  });
  draft.update(inputs(statusOf([change("a.ts")])));

  await expect(draft.submit("commit-push")).resolves.toBe(false);

  expect(pushFailures).toHaveLength(1);
  expect(pushFailures[0]).toMatchObject({ message: "nothing to commit" });
});

test("a failed plain commit stays with the composer", async () => {
  const cached = new Map([["a.ts", "Fix the thing"]]);
  const { draft, inputs, pushFailures } = createDraft({
    cached,
    failCommit: true,
  });
  draft.update(inputs(statusOf([change("a.ts")])));

  await draft.submit("commit");

  expect(pushFailures).toHaveLength(0);
});

test("nothing to commit means no commit", async () => {
  const listener = vi.fn();
  const { draft, inputs } = createDraft();
  draft.subscribe(listener);
  draft.update(inputs(statusOf([])));

  expect(draft.getSnapshot()).toMatchObject({
    canCommit: false,
    generating: false,
    message: "",
  });
  await expect(draft.submit("commit")).resolves.toBe(false);
  expect(listener).toHaveBeenCalled();
});
