import { EyeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
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
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
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
  const normalizedContent =
    content !== null ? normalizeEmbeddedLineNumbers(content, start) : null;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || content !== null || hasRawOutput;
  const previewLanguage = inferLanguage(filePath ?? filename);
  const previewCode = normalizedContent?.code ?? content ?? "";
  const previewStartLine = normalizedContent?.startingLineNumber ?? start ?? 1;
  const displayFilename =
    filename === "file" && isRunning ? "Reading" : filename;
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
        tone="green"
        type="button"
      >
        <EyeIcon className="size-3.5 shrink-0" />
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
          className={getExpandedChipClasses("green", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
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
                <CodeBlockTitle>
                  <MaterialFileIcon
                    className="size-3.5"
                    path={filePath ?? filename}
                  />
                  <CodeBlockFilename>{filename}</CodeBlockFilename>
                  {lineRangeLabel ? (
                    <Badge variant="secondary" className="ml-1 text-sm">
                      {lineRangeLabel}
                    </Badge>
                  ) : null}
                </CodeBlockTitle>
                <CodeBlockActions>
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
