import type { UIMessage } from "ai";
import { PIPELINE_OUTPUT_MAX_CHARS } from "@/lib/pipeline-defaults";
import {
  getToolName,
  isToolLikePart,
  normalizeToolName,
} from "../../assistant-message-tools";

const cap = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > PIPELINE_OUTPUT_MAX_CHARS
    ? `${trimmed.slice(0, PIPELINE_OUTPUT_MAX_CHARS)}\n\n[truncated]`
    : trimmed;
};

/**
 * The text a pipeline step hands to the next step: the last assistant
 * message's text. When the agent submitted a plan through ExitPlanMode, that
 * plan wins, because plan-mode agents often put the whole plan in the tool
 * call and only a short remark in the text.
 */
export const extractStepOutput = (messages: UIMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const parts = message.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (
        part &&
        isToolLikePart(part) &&
        normalizeToolName(getToolName(part)) === "exit-plan-mode"
      ) {
        const plan = (part.input as { plan?: unknown } | null | undefined)
          ?.plan;
        if (typeof plan === "string" && plan.trim()) {
          return cap(plan);
        }
      }
    }

    const text = parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n");
    if (text.trim()) {
      return cap(text);
    }
  }

  return "";
};
