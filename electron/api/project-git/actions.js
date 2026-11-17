import path from "node:path";
import {
  ensureProjectGitRepository,
  getGitActionBranchName,
  getGitAheadBehindCounts,
  getGitCommandErrorMessage,
  getProjectGitMetadata,
  gitRepositories,
  listProjectGitChanges,
  readGitRangeFiles,
  resolveGitBranchUpstream,
  runGhCommand,
  runGitCommand,
} from "./core.js";
import { canonicalProjectRoot, normalizePath } from "./files.js";
import { generatedGitText } from "./generated-text.js";

const normalizeGitActionText = (value) =>
  typeof value === "string" ? value.trim() : "";

const getProjectGitRemote = async (repoInfo) => {
  const branch = getGitActionBranchName(repoInfo.branch);
  const upstream = branch
    ? await resolveGitBranchUpstream(repoInfo.repoRoot, branch)
    : null;
  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch);
  const remote = upstream?.remote ?? metadata.remoteName;
  if (!remote) {
    throw new Error("No Git remote is configured for this repository.");
  }
  return { remote, upstream };
};

export const fetchProjectGitChanges = async (projectPath) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const { remote } = await getProjectGitRemote(repoInfo);
  await runGitCommand(repoInfo.repoRoot, ["fetch", "--", remote]);
  return { remote };
};

export const pullProjectGitChanges = async (projectPath) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const branch = getGitActionBranchName(repoInfo.branch);
  if (!branch) {
    throw new Error("Cannot pull from a detached HEAD.");
  }
  const { remote, upstream } = await getProjectGitRemote(repoInfo);
  if (!upstream) {
    throw new Error(
      "This branch has no remote upstream. Set an upstream before pulling.",
    );
  }
  await runGitCommand(repoInfo.repoRoot, ["fetch", "--", remote]);
  const currentBranch = await runGitCommand(
    repoInfo.repoRoot,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { allowFailure: true },
  );
  if (!currentBranch.ok || currentBranch.stdout.trim() !== branch) {
    throw new Error(
      "The current branch changed while fetching. Try pulling again.",
    );
  }
  const { aheadCount, behindCount } = await getGitAheadBehindCounts(
    repoInfo.repoRoot,
    upstream.ref,
  );
  // A conflicted pull aborts the merge it started; it must never abort one
  // the user already has in progress.
  if (await gitRepositories.ref(repoInfo.repoRoot, "MERGE_HEAD")) {
    throw new Error(
      "A merge is already in progress. Finish or abort it before pulling.",
    );
  }
  const previousHead = await gitRepositories.ref(repoInfo.repoRoot, "HEAD");
  const merging = aheadCount > 0 && behindCount > 0;
  // Fetch followed by an explicit merge is a pull without implicit rebasing or
  // auto-stashing from the user's Git configuration. `--ff` fast-forwards when
  // the branch is only behind and makes a merge commit when it has diverged,
  // whatever `merge.ff` says.
  const mergeResult = await runGitCommand(
    repoInfo.repoRoot,
    [
      "merge",
      "--ff",
      "--no-edit",
      "--no-autostash",
      "--no-squash",
      upstream.ref,
    ],
    { allowFailure: true },
  );
  if (!mergeResult.ok) {
    if (
      merging &&
      (await gitRepositories.ref(repoInfo.repoRoot, "MERGE_HEAD"))
    ) {
      // The UI has nowhere to resolve conflicts, so the merge is undone and
      // the branch is left exactly as it was.
      const conflicts = await runGitCommand(
        repoInfo.repoRoot,
        ["diff", "--name-only", "--diff-filter=U"],
        { allowFailure: true },
      );
      await runGitCommand(repoInfo.repoRoot, ["merge", "--abort"], {
        allowFailure: true,
      });
      return {
        commitCount: 0,
        conflictingFiles: conflicts.ok
          ? conflicts.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .map(normalizePath)
          : [],
        status: "conflict",
        upstreamBranch: upstream.upstream,
      };
    }
    throw new Error(getGitCommandErrorMessage(mergeResult.error));
  }
  return {
    commitCount: behindCount,
    merged: merging,
    status: "pulled",
    upstreamBranch: upstream.upstream,
    ...(await readPulledChanges(
      repoInfo.repoRoot,
      previousHead,
      behindCount,
      merging,
    )),
  };
};

/**
 * What a pull from `previousHead` brought in: the incoming commits, newest
 * first, and the files the pull changed in the branch, like the summary
 * `git pull` prints. After a merge the incoming commits are the merge's
 * second parent's side, so the merge commit itself is not counted.
 * A branch with no commits before the pull has nothing to compare against.
 */
const readPulledChanges = async (
  repoRoot,
  previousHead,
  commitCount,
  merged,
) => {
  if (!previousHead || commitCount === 0) {
    return { commits: [], files: [], truncated: false };
  }
  const incoming = merged ? "HEAD^2" : "HEAD";
  const [commits, files] = await Promise.all([
    readGitPushPreviewCommits(repoRoot, `${previousHead}..${incoming}`),
    readGitRangeFiles(repoRoot, previousHead, "HEAD"),
  ]);
  return { commits, files, truncated: commits.length < commitCount };
};

export const getProjectGitRemoteUrl = async (projectPath) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const { remote } = await getProjectGitRemote(repoInfo);
  const result = await runGitCommand(repoInfo.repoRoot, [
    "remote",
    "get-url",
    "--",
    remote,
  ]);
  const remoteUrl = result.stdout.trim();
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(remoteUrl);
  let url;
  try {
    url = new URL(
      remoteUrl.includes("://")
        ? remoteUrl
        : scp && !remoteUrl.includes("\\")
          ? `ssh://${scp[1]}/${scp[2]}`
          : "",
    );
  } catch {
    throw new Error("This remote has no repository web URL.");
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
    throw new Error("This remote has no repository web URL.");
  }
  if (url.protocol === "ssh:" || url.protocol === "git:") {
    url = new URL(`https://${url.hostname}${url.pathname}`);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  return { url: url.href };
};

const getProjectGitPathspec = (projectPath, repoRoot) => {
  const relativeProjectPath = normalizePath(
    path.relative(repoRoot, canonicalProjectRoot(projectPath)),
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
    (await generatedGitText.commitMessage(projectPath, {
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

  if (!(await gitRepositories.ref(repoInfo.repoRoot, `refs/heads/${branch}`))) {
    throw new Error(`Branch ${branch} does not exist.`);
  }
  return { branch, headRef: `refs/heads/${branch}`, named: true };
};

/**
 * Why a push failed, in words: git's hint-laden answer to a branch behind its
 * remote is replaced, any other failure keeps git's own reason. A commit made
 * just before stays in the repository, which the message has to say.
 */
const getGitPushFailureMessage = (error, { committed }) => {
  const reason = /\((?:fetch first|non-fast-forward)\)/.test(error.message)
    ? "The remote has commits you don't have yet. Pull, then push again."
    : error.message;
  return committed
    ? `Committed locally, but the push failed. ${reason}`
    : reason;
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

  try {
    await runGitCommand(repoInfo.repoRoot, args);
  } catch (error) {
    throw new Error(getGitPushFailureMessage(error, { committed: !!commit }), {
      cause: error,
    });
  }

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
    parents = "",
  ] = record.split(GIT_LOG_FIELD_SEPARATOR);

  return {
    authorDate,
    authorEmail,
    authorName,
    hash,
    parents: parents.split(" ").filter(Boolean),
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
      // Newest first, but never a parent before its children: the graph
      // draws each commit's lines down to parents still to come.
      "--date-order",
      "--decorate=short",
      `--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%P%x1e`,
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

  // What is new to the remote: past the upstream, else past the remote
  // branch of the same name, else past the base (repository-context.js).
  const remoteBranchRef =
    metadata.remoteName &&
    (await gitRepositories.ref(
      repoInfo.repoRoot,
      `refs/remotes/${metadata.remoteName}/${branch}`,
    ))
      ? `${metadata.remoteName}/${branch}`
      : null;
  const baseRef =
    metadata.upstreamBranch ||
    remoteBranchRef ||
    ((await gitRepositories.baseOf(repoInfo.repoRoot))?.compareRef ?? null);
  // Without a base, the whole history of the pushed branch is new.
  const rangeRef = baseRef ? `${baseRef}..${target.headRef}` : target.headRef;
  const [commits, totalCommits] = await Promise.all([
    readGitPushPreviewCommits(repoInfo.repoRoot, rangeRef),
    gitRepositories.count(repoInfo.repoRoot, [rangeRef]),
  ]);

  return {
    aheadCount: metadata.upstreamBranch
      ? metadata.aheadCount
      : (totalCommits ?? 0),
    baseRef,
    behindCount: metadata.behindCount,
    branch,
    commits,
    remoteName: metadata.remoteName,
    target: metadata.upstreamBranch ?? `${metadata.remoteName}/${branch}`,
    totalCommits: totalCommits ?? 0,
    truncated: commits.length < (totalCommits ?? 0),
    upstreamBranch: metadata.upstreamBranch,
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

  const generatedDetails = await generatedGitText.pullRequestDetails(
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
