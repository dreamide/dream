import { TerminalIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import type { ToolPart } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
import {
  ActionApproval,
  ApprovalStatusLabel,
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  getCommandWithoutShellPrefix,
  getExpandedChipClasses,
  isRecord,
  isString,
  JsonBlock,
  RUN_COMMAND_HEADER_CLASSES,
  stripAnsiSequences,
  type ToolApprovalHandler,
} from "../shared";

export const RunCommandChip = ({
  defaultExpanded = false,
  onToolApproval,
  part,
}: {
  defaultExpanded?: boolean;
  onToolApproval?: ToolApprovalHandler;
  part: ToolLikePart;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const state = (part.state ?? "input-streaming") as ToolPart["state"];
  const isRunning = state === "input-available" || state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;
  const isApprovalRequested = state === "approval-requested";
  const command =
    isRecord(part.input) && isString(part.input.command)
      ? part.input.command
      : isRecord(output) && isString(output.command)
        ? output.command
        : null;
  const exitCode =
    isRecord(output) && typeof output.exitCode === "number"
      ? output.exitCode
      : null;
  const commandOutput = useMemo(() => {
    if (isString(output)) {
      return stripAnsiSequences(output);
    }

    if (!isRecord(output)) {
      return null;
    }

    const combinedOutput = [output.stdout, output.stderr]
      .filter(isString)
      .join(output.stdout && output.stderr ? "\n" : "");
    const textOutput =
      (isString(output.output) && output.output) ||
      combinedOutput ||
      (isString(output.result) ? output.result : null);

    return textOutput ? stripAnsiSequences(textOutput) : null;
  }, [output]);
  const status =
    isRecord(output) && isString(output.status) ? output.status : null;
  const hasRawOutput = output !== undefined;
  const approvalId = part.approval?.id;
  const canExpand =
    !isApprovalRequested && (hasError || hasRawOutput || command !== null);

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  const displayCommand = useMemo(() => {
    if (!command) {
      return null;
    }

    return getCommandWithoutShellPrefix(command);
  }, [command]);

  return (
    <div className={expanded || isApprovalRequested ? "w-full" : undefined}>
      <div className="flex items-center gap-2">
        <ChipButton
          className={cn(
            canExpand && "cursor-pointer",
            (isRunning || isApprovalRequested) && "animate-pulse",
          )}
          hasError={hasError}
          onClick={() => canExpand && setExpanded(!expanded)}
          aria-label={displayCommand ?? (isRunning ? "Running" : "Command")}
          tone="lime"
          type="button"
        >
          <TerminalIcon className="size-3.5 shrink-0" />
          {!isRunning ? (
            <>
              <span className="max-w-64 truncate font-medium">
                {displayCommand ?? "Command"}
              </span>
              {exitCode !== null ? (
                <span className={CHIP_SUBTEXT_CLASSES}>exit {exitCode}</span>
              ) : null}
              {status === "running" ? (
                <span className={CHIP_SUBTEXT_CLASSES}>running</span>
              ) : null}
              {hasError ? (
                <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
              ) : null}
            </>
          ) : null}
        </ChipButton>
        <ApprovalStatusLabel approval={part.approval} state={state} />
      </div>
      {approvalId && part.approval && onToolApproval ? (
        <ActionApproval
          approval={part.approval}
          className="mt-2"
          onToolApproval={onToolApproval}
          state={state}
        >
          <span>
            Allow running{" "}
            <code className="rounded bg-surface-50 dark:bg-surface-900 px-1 py-0.5 text-xs">
              {displayCommand ?? command ?? "command"}
            </code>
            ?
          </span>
        </ActionApproval>
      ) : null}
      {expanded ? (
        <div
          className={getExpandedChipClasses("lime", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive-surface p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {command || commandOutput ? (
            <div className="overflow-hidden rounded-md border bg-background">
              {command ? (
                <CodeBlock
                  className="rounded-none border-0 [&_pre]:text-xs"
                  code={displayCommand ?? command}
                  language="bash"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <CodeBlockFilename>Command</CodeBlockFilename>
                      {exitCode !== null ? (
                        <Badge
                          variant="secondary"
                          className="ml-1 font-mono text-xs"
                        >
                          Exit {exitCode}
                        </Badge>
                      ) : null}
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
              {command && commandOutput ? <div className="border-t" /> : null}
              {commandOutput ? (
                <CodeBlock
                  className="max-h-96 flex flex-col rounded-none border-0 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:text-xs"
                  code={commandOutput}
                  language="log"
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className={RUN_COMMAND_HEADER_CLASSES}>
                    <CodeBlockTitle>
                      <CodeBlockFilename>Output</CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : null}
            </div>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
