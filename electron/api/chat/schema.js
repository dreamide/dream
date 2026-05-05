import { z } from "zod";

export const chatRequestBodySchema = z.object({
  claudePermissionMode: z
    .enum([
      "ask-permissions",
      "accept-edits",
      "plan-mode",
      "bypass-permissions",
    ])
    .default("ask-permissions"),
  codexPermissionMode: z
    .enum(["default", "auto-accept-edits", "full-access"])
    .default("default"),
  messages: z.array(z.unknown()),
  model: z.string().min(1),
  modelLabel: z.string().min(1).optional(),
  projectPath: z.string().min(1),
  provider: z.enum(["openai", "anthropic"]),
  remoteConversationId: z.string().nullable().optional(),
  remoteConversationModel: z.string().nullable().optional(),
  remoteConversationProjectPath: z.string().nullable().optional(),
  reasoningEffort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .default("medium"),
  reasoningLabel: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

export const chatTitleRequestBodySchema = z.object({
  fallbackModel: z.string().min(1).optional(),
  projectPath: z.string().min(1),
  promptText: z.string(),
  provider: z.enum(["openai", "anthropic"]),
});

export const SYSTEM_PROMPT = `You are an expert coding copilot embedded in a desktop IDE.

Your primary responsibility is to safely edit files inside the active project.
Use the available tools to inspect files before proposing changes.
Always reference concrete files and exact updates.
When writing files, prefer complete and correct output over partial snippets.
Never attempt to access files outside the active project root.

Important: Always explain your reasoning and findings in text before and after making tool calls. Briefly describe what you are looking for, what you found, and what you plan to do next. Do not make sequences of tool calls without any explanatory text in between.`;

export const DEFAULT_TOOL_STEP_LIMIT = 8;
export const REASONING_TOOL_STEP_LIMIT = 50;
