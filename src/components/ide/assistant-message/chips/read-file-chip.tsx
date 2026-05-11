import { ExternalLinkIcon, EyeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
import { normalizeProjectPathKey } from "../../ide-state";
import { useIdeStore } from "../../ide-store";
import { MaterialFileIcon } from "../../material-file-icon";
import {
  CHIP_DETAIL_HEADER_CLASSES,
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  getExpandedChipClasses,
  getNumberFromPaths,
  getStringFromPaths,
  inferLanguage,
  isString,
  JsonBlock,
  normalizeEmbeddedLineNumbers,
} from "../shared";

export const ReadFileChip = ({
  defaultExpanded = false,
  part,
  projectPath,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
  projectPath?: string | null;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const projects = useIdeStore((s) => s.projects);
  const openProjectFile = useIdeStore((s) => s.openProjectFile);
  const output = part.output;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const filePath =
    getStringFromPaths(part.input, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["file", "path"],
      ["file", "filePath"],
    ]) ??
    getStringFromPaths(output, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["file"],
      ["file", "path"],
      ["file", "filePath"],
    ]);
  const content =
    getStringFromPaths(
      output,
      [
        [],
        ["content"],
        ["text"],
        ["contents"],
        ["file", "content"],
        ["file", "text"],
      ],
      { allowEmpty: true },
    ) ??
    getStringFromPaths(part.input, [["content"], ["text"]], {
      allowEmpty: true,
    });
  const start =
    getNumberFromPaths(output, [["startLine"], ["start_line"]]) ??
    getNumberFromPaths(part.input, [["startLine"], ["start_line"]]);
  const end =
    getNumberFromPaths(output, [["endLine"], ["end_line"]]) ??
    getNumberFromPaths(part.input, [["endLine"], ["end_line"]]);
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
  const normalizedContent =
    content !== null ? normalizeEmbeddedLineNumbers(content, start) : null;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || content !== null || hasRawOutput;
  const previewLanguage = inferLanguage(filePath ?? filename);
  const previewCode = normalizedContent?.code ?? content ?? "";
  const previewStartLine = normalizedContent?.startingLineNumber ?? start ?? 1;
  const displayFilename = filename;
  const displayStart = start ?? normalizedContent?.startingLineNumber ?? 1;
  const displayEnd =
    end ??
    (content !== null
      ? displayStart + previewCode.split(/\r?\n/).length - 1
      : null);
  const lineRangeLabel =
    displayEnd !== null
      ? displayStart === displayEnd
        ? `Line ${displayStart}`
        : `Lines ${displayStart}-${displayEnd}`
      : null;
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
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        hasError={hasError}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={displayFilename}
        tone="emerald"
        type="button"
      >
        {isRunning ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : (
          <EyeIcon className="size-3.5 shrink-0" />
        )}
        {!isRunning ? (
          <>
            <span className="max-w-48 truncate font-medium">
              {displayFilename}
            </span>
            {lineRangeLabel ? (
              <span className={CHIP_SUBTEXT_CLASSES}>{lineRangeLabel}</span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses("emerald", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive-surface p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {content !== null ? (
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
                  {lineRangeLabel ? (
                    <Badge
                      variant="secondary"
                      className="ml-1 px-1.5 py-0 text-[11px]"
                    >
                      {lineRangeLabel}
                    </Badge>
                  ) : null}
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
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
