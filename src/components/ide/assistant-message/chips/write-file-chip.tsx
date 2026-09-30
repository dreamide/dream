import { ExternalLinkIcon, PenLineIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import type { ToolPart } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type {
  ProjectGitChangeStatus,
  ProjectGitStatusEntry,
} from "@/types/ide";
import {
  describeWrite,
  getChipToolKind,
  getCommandOutputText,
  getToolCallSource,
  isToolLikePart,
  type MessagePart,
  type ToolLikePart,
  type WriteToolCall,
} from "../../assistant-message-tools";
import { IdeDiffViewer } from "../../diff-viewer";
import { normalizeProjectPathKey } from "../../ide-state";
import { useIdeStore } from "../../ide-store";
import { MaterialFileIcon } from "../../material-file-icon";
import {
  ActionApproval,
  ApprovalStatusLabel,
  buildWriteDiff,
  CHIP_DETAIL_HEADER_CLASSES,
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  ChipContent,
  getDiffStats,
  getWriteFileStateLabel,
  inferLanguage,
  isString,
  JsonBlock,
  normalizeEmbeddedLineNumbers,
  parseSingleDiff,
  type ToolApprovalHandler,
} from "../shared";

const getEditDiff = (
  edit: WriteToolCall["edit"],
  filePath: string | null,
): string | null =>
  edit && filePath
    ? buildWriteDiff({
        content: edit.next,
        filePath,
        mode: null,
        previousContent: edit.previous,
      })
    : null;

const normalizePathForCompare = (value: string) =>
  value.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();

const getProjectRelativeFilePath = (
  filePath: string | null,
  projectPath: string | null | undefined,
): string | null => {
  if (!filePath) {
    return null;
  }

  const normalizedFilePath = filePath.replace(/\\/g, "/");
  if (!projectPath) {
    return normalizedFilePath;
  }

  const normalizedProjectPath = projectPath
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  const filePathKey = normalizePathForCompare(normalizedFilePath);
  const projectPathKey = normalizePathForCompare(normalizedProjectPath);
  const projectPrefix = `${projectPathKey}/`;

  if (filePathKey.startsWith(projectPrefix)) {
    return normalizedFilePath.slice(normalizedProjectPath.length + 1);
  }

  return normalizedFilePath;
};

const getPathBasename = (filePath: string): string | null => {
  const basename = filePath.split(/[\\/]/).pop();
  return basename && basename.length > 0 ? basename : null;
};

const getDiffPathTargets = (
  filePath: string | null,
  projectRelativeFilePath: string | null,
) => {
  const targets = new Set<string>();

  for (const value of [projectRelativeFilePath, filePath]) {
    if (!value) {
      continue;
    }

    const normalized = normalizePathForCompare(value);
    if (normalized.length === 0) {
      continue;
    }

    targets.add(normalized);

    const basename = getPathBasename(value);
    if (basename && !normalized.includes("/")) {
      targets.add(normalizePathForCompare(basename));
    }
  }

  return [...targets];
};

const getDiffChunks = (outputText: string): string[] => {
  const markerPattern = /^diff --git |^Index: /gm;
  const markers = [...outputText.matchAll(markerPattern)];

  if (markers.length === 0) {
    return [];
  }

  return markers
    .map((marker, index) => {
      const start = marker.index ?? 0;
      const end =
        index + 1 < markers.length
          ? (markers[index + 1].index ?? 0)
          : undefined;
      return outputText.slice(start, end).trim();
    })
    .filter((chunk) => chunk.length > 0);
};

const commandOutputContainsDiffForFile = (
  outputText: string,
  filePath: string | null,
  projectRelativeFilePath: string | null,
): string | null => {
  const targets = getDiffPathTargets(filePath, projectRelativeFilePath);
  if (targets.length === 0) {
    return null;
  }

  for (const chunk of getDiffChunks(outputText)) {
    const normalizedChunk = normalizePathForCompare(chunk);
    if (targets.some((target) => normalizedChunk.includes(target))) {
      return chunk;
    }
  }

  return null;
};

const findSiblingCommandDiff = ({
  filePath,
  messageParts,
  partIndex,
  projectRelativeFilePath,
}: {
  filePath: string | null;
  messageParts?: MessagePart[];
  partIndex?: number;
  projectRelativeFilePath: string | null;
}): string | null => {
  if (!messageParts || partIndex === undefined) {
    return null;
  }

  const followingParts = messageParts.slice(partIndex + 1);
  const precedingParts = messageParts.slice(0, partIndex).reverse();

  for (const part of [...followingParts, ...precedingParts]) {
    if (getChipToolKind(part) !== "command") {
      continue;
    }

    const outputText = isToolLikePart(part)
      ? getCommandOutputText(getToolCallSource(part))
      : null;
    if (!outputText) {
      continue;
    }

    const diff = commandOutputContainsDiffForFile(
      outputText,
      filePath,
      projectRelativeFilePath,
    );
    if (diff) {
      return diff;
    }
  }

  return null;
};

const inferProjectGitStatus = (
  status: string | null,
): ProjectGitChangeStatus => {
  const normalizedStatus = status?.toLowerCase() ?? "";

  if (normalizedStatus.includes("add") || normalizedStatus.includes("create")) {
    return "added";
  }
  if (
    normalizedStatus.includes("delete") ||
    normalizedStatus.includes("remove")
  ) {
    return "deleted";
  }
  if (normalizedStatus.includes("rename")) {
    return "renamed";
  }
  if (normalizedStatus.includes("copy")) {
    return "copied";
  }
  if (normalizedStatus.includes("untracked")) {
    return "untracked";
  }

  return "modified";
};

const getChangeStateLabel = (status: string | null) => {
  const normalizedStatus = status?.toLowerCase() ?? "";

  if (normalizedStatus.includes("add") || normalizedStatus.includes("create")) {
    return "created";
  }
  if (
    normalizedStatus.includes("delete") ||
    normalizedStatus.includes("remove")
  ) {
    return "deleted";
  }
  if (normalizedStatus.includes("rename")) {
    return "renamed";
  }
  if (
    normalizedStatus.includes("update") ||
    normalizedStatus.includes("modify")
  ) {
    return "modified";
  }

  return null;
};

const WRITE_CHIP_PREVIEW_CLASSES = "max-h-96 overflow-auto";
const WRITE_CHIP_HEADER_CLASSES = cn(
  CHIP_DETAIL_HEADER_CLASSES,
  "sticky top-0 z-10 bg-background",
);

export const WriteFileChip = ({
  defaultExpanded = false,
  messageParts,
  part,
  partIndex,
  projectPath,
  onToolApproval,
}: {
  defaultExpanded?: boolean;
  messageParts?: MessagePart[];
  part: ToolLikePart;
  partIndex?: number;
  projectPath?: string | null;
  onToolApproval?: ToolApprovalHandler;
}) => {
  const assistantT = useTranslations("assistant");
  const uiT = useTranslations("ui");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [gitDiff, setGitDiff] = useState<{
    diff: string;
    filePath: string;
  } | null>(null);
  const [gitDiffError, setGitDiffError] = useState<{
    filePath: string;
    message: string;
  } | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const projects = useIdeStore((s) => s.projects);
  const openProjectFile = useIdeStore((s) => s.openProjectFile);
  const output = part.output;
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";

  const {
    changeStatus,
    content,
    diff: savedDiff,
    edit,
    filename: namedFile,
    mode,
    outputMessage,
    path: filePath,
    previousContent,
  } = describeWrite(getToolCallSource(part));
  const projectRelativeFilePath = getProjectRelativeFilePath(
    filePath,
    projectPath,
  );
  const filename = namedFile ?? "file";
  const headerFilePath = projectRelativeFilePath ?? filePath ?? filename;
  const hasOutput = output !== undefined;
  const approvalId = part.approval?.id;
  const previewLanguage = inferLanguage(filePath ?? filename);
  const normalizedContent =
    content !== null ? normalizeEmbeddedLineNumbers(content) : null;
  const previewCode = normalizedContent?.code ?? content ?? "";
  const previewStartLine = normalizedContent?.startingLineNumber ?? 1;
  const diffCode =
    savedDiff ??
    (previousContent !== null && content !== null && filePath
      ? buildWriteDiff({ content, filePath, mode, previousContent })
      : getEditDiff(edit, filePath));
  const siblingCommandDiffCode = useMemo(
    () =>
      findSiblingCommandDiff({
        filePath,
        messageParts,
        partIndex,
        projectRelativeFilePath,
      }),
    [filePath, messageParts, partIndex, projectRelativeFilePath],
  );
  const hasFetchedGitDiff =
    Boolean(gitDiff) && gitDiff?.filePath === projectRelativeFilePath;
  const fetchedGitDiffCode =
    hasFetchedGitDiff && gitDiff?.diff.trim() ? gitDiff.diff : null;
  const currentGitDiffError =
    gitDiffError && gitDiffError.filePath === projectRelativeFilePath
      ? gitDiffError.message
      : null;
  const displayDiffCode =
    diffCode ?? siblingCommandDiffCode ?? fetchedGitDiffCode;
  const isFetchedGitDiffCode =
    fetchedGitDiffCode !== null && displayDiffCode === fetchedGitDiffCode;
  const canExpand =
    !isApprovalRequested &&
    (hasError || displayDiffCode !== null || content !== null || hasOutput);
  const displayFilename =
    filename === "file" && isRunning ? uiT("writing") : filename;
  const projectId = useMemo(() => {
    if (!projectPath) {
      return null;
    }

    const projectPathKey = normalizeProjectPathKey(projectPath);
    return (
      projects.find(
        (project) => normalizeProjectPathKey(project.path) === projectPathKey,
      )?.id ?? null
    );
  }, [projectPath, projects]);
  const canOpenFile = Boolean(projectId && projectRelativeFilePath);
  const parsedDiff = useMemo(
    () =>
      !isRunning && displayDiffCode
        ? parseSingleDiff(displayDiffCode, filePath)
        : null,
    [displayDiffCode, filePath, isRunning],
  );
  const showAddedFileContents =
    !isFetchedGitDiffCode &&
    !!parsedDiff &&
    parsedDiff.type === "new" &&
    parsedDiff.deletionLines.length === 0;
  const addedFileContents = showAddedFileContents
    ? parsedDiff.additionLines.join("")
    : null;
  const writeFileStateLabel =
    getWriteFileStateLabel(parsedDiff, mode, previousContent) ??
    getChangeStateLabel(changeStatus);
  const writeDiffStats = getDiffStats(parsedDiff);
  const showFileDetails = expanded && !isApprovalRequested;
  const shouldLoadGitDiff =
    !isRunning &&
    !diffCode &&
    !siblingCommandDiffCode &&
    !hasFetchedGitDiff &&
    !currentGitDiffError &&
    Boolean(projectPath && projectRelativeFilePath);

  const handleOpenFile = useCallback(() => {
    if (!projectId || !projectRelativeFilePath) {
      return;
    }

    openProjectFile(projectId, projectRelativeFilePath);
  }, [openProjectFile, projectId, projectRelativeFilePath]);

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  useEffect(() => {
    if (!shouldLoadGitDiff || !projectPath || !projectRelativeFilePath) {
      return;
    }

    const abortController = new AbortController();

    const loadGitDiff = async () => {
      setGitDiffLoading(true);

      try {
        const status = await apiClient.gitStatus(
          { projectPath },
          { signal: abortController.signal },
        );
        const normalizedTarget = normalizePathForCompare(
          projectRelativeFilePath,
        );
        const matchingChange: ProjectGitStatusEntry | undefined =
          status.changes.find(
            (change) =>
              normalizePathForCompare(change.path) === normalizedTarget,
          );
        const diffStatus =
          matchingChange?.status ?? inferProjectGitStatus(changeStatus);
        const previousPath = matchingChange?.previousPath ?? null;

        const payload = await apiClient.gitDiff(
          {
            filePath: matchingChange?.path ?? projectRelativeFilePath,
            previousPath,
            projectPath,
            status: diffStatus,
          },
          { signal: abortController.signal },
        );

        setGitDiff({
          diff: payload.diff,
          filePath: projectRelativeFilePath,
        });
        setGitDiffError(null);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        setGitDiffError({
          filePath: projectRelativeFilePath,
          message: getApiErrorMessage(
            error,
            assistantT("failedToLoadDiff"),
            () => uiT("requestFailed"),
          ),
        });
      } finally {
        if (!abortController.signal.aborted) {
          setGitDiffLoading(false);
        }
      }
    };

    void loadGitDiff();

    return () => {
      abortController.abort();
    };
  }, [
    assistantT,
    changeStatus,
    projectPath,
    projectRelativeFilePath,
    shouldLoadGitDiff,
    uiT,
  ]);

  return (
    <div className={expanded || isApprovalRequested ? "w-full" : undefined}>
      <div
        className={cn(
          "flex items-center gap-2",
          expanded && "w-full justify-between",
        )}
      >
        <ChipButton
          className={cn(
            canExpand && "cursor-pointer",
            (isRunning || isApprovalRequested) && "animate-pulse",
          )}
          hasError={hasError}
          onClick={() => canExpand && setExpanded(!expanded)}
          aria-label={displayFilename}
          tone="violet"
          type="button"
        >
          <PenLineIcon className="size-3.5 shrink-0" />
          {!isRunning ? (
            <>
              <span className="max-w-48 truncate font-medium">
                {displayFilename}
              </span>
              {writeDiffStats ? (
                <span className={CHIP_SUBTEXT_CLASSES}>
                  {assistantT("lineCount", {
                    count: writeDiffStats.additions + writeDiffStats.deletions,
                  })}
                </span>
              ) : writeFileStateLabel ? (
                <span className={CHIP_SUBTEXT_CLASSES}>
                  {assistantT(`writeState.${writeFileStateLabel}`)}
                </span>
              ) : null}
              {hasError ? (
                <span className={CHIP_ERROR_SUBTEXT_CLASSES}>
                  {assistantT("error")}
                </span>
              ) : null}
            </>
          ) : null}
        </ChipButton>
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            expanded || isApprovalRequested ? "ml-auto" : "hidden",
          )}
        >
          {showFileDetails && writeDiffStats ? (
            <span className="flex shrink-0 items-center gap-1 font-medium text-xs">
              <span className="text-emerald-500">
                +{writeDiffStats.additions}
              </span>
              <span className="text-rose-500">-{writeDiffStats.deletions}</span>
            </span>
          ) : null}
          <ApprovalStatusLabel approval={part.approval} state={state} />
        </div>
      </div>
      {approvalId && part.approval && onToolApproval ? (
        <ActionApproval
          approval={part.approval}
          className="mt-2"
          onToolApproval={onToolApproval}
          state={state}
        >
          <span>
            {assistantT("allowWritingTo")}{" "}
            <code className="rounded bg-surface-50 dark:bg-surface-900 px-1 py-0.5 text-xs">
              {filePath ?? assistantT("file")}
            </code>
            ?
          </span>
        </ActionApproval>
      ) : null}
      {showFileDetails ? (
        <ChipContent hasError={hasError} tone="violet">
          {/* Error */}
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive-surface p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {/* Content preview */}
          {displayDiffCode !== null && filePath ? (
            <div>
              {showAddedFileContents && addedFileContents !== null ? (
                <CodeBlock
                  className={WRITE_CHIP_PREVIEW_CLASSES}
                  code={addedFileContents}
                  language={previewLanguage}
                  showLineNumbers
                  startingLineNumber={1}
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={WRITE_CHIP_HEADER_CLASSES}>
                    <CodeBlockTitle className="min-w-0 flex-1 overflow-hidden">
                      <MaterialFileIcon
                        className="size-3.5"
                        path={headerFilePath}
                      />
                      <CodeBlockFilename
                        className="block min-w-0 flex-1 truncate"
                        title={headerFilePath}
                      >
                        {headerFilePath}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions className="shrink-0">
                      <Button
                        aria-label={assistantT("openNamedInFiles", {
                          name: filename,
                        })}
                        className="shrink-0"
                        disabled={!canOpenFile}
                        onClick={handleOpenFile}
                        size="icon-xs"
                        title={assistantT("openInFiles")}
                        type="button"
                        variant="ghost"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                      <CodeBlockCopyButton />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : parsedDiff ? (
                <div className="max-h-96 overflow-auto rounded-md border bg-background text-xs">
                  <CodeBlockHeader className={WRITE_CHIP_HEADER_CLASSES}>
                    <CodeBlockTitle className="min-w-0 flex-1 overflow-hidden">
                      <MaterialFileIcon
                        className="size-3.5"
                        path={headerFilePath}
                      />
                      <CodeBlockFilename
                        className="block min-w-0 flex-1 truncate"
                        title={headerFilePath}
                      >
                        {headerFilePath}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions className="shrink-0">
                      <Button
                        aria-label={assistantT("openNamedInFiles", {
                          name: filename,
                        })}
                        className="shrink-0"
                        disabled={!canOpenFile}
                        onClick={handleOpenFile}
                        size="icon-xs"
                        title={assistantT("openInFiles")}
                        type="button"
                        variant="ghost"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                      <CodeBlockCopyButton text={displayDiffCode} />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                  <IdeDiffViewer fileDiff={parsedDiff} />
                </div>
              ) : (
                <CodeBlock
                  className={WRITE_CHIP_PREVIEW_CLASSES}
                  code={displayDiffCode}
                  language="diff"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={WRITE_CHIP_HEADER_CLASSES}>
                    <CodeBlockTitle className="min-w-0 flex-1 overflow-hidden">
                      <MaterialFileIcon
                        className="size-3.5"
                        path={headerFilePath}
                      />
                      <CodeBlockFilename
                        className="block min-w-0 flex-1 truncate"
                        title={headerFilePath}
                      >
                        {headerFilePath}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions className="shrink-0">
                      <Button
                        aria-label={assistantT("openNamedInFiles", {
                          name: filename,
                        })}
                        className="shrink-0"
                        disabled={!canOpenFile}
                        onClick={handleOpenFile}
                        size="icon-xs"
                        title={assistantT("openInFiles")}
                        type="button"
                        variant="ghost"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                      <CodeBlockCopyButton />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              )}
            </div>
          ) : content !== null && filePath ? (
            <div>
              <CodeBlock
                className={WRITE_CHIP_PREVIEW_CLASSES}
                code={previewCode}
                language={previewLanguage}
                showLineNumbers
                startingLineNumber={previewStartLine}
                style={{ contentVisibility: "visible" }}
              >
                <CodeBlockHeader className={WRITE_CHIP_HEADER_CLASSES}>
                  <CodeBlockTitle className="min-w-0 flex-1 overflow-hidden">
                    <MaterialFileIcon
                      className="size-3.5"
                      path={headerFilePath}
                    />
                    <CodeBlockFilename
                      className="block min-w-0 flex-1 truncate"
                      title={headerFilePath}
                    >
                      {headerFilePath}
                    </CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockActions className="shrink-0">
                    <Button
                      aria-label={assistantT("openNamedInFiles", {
                        name: filename,
                      })}
                      className="shrink-0"
                      disabled={!canOpenFile}
                      onClick={handleOpenFile}
                      size="icon-xs"
                      title={assistantT("openInFiles")}
                      type="button"
                      variant="ghost"
                    >
                      <ExternalLinkIcon className="size-3.5" />
                    </Button>
                    <CodeBlockCopyButton />
                  </CodeBlockActions>
                </CodeBlockHeader>
              </CodeBlock>
            </div>
          ) : shouldLoadGitDiff || gitDiffLoading ? (
            <p className="rounded-md bg-surface-50 dark:bg-surface-900 px-3 py-2 text-muted-foreground text-xs">
              {assistantT("loadingDiff")}
            </p>
          ) : currentGitDiffError ? (
            <p className="rounded-md bg-surface-50 dark:bg-surface-900 px-3 py-2 text-muted-foreground text-xs">
              {assistantT("diffUnavailable", { error: currentGitDiffError })}
            </p>
          ) : projectRelativeFilePath ? (
            <p className="rounded-md bg-surface-50 dark:bg-surface-900 px-3 py-2 text-muted-foreground text-xs">
              {writeFileStateLabel
                ? assistantT("writeStateFile", {
                    file: projectRelativeFilePath,
                    state: assistantT(`writeState.${writeFileStateLabel}`),
                  })
                : assistantT("changedFile", {
                    file: projectRelativeFilePath,
                  })}{" "}
              {assistantT("noWriteDiff")}
            </p>
          ) : outputMessage ? (
            <p className="rounded-md bg-surface-50 dark:bg-surface-900 px-3 py-2 text-muted-foreground text-xs">
              {outputMessage}
            </p>
          ) : hasOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </ChipContent>
      ) : null}
    </div>
  );
};
