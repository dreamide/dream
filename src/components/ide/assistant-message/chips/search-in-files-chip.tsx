import { SearchIcon, WrenchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  describeSearch,
  getToolCallSource,
  getToolKind,
  type ToolLikePart,
} from "../../assistant-message-tools";
import {
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  ChipContent,
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
  const assistantT = useTranslations("assistant");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const { count, hasOutput, matches, query, textResults, toolReferences } =
    describeSearch(getToolCallSource(part));
  const isToolSearch = getToolKind(part) === "toolSearch";
  const isToolReferenceSearch = isToolSearch || toolReferences.length > 0;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || hasRawOutput;
  const label = query ?? assistantT("search");
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
                {query ?? assistantT("toolsSearch")}
              </span>
            ) : query ? (
              <span className="max-w-48 truncate font-medium">{label}</span>
            ) : (
              <span className="font-medium">{assistantT("search")}</span>
            )}
            {hasOutput && count > 0 ? (
              <span className={CHIP_SUBTEXT_CLASSES}>
                {isToolReferenceSearch
                  ? assistantT(
                      count === 1 ? "toolCountOne" : "toolCountOther",
                      { count },
                    )
                  : textResults.length > 0
                    ? assistantT(
                        count === 1 ? "resultCountOne" : "resultCountOther",
                        { count },
                      )
                    : assistantT(
                        count === 1 ? "matchCountOne" : "matchCountOther",
                        { count },
                      )}
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
      {expanded ? (
        <ChipContent hasError={hasError} tone={tone}>
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
                  {assistantT("noMatches")}
                </p>
              ) : (
                matches.map((match) => {
                  const { file, line: lineNumber, text, toolName } = match;
                  const line = lineNumber ?? "?";
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
                            {text || assistantT("emptyLine")}
                          </p>
                        </>
                      ) : toolName ? (
                        <p className="font-medium text-sm">{toolName}</p>
                      ) : (
                        <JsonBlock value={match.raw} />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </ChipContent>
      ) : null}
    </div>
  );
};
