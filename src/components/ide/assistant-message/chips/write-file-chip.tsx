import { ExternalLinkIcon, PenLineIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
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
  formatWriteOutputMessage,
  getDiffStats,
  getExpandedChipClasses,
  getFilePathFromOutputText,
  getStringFromPaths,
  getWriteFileStateLabel,
  inferLanguage,
  isString,
  JsonBlock,
  normalizeEmbeddedLineNumbers,
  parseSingleDiff,
  type ToolApprovalHandler,
} from "../shared";

const getEditDiffFromInput = (
  input: unknown,
  filePath: string | null,
): string | null => {
  if (!filePath) {
    return null;
  }

  const oldString = getStringFromPaths(
    input,
    [["old_string"], ["oldString"], ["oldText"], ["old"]],
    { allowEmpty: true },
  );
  const newString = getStringFromPaths(
    input,
    [["new_string"], ["newString"], ["newText"], ["new"]],
    { allowEmpty: true },
  );

  if (oldString !== null && newString !== null) {
    return buildWriteDiff({
      content: newString,
      filePath,
      mode: null,
      previousContent: oldString,
    });
  }

  if (
    input &&
    typeof input === "object" &&
    "edits" in input &&
    Array.isArray(input.edits)
  ) {
    const previousContent = input.edits
      .map((edit) =>
        getStringFromPaths(edit, [["old_string"], ["oldString"]], {
          allowEmpty: true,
        }),
      )
      .filter(isString)
      .join("\n");
    const nextContent = input.edits
      .map((edit) =>
        getStringFromPaths(edit, [["new_string"], ["newString"]], {
          allowEmpty: true,
        }),
      )
      .filter(isString)
      .join("\n");

    if (previousContent || nextContent) {
      return buildWriteDiff({
        content: nextContent,
        filePath,
        mode: null,
        previousContent,
      });
    }
  }

  return null;
};

export const WriteFileChip = ({
  defaultExpanded = false,
  part,
  projectPath,
  onToolApproval,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
  projectPath?: string | null;
  onToolApproval?: ToolApprovalHandler;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const projects = useIdeStore((s) => s.projects);
  const openProjectFile = useIdeStore((s) => s.openProjectFile);
  const output = part.output;
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";

  const filePath =
    getStringFromPaths(part.input, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["filename"],
      ["name"],
      ["file", "path"],
      ["file", "filePath"],
      ["file", "filename"],
      ["file", "name"],
    ]) ??
    getStringFromPaths(output, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["filename"],
      ["name"],
      ["file"],
      ["file", "path"],
      ["file", "filePath"],
      ["file", "filename"],
      ["file", "name"],
    ]) ??
    getFilePathFromOutputText(output);
  const filename =
    filePath?.split(/[\\/]/).pop() ??
    getStringFromPaths(part.input, [
      ["filename"],
      ["name"],
      ["file", "name"],
    ]) ??
    getStringFromPaths(output, [["filename"], ["name"], ["file", "name"]]) ??
    "file";
  const headerFilePath = filePath ?? filename;
  const content =
    getStringFromPaths(
      part.input,
      [
        ["content"],
        ["contents"],
        ["text"],
        ["file", "content"],
        ["file", "text"],
      ],
      { allowEmpty: true },
    ) ??
    getStringFromPaths(
      output,
      [
        ["content"],
        ["contents"],
        ["text"],
        ["file", "content"],
        ["file", "text"],
      ],
      { allowEmpty: true },
    );
  const previousContent = getStringFromPaths(
    output,
    [["previousContent"], ["previous_content"], ["file", "previousContent"]],
    { allowEmpty: true },
  );
  const savedDiff = getStringFromPaths(
    output,
    [["diff"], ["patch"], ["changes", "diff"], ["file", "diff"]],
    { allowEmpty: true },
  );
  const mode =
    getStringFromPaths(part.input, [
      ["mode"],
      ["writeMode"],
      ["file", "mode"],
    ]) ??
    getStringFromPaths(output, [["mode"], ["writeMode"], ["file", "mode"]]);
  const hasOutput = output !== undefined;
  const outputMessage = formatWriteOutputMessage(output);
  const approvalId = part.approval?.id;
  const canExpand =
    !isApprovalRequested &&
    (hasError || savedDiff !== null || content !== null || hasOutput);
  const previewLanguage = inferLanguage(filePath ?? filename);
  const normalizedContent =
    content !== null ? normalizeEmbeddedLineNumbers(content) : null;
  const previewCode = normalizedContent?.code ?? content ?? "";
  const previewStartLine = normalizedContent?.startingLineNumber ?? 1;
  const diffCode =
    savedDiff ??
    (previousContent !== null && content !== null && filePath
      ? buildWriteDiff({ content, filePath, mode, previousContent })
      : getEditDiffFromInput(part.input, filePath));
  const displayDiffCode = diffCode;
  const displayFilename =
    filename === "file" && isRunning ? "Writing" : filename;
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
  const canOpenFile = Boolean(projectId && filePath);
  const parsedDiff = useMemo(
    () =>
      !isRunning && displayDiffCode ? parseSingleDiff(displayDiffCode) : null,
    [displayDiffCode, isRunning],
  );
  const writeFileStateLabel = getWriteFileStateLabel(
    parsedDiff,
    mode,
    previousContent,
  );
  const writeDiffStats = getDiffStats(parsedDiff);
  const showFileDetails = expanded && !isApprovalRequested;

  const handleOpenFile = useCallback(() => {
    if (!projectId || !filePath) {
      return;
    }

    openProjectFile(projectId, filePath);
  }, [filePath, openProjectFile, projectId]);

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

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
                  {writeDiffStats.additions + writeDiffStats.deletions}{" "}
                  {writeDiffStats.additions + writeDiffStats.deletions === 1
                    ? "line"
                    : "lines"}
                </span>
              ) : writeFileStateLabel ? (
                <span className={CHIP_SUBTEXT_CLASSES}>
                  {writeFileStateLabel}
                </span>
              ) : null}
              {hasError ? (
                <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
              ) : null}
            </>
          ) : null}
        </ChipButton>
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            expanded && "ml-auto",
          )}
        >
          {showFileDetails && writeDiffStats ? (
            <span className="flex shrink-0 items-center gap-1 font-medium text-xs">
              <span className="text-emerald-600 dark:text-emerald-400">
                +{writeDiffStats.additions}
              </span>
              <span className="text-red-600 dark:text-red-400">
                -{writeDiffStats.deletions}
              </span>
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
            Allow writing to{" "}
            <code className="rounded bg-background/80 px-1 py-0.5 text-xs">
              {filePath ?? "file"}
            </code>
            ?
          </span>
        </ActionApproval>
      ) : null}
      {showFileDetails ? (
        <div
          className={getExpandedChipClasses("violet", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {/* Error */}
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {/* Content preview */}
          {displayDiffCode !== null && filePath ? (
            <div>
              {parsedDiff ? (
                <div className="max-h-96 flex flex-col overflow-hidden rounded-md border bg-background text-xs">
                  <CodeBlockHeader className={CHIP_DETAIL_HEADER_CLASSES}>
                    <CodeBlockTitle className="min-w-0 flex-1">
                      <MaterialFileIcon
                        className="size-3.5"
                        path={headerFilePath}
                      />
                      <CodeBlockFilename
                        className="min-w-0 break-all"
                        title={headerFilePath}
                      >
                        {headerFilePath}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <Button
                        aria-label={`Open ${filename} in Files`}
                        className="shrink-0"
                        disabled={!canOpenFile}
                        onClick={handleOpenFile}
                        size="icon-xs"
                        title="Open in Files"
                        type="button"
                        variant="ghost"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                      <CodeBlockCopyButton text={displayDiffCode} />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <IdeDiffViewer fileDiff={parsedDiff} />
                  </div>
                </div>
              ) : (
                <CodeBlock
                  className="max-h-96 flex flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                  code={displayDiffCode}
                  language="diff"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={CHIP_DETAIL_HEADER_CLASSES}>
                    <CodeBlockTitle className="min-w-0 flex-1">
                      <MaterialFileIcon
                        className="size-3.5"
                        path={headerFilePath}
                      />
                      <CodeBlockFilename
                        className="min-w-0 break-all"
                        title={headerFilePath}
                      >
                        {headerFilePath}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <Button
                        aria-label={`Open ${filename} in Files`}
                        className="shrink-0"
                        disabled={!canOpenFile}
                        onClick={handleOpenFile}
                        size="icon-xs"
                        title="Open in Files"
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
                className="max-h-96 flex flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                code={previewCode}
                language={previewLanguage}
                showLineNumbers
                startingLineNumber={previewStartLine}
                style={{ contentVisibility: "visible" }}
              >
                <CodeBlockHeader className={CHIP_DETAIL_HEADER_CLASSES}>
                  <CodeBlockTitle className="min-w-0 flex-1">
                    <MaterialFileIcon
                      className="size-3.5"
                      path={headerFilePath}
                    />
                    <CodeBlockFilename
                      className="min-w-0 break-all"
                      title={headerFilePath}
                    >
                      {headerFilePath}
                    </CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <Button
                      aria-label={`Open ${filename} in Files`}
                      className="shrink-0"
                      disabled={!canOpenFile}
                      onClick={handleOpenFile}
                      size="icon-xs"
                      title="Open in Files"
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
          ) : outputMessage ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
              {outputMessage}
            </p>
          ) : hasOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
