import { WrenchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
import { stringifyPart } from "../../ide-state";
import {
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  getExpandedChipClasses,
  getStringFromPaths,
  isRecord,
  isString,
  RUN_COMMAND_HEADER_CLASSES,
} from "../shared";

export const TaskOutputChip = ({
  defaultExpanded = false,
  part,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
}) => {
  const assistantT = useTranslations("assistant");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const taskId =
    getStringFromPaths(part.input, [["task_id"], ["taskId"], ["id"]]) ??
    getStringFromPaths(part.output, [["task_id"], ["taskId"], ["id"]]);
  const parametersCode = isRecord(part.input)
    ? JSON.stringify(part.input, null, 2)
    : null;
  const outputText =
    isString(part.output) && part.output.length > 0 ? part.output : null;
  const hasRawOutput = part.output !== undefined;
  const resultCode = hasError
    ? (part.errorText ?? "")
    : outputText !== null
      ? outputText
      : hasRawOutput
        ? stringifyPart(part.output)
        : null;
  const canExpand = parametersCode !== null || resultCode !== null;
  const resultLanguage: BundledLanguage = hasError
    ? "log"
    : outputText?.trimStart().startsWith("<")
      ? "xml"
      : outputText !== null
        ? "log"
        : "json";

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
        aria-label={assistantT("taskOutput")}
        tone="cyan"
        type="button"
      >
        <WrenchIcon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="font-medium">{assistantT("taskOutput")}</span>
            {taskId ? (
              <span className={cn("max-w-28 truncate", CHIP_SUBTEXT_CLASSES)}>
                {taskId}
              </span>
            ) : null}
            <span className={CHIP_SUBTEXT_CLASSES}>
              {assistantT(`toolState.${state}`)}
            </span>
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>
                {assistantT("error")}
              </span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses("cyan", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {parametersCode !== null || resultCode !== null ? (
            <div className="overflow-hidden rounded-md border bg-background">
              {parametersCode !== null ? (
                <CodeBlock
                  className="max-h-64 flex flex-col rounded-none border-0 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:text-xs"
                  code={parametersCode}
                  language="json"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <CodeBlockFilename>
                        {assistantT("parameters")}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
              {parametersCode !== null && resultCode !== null ? (
                <div className="border-t" />
              ) : null}
              {resultCode !== null ? (
                <CodeBlock
                  className="max-h-96 flex flex-col rounded-none border-0 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:text-xs"
                  code={resultCode}
                  language={resultLanguage}
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <CodeBlockFilename>
                        {hasError ? assistantT("error") : assistantT("result")}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
