import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runGitCommand } from "./project-git/core.js";
import { ensureProjectDirectory } from "./project-git-service.js";
import { execFileAsync } from "./shared/cli.js";

// Pull request lookups for the Code workspace PR panel.
const requestSchema = z.object({
  projectPath: z.string().min(1),
  action: z.enum([
    "context",
    "list",
    "detail",
    "files",
    "comments",
    "reviews",
    "threads",
    "edit",
    "comment",
    "editComment",
    "inline",
    "reply",
    "review",
    "checkout",
    "merge",
    "mergeInfo",
  ]),
  repository: z.string().optional(),
  number: z.number().int().positive().optional(),
  page: z.number().int().min(1).max(1000).default(1),
  state: z.enum(["open", "closed", "merged", "all"]).default("open"),
  search: z.string().max(200).default(""),
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  commentId: z.number().int().positive().optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  updatedAt: z.string().optional(),
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
});

async function gh(cwd, args, json = true) {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return json ? JSON.parse(stdout || "null") : stdout;
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("Install GitHub CLI (gh) to use pull requests.");
    throw new Error(
      error.stderr?.trim() || error.message || "GitHub request failed.",
    );
  }
}

async function api(cwd, host, endpoint, method = "GET", body) {
  const args = ["api", "--hostname", host, "--method", method, endpoint];
  if (body === undefined) return gh(cwd, args);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dream-code-pr-"));
  const file = path.join(directory, "body.json");
  try {
    await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 });
    return await gh(cwd, [...args, "--input", file]);
  } finally {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
}

async function repository(cwd) {
  const repo = await gh(cwd, [
    "repo",
    "view",
    "--json",
    "nameWithOwner,url,viewerPermission",
  ]);
  const host = new URL(repo.url).hostname;
  return {
    host,
    name: repo.nameWithOwner,
    key: `${host}/${repo.nameWithOwner}`,
    permission: repo.viewerPermission,
  };
}

function summary(pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.merged_at || pr.pull_request?.merged_at ? "merged" : pr.state,
    draft: Boolean(pr.draft),
    author: pr.user?.login ?? "",
    authorAvatarUrl: pr.user?.avatar_url ?? "",
    commit: pr.head?.sha,
    updatedAt: pr.updated_at,
  };
}

function remoteRepository(url) {
  const match = url
    .trim()
    .match(
      /^(?:https?:\/\/|ssh:\/\/)?(?:[^/@]+@)?([^/:]+)[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/,
    );
  return match ? { host: match[1], name: match[2] } : null;
}

function required(value, label) {
  if (value === undefined || value === null)
    throw new Error(`${label} is required.`);
  return value;
}

// True when every commit on the local branch is already part of the PR head,
// i.e. the branch tip equals the PR head or is behind it.
async function branchHasNoWorkBeyond(cwd, branch, prHeadSha) {
  if (!prHeadSha) return false;
  const tip = await runGitCommand(cwd, ["rev-parse", `refs/heads/${branch}`], {
    allowFailure: true,
  });
  if (!tip.ok) return false;
  if (tip.stdout.trim() === prHeadSha) return true;
  const ancestor = await runGitCommand(
    cwd,
    ["merge-base", "--is-ancestor", `refs/heads/${branch}`, prHeadSha],
    { allowFailure: true },
  );
  return ancestor.ok;
}

async function execute(input) {
  const cwd = input.projectPath;
  await ensureProjectDirectory(cwd);
  const repo = await repository(cwd);
  if (input.repository && input.repository !== repo.key) {
    throw new Error("The repository changed. Refresh before continuing.");
  }
  const base = `repos/${repo.name}`;
  const get = (endpoint) => api(cwd, repo.host, endpoint);
  const write = (endpoint, method, body) =>
    api(cwd, repo.host, endpoint, method, body);
  if (input.action === "context") {
    const branchResult = await runGitCommand(
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowFailure: true },
    );
    const branch = branchResult.ok ? branchResult.stdout.trim() : null;
    let current = null;
    if (branch) {
      const remoteResult = await runGitCommand(cwd, [
        "for-each-ref",
        "--format=%(push:remotename)%09%(push:remoteref)%09%(upstream:remotename)%09%(upstream:remoteref)",
        `refs/heads/${branch}`,
      ]);
      const [pushRemote, pushRef, upstreamRemote, upstreamRef] =
        remoteResult.stdout.replace(/[\r\n]+$/, "").split("\t");
      const remote = pushRemote || upstreamRemote || "origin";
      const headBranch = (
        pushRef ||
        (remote === upstreamRemote ? upstreamRef : "") ||
        `refs/heads/${branch}`
      ).replace(/^refs\/heads\//, "");
      const url = await runGitCommand(cwd, ["remote", "get-url", remote], {
        allowFailure: true,
      });
      const headRepo = url.ok ? remoteRepository(url.stdout) : null;
      if (headRepo?.host.toLowerCase() === repo.host.toLowerCase()) {
        const query = new URLSearchParams({
          head: `${headRepo.name.split("/")[0]}:${headBranch}`,
          per_page: "100",
          sort: "updated",
          direction: "desc",
        });
        const exactHead = (pr) =>
          pr.head.repo?.full_name.toLowerCase() === headRepo.name.toLowerCase();
        const open = await get(`${base}/pulls?${query}&state=open`);
        current = open.find(exactHead) ?? null;
        if (!current) {
          // A closed or merged PR only belongs to this branch while the branch
          // has no newer work. Long-lived branches (dev, release/...) keep
          // being reused after their PR merges and must not show it forever.
          const closed = (
            await get(`${base}/pulls?${query}&state=closed`)
          ).filter(exactHead);
          for (const pr of closed) {
            if (await branchHasNoWorkBeyond(cwd, branch, pr.head?.sha)) {
              current = pr;
              break;
            }
          }
        }
      }
    }
    return {
      repository: repo.key,
      branch,
      current: current ? summary(current) : null,
    };
  }
  if (input.action === "list") {
    const state =
      input.state === "all"
        ? ""
        : input.state === "closed"
          ? "is:closed is:unmerged"
          : `is:${input.state}`;
    const term = input.search.trim().replace(/["\\]/g, " ");
    const search = /^#?\d+$/.test(term)
      ? term.replace("#", "")
      : term
        ? `"${term}" in:title`
        : "";
    const query = new URLSearchParams({
      q: `repo:${repo.name} is:pr ${state} ${search}`,
      sort: "updated",
      order: "desc",
      per_page: "30",
      page: String(input.page),
    });
    const result = await get(`search/issues?${query}`);
    return {
      items: result.items.map(summary),
      hasMore: input.page * 30 < Math.min(result.total_count, 1000),
    };
  }
  const number = required(input.number, "Pull request number");
  const prPath = `${base}/pulls/${number}`;
  if (["files", "comments", "reviews", "threads"].includes(input.action)) {
    if (input.action === "files") {
      const current = await get(prPath);
      if (current.head.sha !== required(input.commit, "Displayed commit"))
        throw new Error(
          "New commits were pushed. Refresh this PR before loading its diff.",
        );
    }
    const endpoint =
      input.action === "comments"
        ? `${base}/issues/${number}/comments`
        : `${prPath}/${input.action === "threads" ? "comments" : input.action}`;
    const items = await get(`${endpoint}?per_page=100&page=${input.page}`);
    if (
      input.action === "files" &&
      (await get(prPath)).head.sha !== input.commit
    )
      throw new Error(
        "The PR changed while loading its diff. Refresh to continue.",
      );
    return { items, hasMore: items.length === 100 };
  }
  const pr = await get(prPath);
  if (input.action === "mergeInfo") {
    const settings = await get(base);
    return {
      ...summary(pr),
      head: pr.head.ref,
      base: pr.base.ref,
      canMerge: ["ADMIN", "MAINTAIN", "WRITE"].includes(repo.permission),
      methods: [
        settings.allow_merge_commit && "merge",
        settings.allow_squash_merge && "squash",
        settings.allow_rebase_merge && "rebase",
      ].filter(Boolean),
    };
  }
  if (input.action === "merge") {
    if (pr.state !== "open" || pr.draft)
      throw new Error("Only open, non-draft pull requests can be merged.");
    const commit = required(input.commit, "PR head commit");
    if (pr.head.sha !== commit)
      throw new Error("This PR changed on GitHub. Refresh before merging.");
    const settings = await get(base);
    const method = required(input.mergeMethod, "Merge method");
    const allowed = {
      merge: settings.allow_merge_commit,
      squash: settings.allow_squash_merge,
      rebase: settings.allow_rebase_merge,
    };
    if (!allowed[method])
      throw new Error("This merge method is not enabled for this repository.");
    const result = await write(`${prPath}/merge`, "PUT", {
      sha: commit,
      merge_method: method,
    });
    if (!result.merged)
      throw new Error(result.message || "GitHub could not merge this PR.");
    return result;
  }
  if (input.action === "checkout") {
    const status = await runGitCommand(cwd, ["status", "--porcelain=v1"]);
    if (status.stdout.trim())
      throw new Error(
        "Commit or stash local changes before checking out a PR branch.",
      );
    await gh(
      cwd,
      ["pr", "checkout", String(number), "--repo", `${repo.host}/${repo.name}`],
      false,
    );
    return { checkedOut: true };
  }
  if (input.action === "detail") {
    const [viewer, checks] = await Promise.all([
      get("user"),
      gh(cwd, [
        "pr",
        "view",
        String(number),
        "--repo",
        `${repo.host}/${repo.name}`,
        "--json",
        "statusCheckRollup",
      ]).catch(() => null),
    ]);
    return {
      ...summary(pr),
      body: pr.body ?? "",
      head: pr.head.ref,
      base: pr.base.ref,
      commit: pr.head.sha,
      canEdit:
        viewer.login === pr.user?.login ||
        ["ADMIN", "MAINTAIN", "WRITE"].includes(repo.permission),
      viewer: viewer.login,
      reviewers: pr.requested_reviewers.map((user) => user.login),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      checks: checks?.statusCheckRollup ?? null,
    };
  }
  if (input.action === "edit") {
    if (input.title === undefined && input.body === undefined)
      throw new Error("Provide a title or description to update.");
    if (pr.updated_at !== required(input.updatedAt, "Original update time"))
      throw new Error(
        "This PR changed on GitHub. Refresh and review your edits before saving.",
      );
    return write(prPath, "PATCH", {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
  }
  const body = input.body?.trim() ?? "";
  if (!body && !(input.action === "review" && input.event === "APPROVE"))
    throw new Error("Write a comment before posting.");
  if (input.action === "comment")
    return write(`${base}/issues/${number}/comments`, "POST", { body });
  if (input.action === "editComment") {
    const endpoint = `${base}/issues/comments/${required(input.commentId, "Comment")}`;
    const [comment, viewer] = await Promise.all([get(endpoint), get("user")]);
    if (
      !comment.issue_url.endsWith(`/issues/${number}`) ||
      comment.user.login !== viewer.login
    )
      throw new Error("You can only edit your own comments on this PR.");
    if (
      comment.updated_at !== required(input.updatedAt, "Original update time")
    )
      throw new Error("This comment changed. Refresh before saving.");
    return write(endpoint, "PATCH", { body });
  }
  if (input.action === "reply") {
    return write(
      `${prPath}/comments/${required(input.commentId, "Thread")}/replies`,
      "POST",
      { body },
    );
  }
  if (pr.head.sha !== required(input.commit, "Reviewed commit"))
    throw new Error(
      "New commits were pushed. Refresh the diff before posting your review.",
    );
  if (input.action === "inline") {
    return write(`${prPath}/comments`, "POST", {
      body,
      commit_id: input.commit,
      path: required(input.path, "File"),
      line: required(input.line, "Line"),
      side: required(input.side, "Diff side"),
    });
  }
  if (input.action === "review")
    return write(`${prPath}/reviews`, "POST", {
      body,
      commit_id: input.commit,
      event: required(input.event, "Review action"),
    });
  throw new Error("Unsupported action.");
}

export function registerCodePullRequestRoutes(app) {
  app.post("/api/code-pull-requests", async (c) => {
    const parsed = requestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.text("Invalid pull request request.", 400);
    try {
      return c.json(await execute(parsed.data));
    } catch (error) {
      return c.text(error.message || "Unable to access GitHub.", 400);
    }
  });
}
