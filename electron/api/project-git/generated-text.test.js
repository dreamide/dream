// Generated git text over fake ports: what each prompt carries, how a
// model's answer is cleaned up, what is written without one, and how commit
// messages are remembered and shared.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createGeneratedGitText } from "./generated-text.js";

const PROJECT = "/work/app";

const change = (path, { staged = false, status = "modified" } = {}) => ({
  addedLines: 1,
  path,
  previousPath: null,
  removedLines: 0,
  staged,
  status,
  unstaged: !staged,
});

/** A deferred answer a test settles. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

/**
 * Ports a test scripts: the status's changes, the diff, the pull request's
 * source, and the model's answers (a function of each request, or a value).
 * Every request is recorded.
 */
const createPorts = ({
  answer = "Fix the thing",
  changes = [change("src/a.js")],
  diff = "diff --git a/src/a.js b/src/a.js\n+fixed",
  source = {
    baseBranch: "main",
    commitSubjects: ["Add login", "Fix logout"],
    diffStat: " src/a.js | 2 +-",
    headBranch: "feature/login-page",
  },
  ...rest
} = {}) => {
  const calls = { diff: [], generate: [], source: [], status: 0, warn: [] };
  const text = createGeneratedGitText({
    generateText: async (request) => {
      calls.generate.push(request);
      return typeof answer === "function" ? answer(request) : answer;
    },
    readDiff: async (projectPath, selected, options) => {
      calls.diff.push({ options, projectPath, selected });
      return typeof diff === "function" ? diff() : diff;
    },
    readPullRequestSource: async (projectPath, requested) => {
      calls.source.push({ projectPath, requested });
      if (source instanceof Error) throw source;
      return source;
    },
    readStatus: async () => {
      calls.status += 1;
      return { changes: typeof changes === "function" ? changes() : changes };
    },
    warn: (message, error) => calls.warn.push({ error, message }),
    ...rest,
  });
  return { calls, text };
};

const SETTINGS = {
  model: "gpt-5",
  modelSpeed: "fast",
  provider: "anthropic",
  reasoningEffort: "low",
};

test("a commit message prompt lists the changes, the diff and the user's instructions", async () => {
  const { calls, text } = createPorts({
    changes: [
      change("src/a.js", { staged: true }),
      change("notes.md", { status: "untracked" }),
    ],
  });

  const message = await text.commitMessage(PROJECT, {
    ...SETTINGS,
    customInstructions: "  Mention the ticket  ",
  });

  assert.equal(message, "Fix the thing");
  assert.equal(calls.generate.length, 1);
  const [request] = calls.generate;
  assert.equal(request.model, "gpt-5");
  assert.equal(request.modelSpeed, "fast");
  assert.equal(request.provider, "anthropic");
  assert.equal(request.reasoningEffort, "low");
  assert.equal(request.projectPath, PROJECT);
  assert.equal(
    request.system,
    "You write concise, accurate git commit subjects. Return only the subject line.",
  );
  assert.equal(
    request.prompt,
    [
      "Generate one concise git commit subject for these changes.",
      "Use imperative mood, no markdown, no quotes, no trailing period.",
      "Be specific about behavior, not just filenames.",
      "Return only the commit subject.",
      "User instructions: Mention the ticket",
      "",
      "Changed files:",
      "- modified: src/a.js",
      "- untracked: notes.md",
      "",
      "Diff:",
      "diff --git a/src/a.js b/src/a.js\n+fixed",
    ].join("\n"),
  );
  assert.deepEqual(calls.diff[0].options, { includeUnstaged: true });
});

test("a commit message without instructions or unstaged changes asks only about the staged ones", async () => {
  const { calls, text } = createPorts({
    changes: [change("src/a.js", { staged: true }), change("src/b.js")],
  });

  await text.commitMessage(PROJECT, { includeUnstaged: false });

  const [request] = calls.generate;
  assert.doesNotMatch(request.prompt, /User instructions/);
  assert.match(request.prompt, /Changed files:\n- modified: src\/a\.js\n\n/);
  assert.deepEqual(
    calls.diff[0].selected.map((entry) => entry.path),
    ["src/a.js"],
  );
  assert.deepEqual(calls.diff[0].options, { includeUnstaged: false });
  // The defaults the commit route relies on when it names no model.
  assert.equal(request.provider, "openai");
  assert.equal(request.model, "");
  assert.equal(request.modelSpeed, "standard");
});

test("a diff over 20,000 characters is cut, one at the limit is not", async () => {
  const atLimit = "x".repeat(20_000);
  const { calls, text } = createPorts({ diff: () => atLimit });
  await text.commitMessage(PROJECT);
  assert.ok(calls.generate[0].prompt.endsWith(`Diff:\n${atLimit}`));

  const long = createPorts({ diff: `${atLimit}TAIL` });
  await long.text.commitMessage(PROJECT);
  assert.ok(
    long.calls.generate[0].prompt.endsWith(
      `Diff:\n${atLimit}\n\n[diff truncated]`,
    ),
  );
  assert.doesNotMatch(long.calls.generate[0].prompt, /TAIL/);
});

test("a commit message is the first line of the answer without a label or quotes", async () => {
  for (const [answer, expected] of [
    [
      '\n\n  Commit message: "Fix the thing"  \nBecause it broke',
      "Fix the thing",
    ],
    ["`Add retry to uploads`", "Add retry to uploads"],
    ["'Rename the store'", "Rename the store"],
    ["COMMIT MESSAGE:   Drop the flag", "Drop the flag"],
  ]) {
    const { text } = createPorts({ answer });
    assert.equal(await text.commitMessage(PROJECT), expected, answer);
  }
});

test("no changes, an empty diff or an empty answer is no commit message", async () => {
  const none = createPorts({ changes: [] });
  assert.equal(await none.text.commitMessage(PROJECT), "");
  assert.equal(none.calls.diff.length, 0);
  assert.equal(none.calls.generate.length, 0);

  const emptyDiff = createPorts({ diff: "  \n" });
  assert.equal(await emptyDiff.text.commitMessage(PROJECT), "");
  assert.equal(emptyDiff.calls.generate.length, 0);

  const emptyAnswer = createPorts({ answer: '\n  ""  \n' });
  assert.equal(await emptyAnswer.text.commitMessage(PROJECT), "");
  // Nothing was remembered, so the next call asks again.
  assert.equal(await emptyAnswer.text.commitMessage(PROJECT), "");
  assert.equal(emptyAnswer.calls.generate.length, 2);
});

test("a failed commit message is logged and answers empty, or throws when asked", async () => {
  const failure = new Error("model down");
  const { calls, text } = createPorts({
    answer: () => {
      throw failure;
    },
  });

  assert.equal(await text.commitMessage(PROJECT), "");
  assert.equal(calls.warn.length, 1);
  assert.equal(calls.warn[0].error, failure);

  await assert.rejects(
    text.commitMessage(PROJECT, { throwOnError: true }),
    failure,
  );
  // A failure is never remembered.
  assert.equal(calls.generate.length, 2);

  const diffFails = createPorts({
    diff: () => {
      throw new Error("git diff failed");
    },
  });
  await assert.rejects(
    diffFails.text.commitMessage(PROJECT, { throwOnError: true }),
    /git diff failed/,
  );
  assert.equal(diffFails.calls.generate.length, 0);
});

test("a commit message is remembered by its changes and settings", async () => {
  let changes = [change("src/a.js")];
  const { calls, text } = createPorts({
    answer: (request) => `Message ${calls.generate.length} ${request.model}`,
    changes: () => changes,
  });

  assert.equal(await text.commitMessage(PROJECT, SETTINGS), "Message 1 gpt-5");
  // The same changes and settings: answered before any diff is read.
  assert.equal(await text.commitMessage(PROJECT, SETTINGS), "Message 1 gpt-5");
  assert.equal(calls.diff.length, 1);
  assert.equal(calls.status, 2);

  // Another model, other changes or another project is another message.
  assert.equal(
    await text.commitMessage(PROJECT, { ...SETTINGS, model: "gpt-5-mini" }),
    "Message 2 gpt-5-mini",
  );
  changes = [{ ...change("src/a.js"), addedLines: 7 }];
  assert.equal(await text.commitMessage(PROJECT, SETTINGS), "Message 3 gpt-5");
  assert.equal(
    await text.commitMessage("/work/other", SETTINGS),
    "Message 4 gpt-5",
  );
  assert.equal(calls.generate.length, 4);
});

test("commit messages for the same changes under way share one request", async () => {
  const answer = deferred();
  const { calls, text } = createPorts({ answer: () => answer.promise });

  const first = text.commitMessage(PROJECT, SETTINGS);
  const second = text.commitMessage(PROJECT, SETTINGS);
  // Let both read the status and reach the request.
  await new Promise((resolve) => setTimeout(resolve, 0));
  answer.resolve("Shared message");

  assert.deepEqual(await Promise.all([first, second]), [
    "Shared message",
    "Shared message",
  ]);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.diff.length, 1);
});

test("a joined request that fails answers each caller as it asked", async () => {
  const answer = deferred();
  const { calls, text } = createPorts({ answer: () => answer.promise });

  const owner = text.commitMessage(PROJECT);
  const quiet = text.commitMessage(PROJECT);
  const loud = text.commitMessage(PROJECT, { throwOnError: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  answer.reject(new Error("model down"));

  assert.equal(await owner, "");
  assert.equal(await quiet, "");
  await assert.rejects(loud, /model down/);
  assert.equal(calls.generate.length, 1);
  // Only the request's owner logs the failure.
  assert.equal(calls.warn.length, 1);
});

test("the oldest remembered commit message is dropped past the limit", async () => {
  const { calls, text } = createPorts({
    answer: (request) => `For ${request.model}`,
    cacheSize: 2,
  });

  await text.commitMessage(PROJECT, { model: "a" });
  await text.commitMessage(PROJECT, { model: "b" });
  await text.commitMessage(PROJECT, { model: "a" });
  assert.equal(calls.generate.length, 2);

  await text.commitMessage(PROJECT, { model: "c" });
  await text.commitMessage(PROJECT, { model: "b" });
  await text.commitMessage(PROJECT, { model: "c" });
  assert.equal(calls.generate.length, 3);

  // "a" was written first, so it went; a hit does not keep it longer.
  await text.commitMessage(PROJECT, { model: "a" });
  assert.equal(calls.generate.length, 4);
});

test("pull request details ask for a title and a description from one context", async () => {
  const { calls, text } = createPorts({
    answer: (request) =>
      request.system.includes("title")
        ? "Add login page"
        : "## Summary\n- Login",
  });

  const details = await text.pullRequestDetails(PROJECT, {
    ...SETTINGS,
    baseBranch: "release",
    customInstructions: " Keep it short ",
  });

  assert.deepEqual(details, {
    baseBranch: "main",
    commitMessage: null,
    description: "## Summary\n- Login",
    headBranch: "feature/login-page",
    title: "Add login page",
  });
  assert.deepEqual(calls.source, [
    { projectPath: PROJECT, requested: "release" },
  ]);
  assert.equal(calls.generate.length, 2);
  const [title, body] = calls.generate;
  assert.equal(title.prompt, body.prompt);
  assert.equal(
    title.prompt,
    [
      "Branch: feature/login-page",
      "Commits:",
      "- Add login",
      "- Fix logout",
      "User instructions: Keep it short",
      "\nDiff stat:\n```text",
      " src/a.js | 2 +-",
      "```",
    ].join("\n"),
  );
  assert.match(title.system, /^Generate one concise pull request title/);
  assert.match(body.system, /^Write a pull request description/);
  for (const request of [title, body]) {
    assert.equal(request.model, "gpt-5");
    assert.equal(request.provider, "anthropic");
    assert.equal(request.modelSpeed, "fast");
    assert.equal(request.reasoningEffort, "low");
    assert.equal(request.projectPath, PROJECT);
  }
});

test("a pull request prompt carries at most 12 commits and no empty sections", async () => {
  const subjects = Array.from({ length: 15 }, (_, index) => `Commit ${index}`);
  const { calls, text } = createPorts({
    source: {
      baseBranch: "main",
      commitSubjects: subjects,
      diffStat: "",
      headBranch: "",
    },
  });

  await text.pullRequestDetails(PROJECT, SETTINGS);

  const { prompt } = calls.generate[0];
  assert.match(prompt, /^Branch: current branch\nCommits:\n/);
  assert.match(prompt, /- Commit 11$/);
  assert.doesNotMatch(prompt, /Commit 12|Diff stat|User instructions/);

  const bare = createPorts({
    source: {
      baseBranch: "main",
      commitSubjects: [],
      diffStat: "",
      headBranch: "topic",
    },
  });
  await bare.text.pullRequestDetails(PROJECT, SETTINGS);
  assert.equal(bare.calls.generate[0].prompt, "Branch: topic");
});

test("a pull request title and description are cleaned of labels, headings and quotes", async () => {
  const { text } = createPorts({
    answer: (request) =>
      request.system.includes("title")
        ? '\n Pull request title: ## "Add login page"\nmore'
        : "  Pull request description: ## Summary\n- Login  ",
  });

  const details = await text.pullRequestDetails(PROJECT, SETTINGS);
  assert.equal(details.title, "Add login page");
  assert.equal(details.description, "## Summary\n- Login");
});

test("a description that is only a code fence is no description", async () => {
  const { text } = createPorts({
    answer: (request) =>
      request.system.includes("title") ? "Add login" : "```markdown",
  });

  const details = await text.pullRequestDetails(PROJECT, SETTINGS);
  assert.equal(details.title, "Add login");
  assert.match(details.description, /^## Summary\n- Add login/);
});

test("without a model, pull request details are written from the commits", async () => {
  const { calls, text } = createPorts();

  const details = await text.pullRequestDetails(PROJECT, { model: "  " });

  assert.equal(calls.generate.length, 0);
  assert.equal(details.title, "Add login");
  assert.equal(
    details.description,
    [
      "## Summary",
      "- Add login",
      "- Fix logout",
      "\n## Changes",
      "```text",
      " src/a.js | 2 +-",
      "```",
      "\n## Testing",
      "- Not run",
    ].join("\n"),
  );
});

test("with no commits the fallback names the branch, and testing can be left out", async () => {
  const { text } = createPorts({
    source: {
      baseBranch: "main",
      commitSubjects: [],
      diffStat: "",
      headBranch: "refs/heads/feature/login-page_v2",
    },
  });

  const details = await text.pullRequestDetails(PROJECT, {
    customInstructions: "Skip tests please",
  });
  assert.equal(details.title, "Feature Login Page V2");
  assert.equal(
    details.description,
    "## Summary\n- Prepare feature login page v2",
  );

  const many = createPorts({
    source: {
      baseBranch: "main",
      commitSubjects: Array.from({ length: 10 }, (_, index) => `C${index}`),
      diffStat: "",
      headBranch: "",
    },
  });
  const manyDetails = await many.text.pullRequestDetails(PROJECT, {
    customInstructions: "no tests",
  });
  assert.equal(
    manyDetails.description,
    ["## Summary", ...Array.from({ length: 8 }, (_, i) => `- C${i}`)].join(
      "\n",
    ),
  );

  const unnamed = createPorts({
    source: {
      baseBranch: "main",
      commitSubjects: [],
      diffStat: "",
      headBranch: "",
    },
  });
  assert.equal(
    (await unnamed.text.pullRequestDetails(PROJECT)).title,
    "Changes",
  );
});

test("a failed or empty model answer falls back to the written details", async () => {
  const failure = new Error("model down");
  const failing = createPorts({
    answer: (request) => {
      if (request.system.includes("title")) throw failure;
      return "## Summary\n- From the model";
    },
  });
  const failed = await failing.text.pullRequestDetails(PROJECT, SETTINGS);
  // Either request failing loses both answers.
  assert.equal(failed.title, "Add login");
  assert.match(failed.description, /^## Summary\n- Add login\n- Fix logout/);
  assert.equal(failing.calls.warn.length, 1);
  assert.equal(failing.calls.warn[0].error, failure);

  const empty = createPorts({
    answer: (request) =>
      request.system.includes("title")
        ? "  \n"
        : "## Summary\n- From the model",
  });
  const partial = await empty.text.pullRequestDetails(PROJECT, SETTINGS);
  assert.equal(partial.title, "Add login");
  assert.equal(partial.description, "## Summary\n- From the model");
});

test("commit, push and create writes the commit message first and lists it as the newest commit", async () => {
  const { calls, text } = createPorts({
    answer: (request) =>
      request.system.includes("commit subjects")
        ? "Fix logout"
        : request.system.includes("title")
          ? "Title"
          : "Body",
    source: {
      baseBranch: "main",
      commitSubjects: ["Add login", "Fix logout"],
      diffStat: "",
      headBranch: "feature",
    },
  });

  const details = await text.pullRequestDetails(PROJECT, {
    ...SETTINGS,
    nextStep: "commit-push-create",
  });

  assert.equal(details.commitMessage, "Fix logout");
  assert.equal(calls.generate.length, 3);
  assert.match(
    calls.generate[1].prompt,
    /^Branch: feature\nCommits:\n- Fix logout\n- Add login$/,
  );
  assert.equal(calls.generate[0].model, "gpt-5");

  // The message already generated for these changes is reused.
  await text.pullRequestDetails(PROJECT, {
    ...SETTINGS,
    nextStep: "commit-push-create",
  });
  assert.equal(
    calls.generate.filter((request) =>
      request.system.includes("commit subjects"),
    ).length,
    1,
  );

  // Another next step writes no commit message.
  const created = await text.pullRequestDetails(PROJECT, {
    ...SETTINGS,
    nextStep: "push-create",
  });
  assert.equal(created.commitMessage, null);
});

test("a commit message that fails leaves the pull request details without one", async () => {
  const { calls, text } = createPorts({
    answer: (request) => {
      if (request.system.includes("commit subjects")) {
        throw new Error("model down");
      }
      return request.system.includes("title") ? "Title" : "Body";
    },
  });

  const details = await text.pullRequestDetails(PROJECT, {
    ...SETTINGS,
    nextStep: "commit-push-create",
  });
  assert.equal(details.commitMessage, null);
  assert.equal(details.title, "Title");
  assert.equal(calls.warn.length, 1);
});

test("a pull request source that cannot be read reaches the caller", async () => {
  const { calls, text } = createPorts({
    source: new Error(
      "Unable to determine the base branch for this pull request.",
    ),
  });

  await assert.rejects(text.pullRequestDetails(PROJECT, SETTINGS), {
    message: "Unable to determine the base branch for this pull request.",
  });
  assert.equal(calls.generate.length, 0);
});
