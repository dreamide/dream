import { spawn } from "node:child_process";
import path from "node:path";
import { generateText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import {
  getCodexCliSpawnErrorMessage,
  resolveCodexCliLaunch,
} from "../chat/codex-cli-launch.js";
import { getCodexErrorDetail } from "../chat/codex-prompt.js";
import {
  fetchAnthropicLowCostModel,
  fetchOpenAiLowCostModel,
} from "../providers/provider-models.js";
import {
  getGitCommandErrorMessage,
  getGitRepositoryInfo,
  getProjectGitCachedDiff,
  getProjectGitDiff,
  getProjectGitMetadata,
  gitRefExists,
  listProjectGitChanges,
  runGhCommand,
  runGitCommand,
} from "./core.js";
import { hashContent, normalizePath } from "./files.js";

const COMMIT_MESSAGE_DIFF_MAX_CHARS = 20_000;
const COMMIT_MESSAGE_CACHE_MAX_ENTRIES = 30;
const COMMIT_MESSAGE_CACHE_VERSION = 3;
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

const getCommitMessageCacheKey = ({
  changes,
  customInstructions,
  diffText,
  includeUnstaged,
  projectPath,
  provider,
}) =>
  hashContent(
    JSON.stringify({
      changes: changes
        .map((change) => ({
          addedLines: change.addedLines,
          path: change.path,
          previousPath: change.previousPath,
          removedLines: change.removedLines,
          staged: change.staged,
          status: change.status,
          unstaged: change.unstaged,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      customInstructions: normalizeGitActionText(customInstructions),
      diffHash: hashContent(diffText),
      includeUnstaged,
      projectPath: path.resolve(projectPath),
      provider,
      version: COMMIT_MESSAGE_CACHE_VERSION,
    }),
  );

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

const generateClaudeCommitMessage = async ({
  customInstructions,
  diffText,
  changes,
  projectPath,
}) => {
  const model = (await fetchAnthropicLowCostModel()) || "haiku";
  const result = await generateText({
    model: claudeCode(model, {
      continue: false,
      cwd: projectPath,
      persistSession: false,
      permissionMode: "plan",
    }),
    prompt: buildCommitMessagePrompt({ changes, customInstructions, diffText }),
    system:
      "You write concise, accurate git commit subjects. Return only the subject line.",
    temperature: 0.2,
  });

  return sanitizeGeneratedCommitMessage(result.text);
};

const generateCodexCommitMessage = async ({
  customInstructions,
  diffText,
  changes,
  projectPath,
}) =>
  new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let latestText = "";

    const prompt = [
      "You write concise, accurate git commit subjects.",
      buildCommitMessagePrompt({ changes, customInstructions, diffText }),
    ].join("\n\n");

    const finishWithText = () => {
      const sanitized = sanitizeGeneratedCommitMessage(latestText);
      resolve(sanitized);
    };

    const handleEvent = (event) => {
      if (!event || typeof event !== "object") {
        return;
      }

      if (event.type === "error" || event.type === "turn.failed") {
        const detail = getCodexErrorDetail(event);
        if (detail) {
          stderrBuffer += `${detail}\n`;
        }
        return;
      }

      const item = event.item;
      if (
        event.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        latestText = item.text;
      }
    };

    const handleStdoutChunk = (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          handleEvent(JSON.parse(trimmed));
        } catch {
          stderrBuffer += `${trimmed}\n`;
        }
      }
    };

    void Promise.all([resolveCodexCliLaunch(), fetchOpenAiLowCostModel()])
      .then(([launch, model]) => {
        const child = spawn(
          launch.command,
          [
            ...launch.argsPrefix,
            "exec",
            "--json",
            "--cd",
            projectPath,
            "--skip-git-repo-check",
            ...(model ? ["--model", model] : []),
            "-c",
            'sandbox_mode="read-only"',
            "-c",
            'approval_policy="never"',
            "-c",
            'model_reasoning_effort="low"',
            "-",
          ],
          {
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );

        child.stdout.on("data", handleStdoutChunk);
        child.stderr.on("data", (chunk) => {
          stderrBuffer += chunk.toString();
        });
        child.on("error", (error) => {
          reject(new Error(getCodexCliSpawnErrorMessage(error)));
        });
        child.on("close", (code) => {
          const trimmed = stdoutBuffer.trim();
          if (trimmed) {
            try {
              handleEvent(JSON.parse(trimmed));
            } catch {
              stderrBuffer += `${trimmed}\n`;
            }
          }

          if (code === 0) {
            finishWithText();
            return;
          }

          reject(
            new Error(
              stderrBuffer.trim() || `Codex CLI exited with code ${code}.`,
            ),
          );
        });

        child.stdin.end(prompt);
      })
      .catch((error) => {
        reject(
          new Error(
            error instanceof Error
              ? error.message
              : "Codex CLI request failed.",
          ),
        );
      });
  });

const generateAiCommitMessage = async ({
  provider,
  customInstructions,
  diffText,
  changes,
  projectPath,
}) => {
  if (provider === "anthropic") {
    return generateClaudeCommitMessage({
      changes,
      customInstructions,
      diffText,
      projectPath,
    });
  }

  return generateCodexCommitMessage({
    changes,
    customInstructions,
    diffText,
    projectPath,
  });
};

export const generateProjectGitCommitMessage = async (
  projectPath,
  { includeUnstaged = true, customInstructions = "", provider = "openai" } = {},
) => {
  const status = await listProjectGitChanges(projectPath);
  const changes = status.changes.filter((change) =>
    includeUnstaged ? change.staged || change.unstaged : change.staged,
  );

  if (changes.length === 0) {
    return "";
  }

  const diffPayloads = await Promise.all(
    changes.map(async (change) => {
      try {
        const diffPayload = includeUnstaged
          ? await getProjectGitDiff(projectPath, change.path, {
              previousPath: change.previousPath,
              status: change.status,
            })
          : await getProjectGitCachedDiff(projectPath, change.path, {
              previousPath: change.previousPath,
              status: change.status,
            });
        return diffPayload.diff || "";
      } catch {
        return "";
      }
    }),
  );

  const diffText = diffPayloads.join("\n\n");

  if (!diffText.trim()) {
    return "";
  }

  const cacheKey = getCommitMessageCacheKey({
    changes,
    customInstructions,
    diffText,
    includeUnstaged,
    projectPath,
    provider,
  });
  const cachedMessage = commitMessageCache.get(cacheKey);
  if (cachedMessage) {
    return cachedMessage;
  }

  const existingRequest = commitMessageRequests.get(cacheKey);
  if (existingRequest) {
    try {
      return await existingRequest;
    } catch {
      return "";
    }
  }

  const request = (async () => {
    const aiMessage = await generateAiCommitMessage({
      changes,
      customInstructions,
      diffText,
      projectPath,
      provider,
    });

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

export const pushProjectGitChanges = async (
  projectPath,
  {
    commitMessage = "",
    customInstructions = "",
    includeUnstaged = true,
    nextStep = "push",
  } = {},
) => {
  let commit = null;
  if (nextStep === "commit-push") {
    commit = await commitProjectGitChanges(projectPath, {
      customInstructions,
      includeUnstaged,
      message: commitMessage,
    });
  }

  const repoInfo = await ensureProjectGitRepository(projectPath);
  const branch = getGitActionBranchName(repoInfo.branch);
  if (!branch) {
    throw new Error("Cannot push from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch);
  const args = metadata.upstreamBranch
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
    upstreamBranch: status.upstreamBranch,
  };
};

const getPullRequestBaseRef = async (repoRoot, remoteName, baseBranch) => {
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

const readGitCommitCount = async (repoRoot, rangeRef) => {
  const args = rangeRef
    ? ["rev-list", "--count", rangeRef]
    : ["rev-list", "--count", "HEAD"];
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (!result.ok) {
    return 0;
  }

  return Number.parseInt(result.stdout.trim(), 10) || 0;
};

const readGitPushPreviewCommits = async (repoRoot, rangeRef) => {
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

export const getProjectGitPushPreview = async (projectPath) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const branch = getGitActionBranchName(repoInfo.branch);
  if (!branch) {
    throw new Error("Cannot push from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch);
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
  const rangeRef = baseRef ? `${baseRef}..HEAD` : null;
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
  const [commitSubjects, diffStat] = await Promise.all([
    readPullRequestCommitSubjects(repoInfo.repoRoot, baseRef),
    readPullRequestDiffStat(repoInfo.repoRoot, baseRef),
  ]);
  const pullRequestTitle =
    normalizeGitActionText(title) ||
    buildGeneratedPullRequestTitle(headBranch, commitSubjects);
  const pullRequestBody =
    normalizeGitActionText(description) ||
    buildGeneratedPullRequestBody({
      branch: headBranch,
      commitSubjects,
      customInstructions,
      diffStat,
    });

  const args = [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    headBranch,
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
    baseBranch,
    commit,
    draft,
    headBranch,
    push,
    status: await listProjectGitChanges(projectPath),
    title: pullRequestTitle,
    url: parsePullRequestUrl(output),
  };
};
