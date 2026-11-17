/**
 * Generated git text on the host: the commit message and the pull request
 * details a model writes for a project's changes.
 *
 * One module owns what each is written from, the prompt it is asked with,
 * how the model's answer is cleaned up, and, for pull requests, the text
 * used when there is no model or no answer. Commit messages are remembered
 * by the changes they describe and the model settings, and a request under
 * way is shared: every client following the host warms the same message
 * when a turn ends, and the pull request dialog reuses it.
 *
 * The model, the status and diff reads and the pull request's git reads are
 * passed in as ports: the provider registry and git in production, fakes in
 * tests.
 */
import { selectCommitChanges } from "../../shared/git-changes.js";
import { getProvider } from "../providers/registry.js";
import {
  ensureProjectGitRepository,
  getGitActionBranchName,
  getProjectGitBulkCachedDiff,
  getProjectGitBulkDiff,
  getProjectGitChangesFingerprint,
  gitRepositories,
  listProjectGitChanges,
  runGitCommand,
} from "./core.js";

/** The longest diff a commit message prompt carries. */
const COMMIT_MESSAGE_DIFF_MAX_CHARS = 20_000;
/** How many commit messages the host remembers. */
const COMMIT_MESSAGE_CACHE_MAX_ENTRIES = 30;

const COMMIT_MESSAGE_INSTRUCTION =
  "You write concise, accurate git commit subjects. Return only the subject line.";

const PULL_REQUEST_TITLE_INSTRUCTION =
  "Generate one concise pull request title for these changes. Use imperative mood, no markdown, no quotes, no trailing period. Be specific about behavior, not just filenames. Return only the title.";

const PULL_REQUEST_BODY_INSTRUCTION =
  'Write a pull request description in GitHub-flavored markdown for these changes. Start with a "## Summary" section describing the high-level purpose. Then add a "## Changes" section listing the key changes as bullet points. Only mention concrete behavior changes, not just filenames. Return only the description body.';

const trimmedText = (value) => (typeof value === "string" ? value.trim() : "");

/** The first non-empty line of a model's answer, trimmed. */
const firstLine = (value) =>
  String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";

const sanitizeCommitMessage = (value) =>
  firstLine(value)
    .replace(/^commit message:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

const sanitizePullRequestTitle = (value) =>
  firstLine(value)
    .replace(/^pull request title:\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

const sanitizePullRequestBody = (value) => {
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

const truncateCommitMessageDiff = (diffText) =>
  diffText.length <= COMMIT_MESSAGE_DIFF_MAX_CHARS
    ? diffText
    : `${diffText.slice(0, COMMIT_MESSAGE_DIFF_MAX_CHARS)}\n\n[diff truncated]`;

const buildCommitMessagePrompt = ({
  changes,
  customInstructions,
  diffText,
}) => {
  const instructions = trimmedText(customInstructions);
  return [
    "Generate one concise git commit subject for these changes.",
    "Use imperative mood, no markdown, no quotes, no trailing period.",
    "Be specific about behavior, not just filenames.",
    "Return only the commit subject.",
    instructions ? `User instructions: ${instructions}` : null,
    "",
    "Changed files:",
    changes.map((change) => `- ${change.status}: ${change.path}`).join("\n"),
    "",
    "Diff:",
    truncateCommitMessageDiff(diffText),
  ]
    .filter((part) => part !== null)
    .join("\n");
};

const buildPullRequestPrompt = ({
  branch,
  commitSubjects,
  customInstructions,
  diffStat,
}) => {
  const instructions = trimmedText(customInstructions);
  return [
    `Branch: ${branch || "current branch"}`,
    commitSubjects.length > 0 ? "Commits:" : null,
    ...commitSubjects.slice(0, 12).map((subject) => `- ${subject}`),
    instructions ? `User instructions: ${instructions}` : null,
    diffStat ? "\nDiff stat:\n```text" : null,
    diffStat || null,
    diffStat ? "```" : null,
  ]
    .filter((part) => part !== null)
    .join("\n");
};

const humanizeBranchName = (branch) =>
  trimmedText(branch)
    .replace(/^refs\/heads\//, "")
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase()) || "Changes";

/** The title without a model: the newest commit, else the branch's name. */
const fallbackPullRequestTitle = (branch, commitSubjects) =>
  commitSubjects[0] || humanizeBranchName(branch);

/** The description without a model: the commits, the diff stat, testing. */
const fallbackPullRequestBody = ({
  branch,
  commitSubjects,
  customInstructions,
  diffStat,
}) => {
  const summaryItems =
    commitSubjects.length > 0
      ? commitSubjects.slice(0, 8)
      : [`Prepare ${humanizeBranchName(branch).toLowerCase()}`];
  const instructions = trimmedText(customInstructions).toLowerCase();
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

/**
 * What a pull request from the checked-out branch is written from: its head
 * and base branch, and the commits and diff stat it adds to the base
 * (`baseOf`'s compare ref). A base asked for but not fetched here is still
 * proposed to GitHub, with no commits to read.
 */
const readProjectPullRequestSource = async (
  projectPath,
  requestedBaseBranch,
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const headBranch = getGitActionBranchName(repoInfo.branch);
  if (!headBranch) {
    throw new Error("Cannot create a pull request from a detached HEAD.");
  }

  const requested = trimmedText(requestedBaseBranch);
  const base = await gitRepositories.baseOf(repoInfo.repoRoot, {
    base: requested,
  });
  const baseBranch = base?.baseBranch ?? requested;
  if (!baseBranch) {
    throw new Error(
      "Unable to determine the base branch for this pull request.",
    );
  }

  const baseRef = base?.compareRef ?? null;
  const [commitSubjects, diffStat] = await Promise.all([
    readPullRequestCommitSubjects(repoInfo.repoRoot, baseRef),
    readPullRequestDiffStat(repoInfo.repoRoot, baseRef),
  ]);
  return { baseBranch, commitSubjects, diffStat, headBranch };
};

/**
 * @typedef {{
 *   model?: string | null,
 *   modelSpeed?: string,
 *   provider?: string,
 *   reasoningEffort?: string | null,
 * }} GenerationSettings
 *
 * @typedef {GenerationSettings & {
 *   projectPath: string,
 *   prompt: string,
 *   system: string,
 * }} GenerateTextRequest
 *
 * @typedef {{
 *   baseBranch: string,
 *   commitSubjects: string[],
 *   diffStat: string,
 *   headBranch: string,
 * }} PullRequestSource
 */

/**
 * Generated git text over its ports.
 * @param {{
 *   generateText?: (request: GenerateTextRequest) => Promise<string>,
 *   readStatus?: (projectPath: string) => Promise<{ changes: any[] }>,
 *   readDiff?: (projectPath: string, changes: any[], options: { includeUnstaged: boolean }) => Promise<string>,
 *   readPullRequestSource?: (projectPath: string, requestedBaseBranch: string | null | undefined) => Promise<PullRequestSource>,
 *   warn?: (message: string, error: unknown) => void,
 *   cacheSize?: number,
 * }} [ports]
 */
export const createGeneratedGitText = ({
  // One-shot text through the chat's provider (see providers/registry.js).
  generateText = ({ provider, ...options }) =>
    getProvider(provider).generateText(options),
  readStatus = (projectPath) => listProjectGitChanges(projectPath),
  readDiff = (projectPath, changes, { includeUnstaged }) =>
    includeUnstaged
      ? getProjectGitBulkDiff(projectPath, changes)
      : getProjectGitBulkCachedDiff(projectPath, changes),
  readPullRequestSource = readProjectPullRequestSource,
  warn = (message, error) => console.warn(message, error),
  cacheSize = COMMIT_MESSAGE_CACHE_MAX_ENTRIES,
} = {}) => {
  /** Commit messages with text, oldest written first. */
  const commitMessages = new Map();
  /** Commit messages being generated, by the same key. */
  const commitMessageRequests = new Map();

  const rememberCommitMessage = (key, message) => {
    commitMessages.set(key, message);
    if (commitMessages.size <= cacheSize) {
      return;
    }
    const oldestKey = commitMessages.keys().next().value;
    if (oldestKey) {
      commitMessages.delete(oldestKey);
    }
  };

  /**
   * One subject line for the changes a commit takes, or "" when there are
   * none, their diff is empty or the model gave nothing. Remembered by those
   * changes (their fingerprint, read before any diff) and the settings; a
   * request under way for the same key is joined. A failure is logged and
   * answers "", or is thrown with `throwOnError`; it is never remembered.
   * @param {string} projectPath
   * @param {GenerationSettings & {
   *   customInstructions?: string | null,
   *   includeUnstaged?: boolean,
   *   throwOnError?: boolean,
   * }} [options]
   * @returns {Promise<string>}
   */
  const commitMessage = async (
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
    const status = await readStatus(projectPath);
    const changes = selectCommitChanges(status.changes, includeUnstaged);
    if (changes.length === 0) {
      return "";
    }

    const key = getProjectGitChangesFingerprint(changes, {
      customInstructions,
      includeUnstaged,
      model,
      modelSpeed,
      projectPath,
      provider,
      reasoningEffort,
    });
    const remembered = commitMessages.get(key);
    if (remembered) {
      return remembered;
    }

    const existingRequest = commitMessageRequests.get(key);
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
      const diffText = await readDiff(projectPath, changes, {
        includeUnstaged,
      });
      if (!diffText.trim()) {
        return "";
      }

      return sanitizeCommitMessage(
        await generateText({
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
          system: COMMIT_MESSAGE_INSTRUCTION,
        }),
      );
    })();
    commitMessageRequests.set(key, request);

    try {
      const message = await request;
      if (message) {
        rememberCommitMessage(key, message);
      }
      return message;
    } catch (error) {
      warn("[git] AI commit message generation failed:", error);
      if (throwOnError) {
        throw error;
      }
      return "";
    } finally {
      commitMessageRequests.delete(key);
    }
  };

  /**
   * The title and description of a pull request from the checked-out
   * branch, its head and base branch, and with `commit-push-create` the
   * commit message it will commit first (listed as its newest commit). The
   * model writes the title and description when one is named; without one,
   * or for whichever it fails or leaves empty, they are written from the
   * commits and the diff stat. Not remembered.
   * @param {string} projectPath
   * @param {GenerationSettings & {
   *   baseBranch?: string | null,
   *   customInstructions?: string | null,
   *   includeUnstaged?: boolean,
   *   nextStep?: "create" | "push-create" | "commit-push-create",
   * }} [options]
   */
  const pullRequestDetails = async (
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
    const source = await readPullRequestSource(
      projectPath,
      requestedBaseBranch,
    );
    const generatedCommitMessage =
      nextStep === "commit-push-create"
        ? await commitMessage(projectPath, {
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
          ...source.commitSubjects.filter(
            (subject) => subject !== generatedCommitMessage,
          ),
        ]
      : source.commitSubjects;
    const written = {
      branch: source.headBranch,
      commitSubjects,
      customInstructions,
      diffStat: source.diffStat,
    };

    let title = "";
    let description = "";
    if (trimmedText(model)) {
      try {
        const settings = {
          model,
          modelSpeed,
          projectPath,
          prompt: buildPullRequestPrompt(written),
          provider,
          reasoningEffort,
        };
        const [titleText, bodyText] = await Promise.all([
          generateText({ ...settings, system: PULL_REQUEST_TITLE_INSTRUCTION }),
          generateText({ ...settings, system: PULL_REQUEST_BODY_INSTRUCTION }),
        ]);
        title = sanitizePullRequestTitle(titleText);
        description = sanitizePullRequestBody(bodyText);
      } catch (error) {
        warn("[git] AI pull request details generation failed:", error);
      }
    }

    return {
      baseBranch: source.baseBranch,
      commitMessage: generatedCommitMessage || null,
      description: description || fallbackPullRequestBody(written),
      headBranch: source.headBranch,
      title:
        title || fallbackPullRequestTitle(source.headBranch, commitSubjects),
    };
  };

  return { commitMessage, pullRequestDetails };
};

/** The host's generated git text, over its providers and git. */
export const generatedGitText = createGeneratedGitText();
