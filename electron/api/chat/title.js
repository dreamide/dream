// Chat titles: a short prompt to the chat's provider, or a local heuristic
// for providers with no cheap one-shot mode. The provider registry supplies
// the model choice and the runner.
import { getProvider } from "../providers/registry.js";

const CHAT_TITLE_MAX_LENGTH = 60;
const CHAT_TITLE_PROMPT_MAX_CHARS = 12_000;
const CHAT_TITLE_TIMEOUT_MS = 60_000;
const CHAT_TITLE_SYSTEM_PROMPT =
  "Generate concise chat titles. Return only the title, with no quotes or extra commentary.";

const buildChatTitlePrompt = (promptText) =>
  [
    "Create a short title for a new coding chat from the user's first message.",
    "Rules:",
    "- Use 3 to 6 words when possible.",
    `- Stay under ${CHAT_TITLE_MAX_LENGTH} characters.`,
    "- Do not wrap the title in quotes.",
    "- Do not end with punctuation unless it is part of a proper name.",
    "",
    "User message:",
    promptText,
  ].join("\n");

const stripWrappingQuotes = (value) =>
  value.replace(/^["'`]+/, "").replace(/["'`]+$/, "");

export const sanitizeGeneratedChatTitle = (value) => {
  const title = stripWrappingQuotes(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .replace(/[.!?]+$/, "")
    .trim();

  if (!title) {
    return "";
  }

  return title.slice(0, CHAT_TITLE_MAX_LENGTH).trim();
};

const LOCAL_TITLE_LEADING_FILLERS = new Set([
  "can",
  "could",
  "please",
  "would",
  "you",
]);

const toLocalTitleWord = (word) => {
  if (/^[A-Z0-9._/-]+$/.test(word)) {
    return word;
  }

  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};

export const generateLocalChatTitle = (promptText) => {
  const words = String(promptText ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#:[\]{}()]/g, " ")
    .match(/[a-zA-Z0-9][a-zA-Z0-9._/+:-]*/g);

  if (!words || words.length === 0) {
    return "";
  }

  const meaningfulWords = words.filter(
    (word, index) =>
      index > 3 || !LOCAL_TITLE_LEADING_FILLERS.has(word.toLowerCase()),
  );
  const titleWords = (meaningfulWords.length > 0 ? meaningfulWords : words)
    .slice(0, 6)
    .map(toLocalTitleWord);

  return sanitizeGeneratedChatTitle(titleWords.join(" ")) || "New Chat";
};

export const generateChatTitle = async ({
  fallbackModel,
  projectPath,
  promptText,
  provider: providerId,
}) => {
  const normalizedPrompt = String(promptText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedPrompt) {
    return "";
  }
  const titlePromptText =
    normalizedPrompt.length > CHAT_TITLE_PROMPT_MAX_CHARS
      ? `${normalizedPrompt.slice(0, CHAT_TITLE_PROMPT_MAX_CHARS)}\n\n[Message truncated for title generation.]`
      : normalizedPrompt;

  const provider = getProvider(providerId);
  const model = provider.titleModel(fallbackModel);
  if (!model) {
    return generateLocalChatTitle(titlePromptText);
  }

  return sanitizeGeneratedChatTitle(
    await provider.generateText({
      model,
      projectPath,
      prompt: buildChatTitlePrompt(titlePromptText),
      reasoningEffort: "low",
      system: CHAT_TITLE_SYSTEM_PROMPT,
      timeoutMs: CHAT_TITLE_TIMEOUT_MS,
    }),
  );
};
