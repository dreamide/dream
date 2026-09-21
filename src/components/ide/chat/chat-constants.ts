import type { AiProvider } from "@/types/ide";

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok Build",
};

export const CHAT_STREAM_UPDATE_THROTTLE_MS = 50;
