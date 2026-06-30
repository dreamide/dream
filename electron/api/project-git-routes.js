import { promises as fs } from "node:fs";
import { TextDecoder } from "node:util";
import {
  checkoutProjectGitBranch,
  commitProjectGitChanges,
  createProjectGitWorktree,
  createProjectPullRequest,
  detectProjectIcon,
  ensureProjectDirectory,
  generateProjectGitCommitMessage,
  generateProjectPullRequestDetails,
  getProjectGitDiff,
  getProjectGitPushPreview,
  listProjectFiles,
  listProjectGitBranches,
  listProjectGitChanges,
  listProjectGitWorktrees,
  MIME_TYPES,
  projectFileRequestSchema,
  projectFilesRequestSchema,
  projectGitBranchesRequestSchema,
  projectGitCheckoutRequestSchema,
  projectGitCommitMessageRequestSchema,
  projectGitCommitRequestSchema,
  projectGitCreatePullRequestSchema,
  projectGitCreateWorktreeRequestSchema,
  projectGitDiffRequestSchema,
  projectGitPullRequestDetailsRequestSchema,
  projectGitPushPreviewRequestSchema,
  projectGitPushRequestSchema,
  projectGitRemoveWorktreeRequestSchema,
  projectGitRevertFileRequestSchema,
  projectGitStatusRequestSchema,
  projectGitWorktreesRequestSchema,
  projectIconRequestSchema,
  pushProjectGitChanges,
  removeProjectGitWorktree,
  resolveProjectPath,
  revertProjectGitFile,
} from "./project-git-service.js";

const PROJECT_FILE_PREVIEW_MAX_BYTES = 1024 * 1024;
const PROJECT_FILE_BINARY_SAMPLE_BYTES = 8192;
const PROJECT_FILE_BINARY_CONTROL_CHAR_RATIO = 0.1;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
};

const isAllowedTextControlByte = (byte) =>
  byte === 9 || byte === 10 || byte === 12 || byte === 13;

const isLikelyBinaryBuffer = (buffer) => {
  if (buffer.length === 0) return false;

  let controlByteCount = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 32 && !isAllowedTextControlByte(byte)) {
      controlByteCount += 1;
    }
  }

  if (
    controlByteCount / buffer.length >
    PROJECT_FILE_BINARY_CONTROL_CHAR_RATIO
  ) {
    return true;
  }

  try {
    utf8Decoder.decode(buffer);
    return false;
  } catch {
    return true;
  }
};

const isLikelyBinaryFile = async (absolutePath, size) => {
  const sampleLength = Math.min(size, PROJECT_FILE_BINARY_SAMPLE_BYTES);
  if (sampleLength === 0) return false;

  const file = await fs.open(absolutePath, "r");
  try {
    const sample = Buffer.alloc(sampleLength);
    const { bytesRead } = await file.read(sample, 0, sampleLength, 0);
    return isLikelyBinaryBuffer(sample.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
};

export const registerProjectGitRoutes = (app) => {
  app.post("/api/project-files", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectFilesRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { directory, maxResults, projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      const files = await listProjectFiles(projectPath, directory, maxResults);
      return c.json({ count: files.length, files });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to list files.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-file", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectFileRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { endLine, filePath, projectPath, startLine } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      const absolutePath = resolveProjectPath(projectPath, filePath);
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        return c.text(`Not a file: ${filePath}`, 400);
      }

      if (stats.size > PROJECT_FILE_PREVIEW_MAX_BYTES) {
        return c.text(
          `Files larger than ${formatBytes(PROJECT_FILE_PREVIEW_MAX_BYTES)} are not previewed.`,
          413,
        );
      }

      if (await isLikelyBinaryFile(absolutePath, stats.size)) {
        return c.text("Binary files cannot be previewed.", 415);
      }

      const fullText = await fs.readFile(absolutePath, "utf8");

      if (!startLine && !endLine) {
        return c.json({ content: fullText, filePath });
      }

      const lines = fullText.split(/\r?\n/);
      const safeStart = Math.max(1, startLine ?? 1);
      const safeEnd = Math.min(lines.length, endLine ?? lines.length);
      if (safeStart > safeEnd) {
        return c.text("startLine cannot be greater than endLine.", 400);
      }

      return c.json({
        content: lines.slice(safeStart - 1, safeEnd).join("\n"),
        endLine: safeEnd,
        filePath,
        startLine: safeStart,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read file.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-icon", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectIconRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    try {
      await ensureProjectDirectory(parsed.data.projectPath);
      return c.json({
        icon: await detectProjectIcon(parsed.data.projectPath),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to detect icon.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-status", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitStatusRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await listProjectGitChanges(projectPath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read Git status.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-branches", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitBranchesRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await listProjectGitBranches(projectPath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read Git branches.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-checkout", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCheckoutRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { branchName, create, projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(
        await checkoutProjectGitBranch(projectPath, branchName, create),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to switch Git branches.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-worktrees", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitWorktreesRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await listProjectGitWorktrees(projectPath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read worktrees.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-worktree-create", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCreateWorktreeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await createProjectGitWorktree(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to create worktree.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-worktree-remove", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitRemoveWorktreeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await removeProjectGitWorktree(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to remove worktree.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-commit", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCommitRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await commitProjectGitChanges(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to commit changes.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-commit-message", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCommitMessageRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json({
        commitMessage: await generateProjectGitCommitMessage(projectPath, {
          ...options,
          throwOnError: true,
        }),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to generate commit message.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-push", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitPushRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await pushProjectGitChanges(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to push changes.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-push-preview", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitPushPreviewRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await getProjectGitPushPreview(projectPath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to preview push.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-create-pr", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitCreatePullRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(await createProjectPullRequest(projectPath, options));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to create a pull request.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-pull-request-details", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitPullRequestDetailsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { projectPath, ...options } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(
        await generateProjectPullRequestDetails(projectPath, options),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to generate pull request details.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-diff", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitDiffRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { filePath, previousPath, projectPath, status } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(
        await getProjectGitDiff(projectPath, filePath, {
          previousPath,
          status,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read Git diff.";
      return c.text(message, 400);
    }
  });

  app.post("/api/project-git-revert-file", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = projectGitRevertFileRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { filePath, previousPath, projectPath, status } = parsed.data;

    try {
      await ensureProjectDirectory(projectPath);
      return c.json(
        await revertProjectGitFile(projectPath, filePath, {
          previousPath,
          status,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to revert file.";
      return c.text(message, 400);
    }
  });

  app.get("/api/project-file-raw", async (c) => {
    const projectPath = c.req.query("projectPath");
    const filePath = c.req.query("filePath");

    if (!projectPath || !filePath) {
      return c.text("Missing projectPath or filePath query parameter.", 400);
    }

    try {
      await ensureProjectDirectory(projectPath);
      const absolutePath = resolveProjectPath(projectPath, filePath);
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        return c.text(`Not a file: ${filePath}`, 400);
      }

      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const data = await fs.readFile(absolutePath);

      return new Response(data, {
        headers: { "Content-Type": contentType },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read file.";
      return c.text(message, 400);
    }
  });
};
