import { SearchIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  CHIP_TOOL_NAME_ALIASES,
  getToolName,
  normalizeToolName,
  type ToolLikePart,
} from "../../assistant-message-tools";
import {
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  getExpandedChipClasses,
  isRecord,
  isString,
  JsonBlock,
} from "../shared";

export const SearchInFilesChip = ({
  defaultExpanded = false,
  part,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const rawMatches =
    isRecord(output) && Array.isArray(output.matches)
      ? output.matches
      : isRecord(output) && Array.isArray(output.results)
        ? output.results
        : isRecord(output) && Array.isArray(output.files)
          ? output.files
          : Array.isArray(output)
            ? output
            : null;
  const matches = Array.isArray(rawMatches) ? rawMatches.filter(isRecord) : [];
  const textResults = (
    isString(output)
      ? output.split(/\r?\n/)
      : Array.isArray(rawMatches)
        ? rawMatches.filter(isString)
        : []
  ).filter((line) => {
    const trimmedLine = line.trim();
    return (
      trimmedLine.length > 0 && trimmedLine.toLowerCase() !== "no files found"
    );
  });
  const toolReferences = matches
    .map(
      (match) =>
        (isString(match.tool_name) && match.tool_name) ||
        (isString(match.toolName) && match.toolName) ||
        null,
    )
    .filter((toolName): toolName is string => toolName !== null);
  const normalizedToolName = normalizeToolName(getToolName(part));
  const isToolSearch =
    CHIP_TOOL_NAME_ALIASES.toolSearch.has(normalizedToolName);
  const isToolReferenceSearch = isToolSearch || toolReferences.length > 0;
  const hasOutput = rawMatches !== null || textResults.length > 0;
  const count =
    isRecord(output) && typeof output.count === "number"
      ? output.count
      : Array.isArray(rawMatches)
        ? rawMatches.length
        : textResults.length;
  const query =
    isRecord(part.input) && isString(part.input.query)
      ? part.input.query
      : isRecord(part.input) && isString(part.input.pattern)
        ? part.input.pattern
        : null;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || hasRawOutput;
  const label = query ?? "Search";
  const SearchChipIcon = isToolReferenceSearch ? WrenchIcon : SearchIcon;
  const tone = isToolReferenceSearch ? "slate" : "blue";

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
        aria-label={label}
        tone={tone}
        type="button"
      >
        <SearchChipIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            {isToolReferenceSearch && toolReferences.length > 0 ? (
              <span className="max-w-64 truncate font-medium">
                {toolReferences.join(", ")}
              </span>
            ) : isToolSearch ? (
              <span className="max-w-48 truncate font-medium">
                {query ?? "Tools search"}
              </span>
            ) : query ? (
              <span className="max-w-48 truncate font-medium">{label}</span>
            ) : (
              <span className="font-medium">Search</span>
            )}
            {hasOutput && count > 0 ? (
              <span className={CHIP_SUBTEXT_CLASSES}>
                {count}{" "}
                {isToolReferenceSearch
                  ? count === 1
                    ? "tool"
                    : "tools"
                  : textResults.length > 0
                    ? count === 1
                      ? "result"
                      : "results"
                    : count === 1
                      ? "match"
                      : "matches"}
              </span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses(tone, hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive-surface p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {hasOutput ? (
            <div className="max-h-80 space-y-1 overflow-auto rounded-md border bg-background p-2 text-foreground">
              {isToolReferenceSearch ? (
                <div className="flex flex-wrap gap-1.5">
                  {toolReferences.map((toolName) => (
                    <Badge
                      className="rounded-full font-medium text-xs"
                      key={toolName}
                      variant="secondary"
                    >
                      {toolName}
                    </Badge>
                  ))}
                </div>
              ) : textResults.length > 0 ? (
                <div className="space-y-1">
                  {textResults.map((result) => (
                    <div
                      className="rounded-sm px-2 py-1.5 font-mono text-xs hover:bg-surface-100 dark:hover:bg-surface-900"
                      key={result}
                    >
                      {result}
                    </div>
                  ))}
                </div>
              ) : matches.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No matches found.
                </p>
              ) : (
                matches.map((match) => {
                  const file =
                    (isString(match.file) && match.file) ||
                    (isString(match.path) && match.path) ||
                    null;
                  const toolName =
                    (isString(match.tool_name) && match.tool_name) ||
                    (isString(match.toolName) && match.toolName) ||
                    null;
                  const line =
                    typeof match.line === "number"
                      ? match.line
                      : typeof match.line_number === "number"
                        ? match.line_number
                        : "?";
                  const text =
                    (isString(match.text) && match.text) ||
                    (isString(match.preview) && match.preview) ||
                    (isString(match.lineText) && match.lineText) ||
                    "";
                  const key = `${file ?? toolName ?? "result"}:${line}:${text}`;

                  return (
                    <div
                      className="rounded-sm px-2 py-1.5 hover:bg-surface-100 dark:hover:bg-surface-900"
                      key={key}
                    >
                      {file ? (
                        <>
                          <p className="font-mono text-xs text-muted-foreground">
                            {file}:{line}
                          </p>
                          <p className="font-mono text-xs">
                            {text || "(empty line)"}
                          </p>
                        </>
                      ) : toolName ? (
                        <p className="font-medium text-sm">{toolName}</p>
                      ) : (
                        <JsonBlock value={match} />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
