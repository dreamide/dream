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
  getCursorCliSpawnErrorMessage,
  normalizeCursorCliModel,
  resolveCursorCliLaunch,
} from "../providers/cursor-cli.js";
import { normalizeClaudeCodeModel } from "../providers/model-options.js";
import {
  fetchAnthropicLowCostModel,
  fetchCursorLowCostModel,
  fetchOpenAiLowCostModel,
  fetchOpenCodeLowCostModel,
} from "../providers/provider-models.js";
import {
  getGitCommandErrorMessage,
  getGitRepositoryInfo,
  getProjectGitBulkCachedDiff,
  getProjectGitBulkDiff,
  getProjectGitChangesFingerprint,
  getProjectGitMetadata,
  gitRefExists,
  listProjectGitChanges,
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

const generateClaudeCommitMessage = async ({
  customInstructions,
  diffText,
  changes,
  projectPath,
}) => {
  const model = (await fetchAnthropicLowCostModel()) || "haiku";
  const result = await generateText({
    model: claudeCode(normalizeClaudeCodeModel(model), {
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
            cwd: projectPath,
            env: process.env,
            shell: launch.shell ?? false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
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

const generateOpenCodeCommitMessage = async ({
  customInstructions,
  diffText,
  changes,
  projectPath,
}) =>
  new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const outputLines = [];
    const prompt = [
      "You write concise, accurate git commit subjects. Return only the subject line.",
      buildCommitMessagePrompt({ changes, customInstructions, diffText }),
    ].join("\n\n");

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
          const event = JSON.parse(trimmed);
          const text =
            event.type === "text" &&
            event.part?.type === "text" &&
            typeof event.part.text === "string"
              ? event.part.text
              : "";
          if (text) {
            outputLines.push(text);
          }
        } catch {
          outputLines.push(trimmed);
        }
      }
    };

    void fetchOpenCodeLowCostModel()
      .then((model) => {
        if (!model) {
          throw new Error("No OpenCode commit message model is available.");
        }

        const child = spawn(
          "opencode",
          [
            "run",
            "--format",
            "json",
            "--dir",
            projectPath,
            "--model",
            model,
            "--agent",
            "plan",
          ],
          {
            cwd: projectPath,
            env: process.env,
            shell: process.platform === "win32",
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );

        child.stdin.end(prompt);
        child.stdout.on("data", handleStdoutChunk);
        child.stderr.on("data", (chunk) => {
          stderrBuffer += chunk.toString();
        });
        child.on("error", (error) => {
          reject(
            new Error(
              error instanceof Error
                ? error.message
                : "OpenCode CLI request failed.",
            ),
          );
        });
        child.on("close", (code) => {
          if (stdoutBuffer.trim()) {
            outputLines.push(stdoutBuffer.trim());
          }

          if (code === 0) {
            resolve(sanitizeGeneratedCommitMessage(outputLines.join(" ")));
            return;
          }

          reject(
            new Error(
              stderrBuffer.trim() || `OpenCode CLI exited with code ${code}.`,
            ),
          );
        });
      })
      .catch((error) => {
        reject(
          new Error(
            error instanceof Error
              ? error.message
              : "OpenCode CLI request failed.",
          ),
        );
      });
  });

const getCursorEventText = (event) => {
  if (!event || typeof event !== "object") {
    return "";
  }

  if (event.type === "result" && typeof event.result === "string") {
    return event.result;
  }

  if (event.type !== "assistant" || !event.message) {
    return "";
  }

  const content = event.message.content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part?.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  }

  return typeof event.message.text === "string" ? event.message.text : "";
};

const generateCursorCommitMessage = async ({
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
      "You write concise, accurate git commit subjects. Return only the subject line.",
      buildCommitMessagePrompt({ changes, customInstructions, diffText }),
    ].join("\n\n");

    const handleEvent = (event) => {
      const text = getCursorEventText(event);
      if (text) {
        latestText += text;
        if (event.type === "result") {
          latestText = text;
        }
      }

      if (event?.type === "error") {
        const detail =
          typeof event.message === "string"
            ? event.message
            : typeof event.error === "string"
              ? event.error
              : "";
        if (detail) {
          stderrBuffer += `${detail}\n`;
        }
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

    void Promise.all([resolveCursorCliLaunch(), fetchCursorLowCostModel()])
      .then(([launch, model]) => {
        const child = spawn(
          launch.command,
          [
            ...launch.argsPrefix,
            "-p",
            "--trust",
            "--output-format",
            "stream-json",
            "--mode",
            "ask",
            "--model",
            normalizeCursorCliModel(model),
            prompt,
          ],
          {
            cwd: projectPath,
            env: process.env,
            shell: launch.shell ?? false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );

        child.stdout.on("data", handleStdoutChunk);
        child.stderr.on("data", (chunk) => {
          stderrBuffer += chunk.toString();
        });
        child.on("error", (error) => {
          reject(new Error(getCursorCliSpawnErrorMessage(error)));
        });
        child.on("close", (code) => {
          if (stdoutBuffer.trim()) {
            try {
              handleEvent(JSON.parse(stdoutBuffer.trim()));
            } catch {
              stderrBuffer += `${stdoutBuffer.trim()}\n`;
            }
          }

          if (code === 0) {
            resolve(sanitizeGeneratedCommitMessage(latestText));
            return;
          }

          reject(
            new Error(
              stderrBuffer.trim() || `Cursor CLI exited with code ${code}.`,
            ),
          );
        });
      })
      .catch((error) => {
        reject(
          new Error(
            error instanceof Error
              ? error.message
              : "Cursor CLI request failed.",
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

  if (provider === "opencode") {
    return generateOpenCodeCommitMessage({
      changes,
      customInstructions,
      diffText,
      projectPath,
    });
  }

  if (provider === "cursor") {
    return generateCursorCommitMessage({
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

  // Use a lightweight fingerprint (derived from git status metadata) so we can
  // check the cache *before* fetching any diffs. This avoids the most expensive
  // part of the pipeline when the result is already cached.
  const cacheKey = getProjectGitChangesFingerprint(changes, {
    customInstructions,
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
    // Fetch all diffs in bulk — one git subprocess for all tracked files and
    // parallel file reads for untracked files, instead of N separate subprocess
    // spawns with redundant repo-info / HEAD resolution each time.
    const diffText = includeUnstaged
      ? await getProjectGitBulkDiff(projectPath, changes)
      : await getProjectGitBulkCachedDiff(projectPath, changes);

    if (!diffText.trim()) {
      return "";
    }

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
    nextStep = "create",
    provider = "openai",
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
          provider,
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

  return {
    baseBranch: context.baseBranch,
    commitMessage: generatedCommitMessage || null,
    description: buildGeneratedPullRequestBody({
      branch: context.headBranch,
      commitSubjects,
      customInstructions,
      diffStat,
    }),
    headBranch: context.headBranch,
    title: buildGeneratedPullRequestTitle(context.headBranch, commitSubjects),
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
