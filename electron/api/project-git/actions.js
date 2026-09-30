import path from "node:path";
import { getProvider } from "../providers/registry.js";
import {
  getGitCommandErrorMessage,
  getGitRepositoryInfo,
  getProjectGitBulkCachedDiff,
  getProjectGitBulkDiff,
  getProjectGitChangesFingerprint,
  getProjectGitMetadata,
  gitRefExists,
  listProjectGitChanges,
  resolveGitBranchUpstream,
  runGhCommand,
  runGitCommand,
} from "./core.js";
import { normalizePath } from "./files.js";

const COMMIT_MESSAGE_DIFF_MAX_CHARS = 20_000;
const COMMIT_MESSAGE_CACHE_MAX_ENTRIES = 30;
const commitMessageCache = new Map();
const commitMessageRequests = new Map();

const normalizeGitActionText = (value) =>
  typeof value === "string" ? value.trim() : "";

const getGitActionBranchName = (branch) => {
  const normalizedBranch = normalizeGitActionText(branch);
  if (!normalizedBranch || normalizedBranch.startsWith("HEAD ")) {
    return null;
  }

  return normalizedBranch;
};

const humanizeBranchName = (branch) =>
  normalizeGitActionText(branch)
    .replace(/^refs\/heads\//, "")
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase()) || "Changes";

const ensureProjectGitRepository = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  return repoInfo;
};

const getProjectGitPathspec = (projectPath, repoRoot) => {
  const relativeProjectPath = normalizePath(
    path.relative(repoRoot, path.resolve(projectPath)),
  );

  return relativeProjectPath && relativeProjectPath !== "."
    ? relativeProjectPath
    : ".";
};

const listStagedGitPaths = async (repoRoot) => {
  const result = await runGitCommand(repoRoot, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]);

  return result.stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizePath);
};

const isGitPathInsidePathspec = (gitPath, pathspec) =>
  pathspec === "." ||
  gitPath === pathspec ||
  gitPath.startsWith(`${pathspec}/`);

const gitQuietDiffHasChanges = async (repoRoot, args) => {
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (result.ok) {
    return false;
  }

  if (result.error?.code === 1) {
    return true;
  }

  throw new Error(getGitCommandErrorMessage(result.error));
};

const sanitizeGeneratedCommitMessage = (value) => {
  const firstLine = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "";
  }

  return firstLine
    .replace(/^commit message:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
};

const truncateCommitMessageDiff = (diffText) => {
  if (diffText.length <= COMMIT_MESSAGE_DIFF_MAX_CHARS) {
    return diffText;
  }

  return `${diffText.slice(
    0,
    COMMIT_MESSAGE_DIFF_MAX_CHARS,
  )}\n\n[diff truncated]`;
};

const buildCommitMessagePrompt = ({
  changes,
  customInstructions = "",
  diffText,
}) => {
  const changedFiles = changes
    .map((change) => `- ${change.status}: ${change.path}`)
    .join("\n");
  const instructions = normalizeGitActionText(customInstructions);

  return [
    "Generate one concise git commit subject for these changes.",
    "Use imperative mood, no markdown, no quotes, no trailing period.",
    "Be specific about behavior, not just filenames.",
    "Return only the commit subject.",
    instructions ? `User instructions: ${instructions}` : null,
    "",
    "Changed files:",
    changedFiles,
    "",
    "Diff:",
    truncateCommitMessageDiff(diffText),
  ]
    .filter((part) => part !== null)
    .join("\n");
};

const setCommitMessageCacheEntry = (key, value) => {
  commitMessageCache.set(key, value);
  if (commitMessageCache.size <= COMMIT_MESSAGE_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = commitMessageCache.keys().next().value;
  if (oldestKey) {
    commitMessageCache.delete(oldestKey);
  }
};

// One-shot text through the chat's provider (see providers/registry.js).
const generateAiText = ({ provider, ...options }) =>
  getProvider(provider).generateText(options);

export const generateProjectGitCommitMessage = async (
  projectPath,
  {
    includeUnstaged = true,
    customInstructions = "",
    model = "",
    modelSpeed = "standard",
    provider = "openai",
    reasoningEffort,
    throwOnError = false,
  } = {},
) => {
  const status = await listProjectGitChanges(projectPath);
  const changes = status.changes.filter((change) =>
    includeUnstaged ? change.staged || change.unstaged : change.staged,
  );

  if (changes.length === 0) {
    return "";
  }

  // Use a lightweight fingerprint (derived from git status metadata) so we can
  // check the cache *before* fetching any diffs. This avoids the most expensive
  // part of the pipeline when the result is already cached.
  const cacheKey = getProjectGitChangesFingerprint(changes, {
    customInstructions,
    includeUnstaged,
    model,
    modelSpeed,
    projectPath,
    provider,
    reasoningEffort,
  });

  const cachedMessage = commitMessageCache.get(cacheKey);
  if (cachedMessage) {
    return cachedMessage;
  }

  const existingRequest = commitMessageRequests.get(cacheKey);
  if (existingRequest) {
    try {
      return await existingRequest;
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
      return "";
    }
  }

  const request = (async () => {
    // Fetch all diffs in bulk — one git subprocess for all tracked files and
    // parallel file reads for untracked files, instead of N separate subprocess
    // spawns with redundant repo-info / HEAD resolution each time.
    const diffText = includeUnstaged
      ? await getProjectGitBulkDiff(projectPath, changes)
      : await getProjectGitBulkCachedDiff(projectPath, changes);

    if (!diffText.trim()) {
      return "";
    }

    const commitInstruction =
      "You write concise, accurate git commit subjects. Return only the subject line.";
    const aiMessage = sanitizeGeneratedCommitMessage(
      await generateAiText({
        model,
        modelSpeed,
        projectPath,
        prompt: buildCommitMessagePrompt({
          changes,
          customInstructions,
          diffText,
        }),
        provider,
        reasoningEffort,
        system: commitInstruction,
      }),
    );

    return aiMessage || "";
  })();
  commitMessageRequests.set(cacheKey, request);

  try {
    const message = await request;
    if (message) {
      setCommitMessageCacheEntry(cacheKey, message);
    }
    return message;
  } catch (error) {
    console.warn("[git] AI commit message generation failed:", error);
    if (throwOnError) {
      throw error;
    }
    return "";
  } finally {
    commitMessageRequests.delete(cacheKey);
  }
};

export const commitProjectGitChanges = async (
  projectPath,
  { customInstructions = "", includeUnstaged = true, message = "" } = {},
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const projectPathspec = getProjectGitPathspec(projectPath, repoInfo.repoRoot);

  if (includeUnstaged) {
    await runGitCommand(repoInfo.repoRoot, [
      "add",
      "-A",
      "--",
      projectPathspec,
    ]);
  }

  const hasStagedChanges = await gitQuietDiffHasChanges(repoInfo.repoRoot, [
    "diff",
    "--cached",
    "--quiet",
    "--",
    projectPathspec,
  ]);
  if (!hasStagedChanges) {
    throw new Error("No staged changes to commit.");
  }

  const stagedPaths = await listStagedGitPaths(repoInfo.repoRoot);
  const outsideProjectStagedPaths = stagedPaths.filter(
    (gitPath) => !isGitPathInsidePathspec(gitPath, projectPathspec),
  );
  if (outsideProjectStagedPaths.length > 0) {
    throw new Error(
      "There are staged changes outside the active project. Commit them separately before using this action.",
    );
  }

  const commitMessage =
    normalizeGitActionText(message) ||
    (await generateProjectGitCommitMessage(projectPath, {
      customInstructions,
      includeUnstaged,
    }));

  if (!commitMessage) {
    throw new Error("Commit message is required.");
  }

  await runGitCommand(repoInfo.repoRoot, ["commit", "-m", commitMessage]);
  const commitHashResult = await runGitCommand(
    repoInfo.repoRoot,
    ["rev-parse", "--short", "HEAD"],
    { allowFailure: true },
  );

  return {
    commitHash: commitHashResult.ok ? commitHashResult.stdout.trim() : null,
    commitMessage,
    committed: true,
    status: await listProjectGitChanges(projectPath),
  };
};

/**
 * (e.g. a branch other than the checked-out one), which need not be checked out.
 * (e.g. a finished task's base branch), which need not be checked out.
 */
const resolveGitPushBranch = async (repoInfo, requestedBranch) => {
  const currentBranch = getGitActionBranchName(repoInfo.branch);
  const branch = normalizeGitActionText(requestedBranch);
  if (!branch || branch === currentBranch) {
    if (!currentBranch) {
      throw new Error("Cannot push from a detached HEAD.");
    }
    return { branch: currentBranch, headRef: "HEAD", named: false };
  }

  if (!(await gitRefExists(repoInfo.repoRoot, `refs/heads/${branch}`))) {
    throw new Error(`Branch ${branch} does not exist.`);
  }
  return { branch, headRef: `refs/heads/${branch}`, named: true };
};

export const pushProjectGitChanges = async (
  projectPath,
  {
    branch: requestedBranch = "",
    commitMessage = "",
    customInstructions = "",
    includeUnstaged = true,
    nextStep = "push",
  } = {},
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const target = await resolveGitPushBranch(repoInfo, requestedBranch);
  if (target.named && nextStep === "commit-push") {
    throw new Error("Only the checked-out branch can be committed and pushed.");
  }

  let commit = null;
  if (nextStep === "commit-push") {
    commit = await commitProjectGitChanges(projectPath, {
      customInstructions,
      includeUnstaged,
      message: commitMessage,
    });
  }

  const { branch } = target;
  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch, {
    named: target.named,
  });
  // A named branch is pushed with an explicit refspec to the branch it
  // tracks, so it does not have to be checked out. Nothing is force-pushed.
  const upstream = target.named
    ? await resolveGitBranchUpstream(repoInfo.repoRoot, branch)
    : null;
  const args = target.named
    ? upstream
      ? [
          "push",
          upstream.remote,
          `refs/heads/${branch}:refs/heads/${upstream.remoteBranch}`,
        ]
      : metadata.remoteName
        ? [
            "push",
            "-u",
            metadata.remoteName,
            `refs/heads/${branch}:refs/heads/${branch}`,
          ]
        : null
    : metadata.upstreamBranch
      ? ["push"]
      : metadata.remoteName
        ? ["push", "-u", metadata.remoteName, branch]
        : null;

  if (!args) {
    throw new Error("No Git remote is configured for this repository.");
  }

  await runGitCommand(repoInfo.repoRoot, args);

  const status = await listProjectGitChanges(projectPath);
  return {
    branch,
    commit,
    pushed: true,
    status,
    upstreamBranch: target.named
      ? (upstream?.upstream ?? `${metadata.remoteName}/${branch}`)
      : status.upstreamBranch,
  };
};

export const getPullRequestBaseRef = async (
  repoRoot,
  remoteName,
  baseBranch,
) => {
  if (!baseBranch) {
    return null;
  }

  if (
    remoteName &&
    (await gitRefExists(repoRoot, `refs/remotes/${remoteName}/${baseBranch}`))
  ) {
    return `${remoteName}/${baseBranch}`;
  }

  if (await gitRefExists(repoRoot, `refs/heads/${baseBranch}`)) {
    return baseBranch;
  }

  return null;
};

const parseGitPushPreviewCommit = (line) => {
  const [
    hash = "",
    shortHash = "",
    subject = "",
    authorName = "",
    authorDate = "",
  ] = line.split("\x1f");

  return {
    authorDate,
    authorName,
    hash,
    shortHash,
    subject,
  };
};

export const readGitCommitCount = async (repoRoot, rangeRef) => {
  const args = rangeRef
    ? ["rev-list", "--count", rangeRef]
    : ["rev-list", "--count", "HEAD"];
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (!result.ok) {
    return 0;
  }

  return Number.parseInt(result.stdout.trim(), 10) || 0;
};

export const readGitPushPreviewCommits = async (repoRoot, rangeRef) => {
  const args = [
    "log",
    "--max-count=50",
    "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI",
    ...(rangeRef ? [rangeRef] : ["HEAD"]),
  ];
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseGitPushPreviewCommit);
};

const GIT_LOG_FIELD_SEPARATOR = "\x1f";
const GIT_LOG_RECORD_SEPARATOR = "\x1e";

const parseGitLogRefs = (value) =>
  value
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => ref.replace(/^HEAD -> /, ""))
    .filter((ref) => ref !== "HEAD" && !ref.endsWith("/HEAD"));

const parseGitLogRecord = (record) => {
  const [
    hash = "",
    shortHash = "",
    subject = "",
    authorName = "",
    authorEmail = "",
    authorDate = "",
    refs = "",
  ] = record.split(GIT_LOG_FIELD_SEPARATOR);

  return {
    authorDate,
    authorEmail,
    authorName,
    hash,
    refs: parseGitLogRefs(refs),
    shortHash,
    subject,
  };
};

export const getProjectGitLog = async (
  projectPath,
  { limit = 100, skip = 0 } = {},
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  // Read one extra commit to learn whether another page exists.
  const result = await runGitCommand(
    repoInfo.repoRoot,
    [
      "log",
      `--max-count=${limit + 1}`,
      `--skip=${skip}`,
      "--decorate=short",
      `--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D%x1e`,
      "HEAD",
    ],
    { allowFailure: true },
  );

  // A repository without commits has no HEAD to walk.
  if (!result.ok) {
    return { commits: [], hasMore: false };
  }

  const commits = result.stdout
    .split(GIT_LOG_RECORD_SEPARATOR)
    .map((record) => record.replace(/^\r?\n/, ""))
    .filter((record) => record.trim())
    .map(parseGitLogRecord);

  return {
    commits: commits.slice(0, limit),
    hasMore: commits.length > limit,
  };
};

export const getProjectGitPushPreview = async (
  projectPath,
  { branch: requestedBranch = "" } = {},
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const target = await resolveGitPushBranch(repoInfo, requestedBranch);
  const { branch } = target;

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch, {
    named: target.named,
  });
  if (!metadata.upstreamBranch && !metadata.remoteName) {
    throw new Error("No Git remote is configured for this repository.");
  }

  const remoteBranchRef =
    metadata.remoteName &&
    (await gitRefExists(
      repoInfo.repoRoot,
      `refs/remotes/${metadata.remoteName}/${branch}`,
    ))
      ? `${metadata.remoteName}/${branch}`
      : null;
  const baseRef =
    metadata.upstreamBranch ||
    remoteBranchRef ||
    (await getPullRequestBaseRef(
      repoInfo.repoRoot,
      metadata.remoteName,
      metadata.baseBranch,
    ));
  // Without a base, the whole history of the pushed branch is new.
  const rangeRef = baseRef
    ? `${baseRef}..${target.headRef}`
    : target.named
      ? target.headRef
      : null;
  const [commits, totalCommits] = await Promise.all([
    readGitPushPreviewCommits(repoInfo.repoRoot, rangeRef),
    readGitCommitCount(repoInfo.repoRoot, rangeRef),
  ]);

  return {
    aheadCount: metadata.upstreamBranch ? metadata.aheadCount : totalCommits,
    baseRef,
    behindCount: metadata.behindCount,
    branch,
    commits,
    remoteName: metadata.remoteName,
    target: metadata.upstreamBranch ?? `${metadata.remoteName}/${branch}`,
    totalCommits,
    truncated: commits.length < totalCommits,
    upstreamBranch: metadata.upstreamBranch,
  };
};

const readPullRequestCommitSubjects = async (repoRoot, baseRef) => {
  const args = baseRef
    ? ["log", "--pretty=%s", `${baseRef}..HEAD`]
    : ["log", "--pretty=%s", "-n", "10"];
  const logResult = await runGitCommand(repoRoot, args, {
    allowFailure: true,
  });

  if (!logResult.ok) {
    return [];
  }

  return logResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const readPullRequestDiffStat = async (repoRoot, baseRef) => {
  if (!baseRef) {
    return "";
  }

  const diffResult = await runGitCommand(
    repoRoot,
    ["diff", "--stat", `${baseRef}...HEAD`],
    { allowFailure: true },
  );

  return diffResult.ok ? diffResult.stdout.trim() : "";
};

const buildGeneratedPullRequestTitle = (branch, commitSubjects) => {
  return commitSubjects[0] || humanizeBranchName(branch);
};

const buildGeneratedPullRequestBody = ({
  branch,
  commitSubjects,
  customInstructions,
  diffStat,
}) => {
  const summaryItems =
    commitSubjects.length > 0
      ? commitSubjects.slice(0, 8)
      : [`Prepare ${humanizeBranchName(branch).toLowerCase()}`];
  const instructions = normalizeGitActionText(customInstructions).toLowerCase();
  const includeTesting =
    !instructions.includes("no test") && !instructions.includes("skip test");

  return [
    "## Summary",
    ...summaryItems.map((subject) => `- ${subject}`),
    diffStat ? "\n## Changes" : null,
    diffStat ? "```text" : null,
    diffStat || null,
    diffStat ? "```" : null,
    includeTesting ? "\n## Testing" : null,
    includeTesting ? "- Not run" : null,
  ]
    .filter(Boolean)
    .join("\n");
};

const sanitizeGeneratedPullRequestTitle = (value) => {
  const firstLine = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "";
  }

  return firstLine
    .replace(/^pull request title:\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
};

const sanitizeGeneratedPullRequestBody = (value) => {
  let body = String(value ?? "").trim();
  if (!body) {
    return "";
  }

  if (/^```(?:markdown|md)?\s*$/i.test(body)) {
    body = body
      .replace(/^```(?:markdown|md)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }

  return body.replace(/^pull request description:\s*/i, "").trim();
};

const buildPullRequestContext = ({
  branch,
  commitSubjects,
  customInstructions,
  diffStat,
}) => {
  const subjects = commitSubjects.slice(0, 12);
  const instructions = normalizeGitActionText(customInstructions);

  return [
    `Branch: ${branch || "current branch"}`,
    commitSubjects.length > 0 ? "Commits:" : null,
    ...subjects.map((subject) => `- ${subject}`),
    instructions ? `User instructions: ${instructions}` : null,
    diffStat ? "\nDiff stat:\n```text" : null,
    diffStat || null,
    diffStat ? "```" : null,
  ]
    .filter((part) => part !== null)
    .join("\n");
};

const PULL_REQUEST_TITLE_INSTRUCTION =
  "Generate one concise pull request title for these changes. Use imperative mood, no markdown, no quotes, no trailing period. Be specific about behavior, not just filenames. Return only the title.";

const PULL_REQUEST_BODY_INSTRUCTION =
  'Write a pull request description in GitHub-flavored markdown for these changes. Start with a "## Summary" section describing the high-level purpose. Then add a "## Changes" section listing the key changes as bullet points. Only mention concrete behavior changes, not just filenames. Return only the description body.';

const generateAiPullRequestDetails = async ({
  branch,
  commitSubjects,
  customInstructions,
  diffStat,
  model,
  modelSpeed,
  projectPath,
  provider,
  reasoningEffort,
}) => {
  const context = buildPullRequestContext({
    branch,
    commitSubjects,
    customInstructions,
    diffStat,
  });
  const [titleText, bodyText] = await Promise.all([
    generateAiText({
      model,
      modelSpeed,
      projectPath,
      prompt: context,
      provider,
      reasoningEffort,
      system: PULL_REQUEST_TITLE_INSTRUCTION,
    }),
    generateAiText({
      model,
      modelSpeed,
      projectPath,
      prompt: context,
      provider,
      reasoningEffort,
      system: PULL_REQUEST_BODY_INSTRUCTION,
    }),
  ]);

  return {
    title: sanitizeGeneratedPullRequestTitle(titleText),
    description: sanitizeGeneratedPullRequestBody(bodyText),
  };
};

const getProjectPullRequestGenerationContext = async (
  projectPath,
  requestedBaseBranch,
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const headBranch = getGitActionBranchName(repoInfo.branch);
  if (!headBranch) {
    throw new Error("Cannot create a pull request from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, headBranch);
  const baseBranch =
    normalizeGitActionText(requestedBaseBranch) ||
    metadata.baseBranch ||
    "main";
  const baseRef = await getPullRequestBaseRef(
    repoInfo.repoRoot,
    metadata.remoteName,
    baseBranch,
  );

  return {
    baseBranch,
    baseRef,
    headBranch,
    repoRoot: repoInfo.repoRoot,
  };
};

export const generateProjectPullRequestDetails = async (
  projectPath,
  {
    baseBranch: requestedBaseBranch = "",
    customInstructions = "",
    includeUnstaged = true,
    model = "",
    modelSpeed = "standard",
    nextStep = "create",
    provider = "openai",
    reasoningEffort,
  } = {},
) => {
  const context = await getProjectPullRequestGenerationContext(
    projectPath,
    requestedBaseBranch,
  );
  const [existingCommitSubjects, diffStat] = await Promise.all([
    readPullRequestCommitSubjects(context.repoRoot, context.baseRef),
    readPullRequestDiffStat(context.repoRoot, context.baseRef),
  ]);
  const generatedCommitMessage =
    nextStep === "commit-push-create"
      ? await generateProjectGitCommitMessage(projectPath, {
          customInstructions,
          includeUnstaged,
          model,
          modelSpeed,
          provider,
          reasoningEffort,
        })
      : "";
  const commitSubjects = generatedCommitMessage
    ? [
        generatedCommitMessage,
        ...existingCommitSubjects.filter(
          (subject) => subject !== generatedCommitMessage,
        ),
      ]
    : existingCommitSubjects;

  const hasModel = typeof model === "string" && model.trim().length > 0;
  let generatedTitle = "";
  let generatedDescription = "";
  if (hasModel) {
    try {
      const aiDetails = await generateAiPullRequestDetails({
        branch: context.headBranch,
        commitSubjects,
        customInstructions,
        diffStat,
        model,
        modelSpeed,
        projectPath,
        provider,
        reasoningEffort,
      });
      generatedTitle = aiDetails.title;
      generatedDescription = aiDetails.description;
    } catch (error) {
      console.warn("[git] AI pull request details generation failed:", error);
    }
  }
  generatedTitle =
    generatedTitle ||
    buildGeneratedPullRequestTitle(context.headBranch, commitSubjects);
  generatedDescription =
    generatedDescription ||
    buildGeneratedPullRequestBody({
      branch: context.headBranch,
      commitSubjects,
      customInstructions,
      diffStat,
    });

  return {
    baseBranch: context.baseBranch,
    commitMessage: generatedCommitMessage || null,
    description: generatedDescription,
    headBranch: context.headBranch,
    title: generatedTitle,
  };
};

const parsePullRequestUrl = (output) => {
  const match = output.match(/https?:\/\/\S+/);
  return match?.[0] ?? null;
};

export const createProjectPullRequest = async (
  projectPath,
  {
    baseBranch: requestedBaseBranch = "",
    commitMessage = "",
    customInstructions = "",
    description = "",
    draft = true,
    includeUnstaged = true,
    nextStep = "create",
    title = "",
  } = {},
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  let commit = null;
  let push = null;

  if (nextStep === "commit-push-create") {
    commit = await commitProjectGitChanges(projectPath, {
      customInstructions,
      includeUnstaged,
      message: commitMessage,
    });
  }

  if (nextStep === "push-create" || nextStep === "commit-push-create") {
    push = await pushProjectGitChanges(projectPath, { nextStep: "push" });
  }

  const generatedDetails = await generateProjectPullRequestDetails(
    projectPath,
    {
      baseBranch: requestedBaseBranch,
      customInstructions,
      includeUnstaged,
      nextStep: "create",
    },
  );
  const pullRequestTitle =
    normalizeGitActionText(title) || generatedDetails.title;
  const pullRequestBody =
    normalizeGitActionText(description) || generatedDetails.description;

  const args = [
    "pr",
    "create",
    "--base",
    generatedDetails.baseBranch,
    "--head",
    generatedDetails.headBranch,
    "--title",
    pullRequestTitle,
    "--body",
    pullRequestBody,
  ];

  if (draft) {
    args.push("--draft");
  }

  const createResult = await runGhCommand(repoInfo.repoRoot, args);
  const output = `${createResult.stdout}\n${createResult.stderr}`.trim();

  return {
    baseBranch: generatedDetails.baseBranch,
    commit,
    draft,
    headBranch: generatedDetails.headBranch,
    push,
    status: await listProjectGitChanges(projectPath),
    title: pullRequestTitle,
    url: parsePullRequestUrl(output),
  };
};
