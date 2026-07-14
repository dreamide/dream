import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { motion } from "motion/react";
import { useTranslations } from "next-intl";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
} from "react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
} from "@/components/ai-elements/confirmation";
import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../assistant-message-tools";

export { FileTree } from "@/components/ai-elements/file-tree";
export {
  ANSI_ESCAPE_SEQUENCE,
  formatToolName,
  getCommandWithoutShellPrefix,
  getExecutableName,
  readShellToken,
  stripAnsiSequences,
  unquoteCommandArgument,
} from "./command-utils";
export {
  buildLineDiff,
  buildWriteDiff,
  formatWriteOutputMessage,
  getAgentOutputText,
  getDiffStats,
  getFilePathFromOutputText,
  getWriteFileStateLabel,
  parseSingleDiff,
} from "./diff-utils";
export {
  extToLanguage,
  inferLanguage,
  normalizeEmbeddedLineNumbers,
} from "./language-utils";
export {
  buildFileTree,
  type FileTreeNode,
  FileTreeNodeView,
  JsonBlock,
} from "./output-renderers";
export {
  getBacklogPressure,
  getNextStreamingChunkText,
  getNextStreamingFrame,
  getNextStreamingWordToken,
  STREAMING_BACKLOG_FULL_SPEED_CHARS,
  STREAMING_BACKLOG_START_CHARS,
  STREAMING_BACKLOG_TARGET_TICKS,
  STREAMING_FINISHED_INTERVAL_MS,
  STREAMING_FINISHED_MAX_CHARS_PER_TICK,
  STREAMING_FINISHED_MIN_CHARS_PER_TICK,
  STREAMING_MAX_CHARS_PER_TICK,
  STREAMING_MIN_CHARS_PER_TICK,
  STREAMING_MIN_INTERVAL_MS,
  STREAMING_SMOOTH_REVEAL_BUFFER_MS,
  STREAMING_SMOOTH_REVEAL_CHECK_INTERVAL_MS,
  STREAMING_SMOOTH_REVEAL_MAX_DELAY_MS,
  STREAMING_WORD_INTERVAL_MS,
  StreamingMessageResponse,
} from "./streaming-message";
export {
  getNestedValue,
  getNumberFromPaths,
  getStringFromPaths,
  isRecord,
  isString,
} from "./value-utils";

export type ToolApprovalHandler = (response: {
  id: string;
  approved: boolean;
  reason?: string;
  scope?: "once" | "session";
}) => void;

export const ActionApproval = ({
  approval,
  approveLabel,
  children,
  className,
  onToolApproval,
  rejectLabel,
  state,
}: {
  approval: NonNullable<ToolLikePart["approval"]>;
  approveLabel?: string;
  children: ReactNode;
  className?: string;
  onToolApproval: ToolApprovalHandler;
  rejectLabel?: string;
  state: ToolPart["state"];
}) => {
  const assistantT = useTranslations("assistant");
  const approvalId = approval.id;

  if (state !== "approval-requested") {
    return null;
  }

  return (
    <Confirmation
      approval={approval as Parameters<typeof Confirmation>[0]["approval"]}
      className={cn(
        "w-full max-w-full gap-3 border-surface-300 bg-background text-foreground dark:border-surface-700 dark:bg-background",
        className,
      )}
      state={state}
    >
      <ConfirmationRequest>
        <div className="flex min-w-0 items-start text-sm">
          <TriangleAlertIcon className="mt-0.5 mr-3 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </ConfirmationRequest>
      <ConfirmationActions>
        <ConfirmationAction
          variant="outline"
          onClick={() =>
            onToolApproval({
              approved: false,
              id: approvalId,
            })
          }
        >
          {rejectLabel ?? assistantT("reject")}
        </ConfirmationAction>
        <ConfirmationAction
          variant="outline"
          className="border-surface-300 bg-surface-200 text-foreground hover:bg-surface-300 dark:border-surface-700 dark:bg-surface-800 dark:hover:bg-surface-700"
          onClick={() =>
            onToolApproval({
              approved: true,
              id: approvalId,
              scope: "once",
            })
          }
        >
          {approveLabel ?? assistantT("approve")}
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
};

export const isApprovalResponseState = (state: ToolPart["state"]) =>
  state === "approval-responded" ||
  state === "output-denied" ||
  state === "output-available";

export const ApprovalStatusLabel = ({
  approval,
  state,
}: {
  approval?: ToolLikePart["approval"];
  state: ToolPart["state"];
}) => {
  const assistantT = useTranslations("assistant");
  if (!approval) {
    return null;
  }

  if (state === "approval-requested") {
    return null;
  }

  if (
    !isApprovalResponseState(state) ||
    typeof approval.approved !== "boolean"
  ) {
    return null;
  }

  if (approval.approved) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success-border bg-success-surface px-2 py-0.5 font-medium text-emerald-700 text-xs dark:border-success-border dark:bg-success-surface dark:text-emerald-300">
        <CheckIcon className="size-3" />
        {assistantT("approved")}
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive-border bg-destructive-surface px-2 py-0.5 font-medium text-destructive text-xs dark:border-destructive-border dark:bg-destructive-surface dark:text-destructive-muted">
      <XIcon className="size-3" />
      {assistantT("rejected")}
    </span>
  );
};

export const CHIP_ERROR_CLASSES =
  "border-destructive-border bg-destructive-surface-muted text-destructive dark:bg-destructive-surface";
export const CHIP_TONE_CLASSES = {
  amber: {
    button:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400",
    expanded: "text-amber-700 dark:text-amber-400",
  },
  base: {
    button:
      "border-surface-300 bg-surface-50 text-surface-700 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300",
    expanded: "text-surface-700 dark:text-surface-300",
  },
  blue: {
    button:
      "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-400",
    expanded: "text-blue-700 dark:text-blue-400",
  },
  cyan: {
    button:
      "border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
    expanded: "text-cyan-700 dark:text-cyan-300",
  },
  green: {
    button:
      "border-success-border bg-success-surface text-success-foreground dark:border-success-border dark:bg-success-surface dark:text-success-foreground",
    expanded: "text-success-foreground dark:text-success-foreground",
  },
  indigo: {
    button:
      "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
    expanded: "text-indigo-700 dark:text-indigo-300",
  },
  emerald: {
    button:
      "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    expanded: "text-emerald-700 dark:text-emerald-300",
  },
  lime: {
    button:
      "border-lime-300 bg-lime-50 text-lime-700 dark:border-lime-700 dark:bg-lime-950 dark:text-lime-300",
    expanded: "text-lime-700 dark:text-lime-300",
  },
  orange: {
    button:
      "border-warning-border bg-warning-surface text-warning-foreground dark:border-warning-border dark:bg-warning-surface dark:text-warning-foreground",
    expanded: "text-warning-foreground dark:text-warning-foreground",
  },
  purple: {
    button:
      "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-700 dark:bg-purple-950 dark:text-purple-400",
    expanded: "text-purple-700 dark:text-purple-400",
  },
  violet: {
    button:
      "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
    expanded: "text-violet-700 dark:text-violet-300",
  },
  slate: {
    button:
      "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300",
    expanded: "text-slate-700 dark:text-slate-300",
  },
  stone: {
    button:
      "border-stone-300 bg-stone-50 text-stone-700 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300",
    expanded: "text-stone-700 dark:text-stone-300",
  },
  yellow: {
    button:
      "border-warning-border bg-warning-surface text-warning-foreground dark:border-warning-border dark:bg-warning-surface dark:text-warning-foreground",
    expanded: "text-warning-foreground dark:text-warning-foreground",
  },
} as const;
export type ChipTone = keyof typeof CHIP_TONE_CLASSES;
export const getChipToneClasses = (tone: ChipTone, hasError: boolean) =>
  hasError ? CHIP_ERROR_CLASSES : CHIP_TONE_CLASSES[tone].button;
export const getExpandedChipClasses = (tone: ChipTone, hasError: boolean) =>
  cn(
    "mt-2 space-y-2 border-l pl-2",
    hasError ? "text-destructive" : CHIP_TONE_CLASSES[tone].expanded,
  );
export const CHIP_DETAIL_HEADER_CLASSES =
  "shrink-0 border-0 bg-transparent px-3 py-2 text-[12px]";
export const RUN_COMMAND_HEADER_CLASSES =
  "shrink-0 border-0 bg-transparent px-3 pt-2 pb-1 text-[12px]";
export const CHIP_ENTER_ANIMATION_CLASS = "animate-[chip-enter_0.3s_ease-out]";
export const CHIP_BUTTON_BASE_CLASSES =
  "inline-flex items-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-1 text-xs transition-colors";

const ChipAnimateContext = createContext(false);
export const ChipAnimateProvider = ChipAnimateContext.Provider;
export const useChipAnimate = () => useContext(ChipAnimateContext);
export const CHIP_SUBTEXT_CLASSES = "opacity-70";
export const CHIP_ERROR_SUBTEXT_CLASSES = "text-destructive-muted";
export const CHIP_LAYOUT_TRANSITION = {
  damping: 32,
  duration: 0.18,
  stiffness: 520,
  type: "spring",
} as const;

export const ChipButton = ({
  className,
  hasError = false,
  tone,
  ...props
}: ComponentProps<typeof motion.button> & {
  hasError?: boolean;
  tone?: ChipTone;
}) => {
  const animate = useChipAnimate();
  return (
    <motion.button
      className={cn(
        CHIP_BUTTON_BASE_CLASSES,
        animate && CHIP_ENTER_ANIMATION_CLASS,
        tone ? getChipToneClasses(tone, hasError) : undefined,
        className,
      )}
      layout="size"
      transition={CHIP_LAYOUT_TRANSITION}
      {...props}
    />
  );
};
