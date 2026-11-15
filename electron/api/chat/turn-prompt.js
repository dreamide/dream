// The Turn prompt: what an Agent turn sends its provider, given how the turn
// started. The adapter's native probe says whether the saved Provider session
// was resumed (provider-session.js decides what to ask for; the adapter
// reports what happened). From that, this module decides for every adapter:
//
// - resumed: the latest user message, the project references, the handoff
//   (what the provider missed) and the current turn's attachments;
// - not resumed: the history reconstructed as a transcript, without the
//   handoff (the transcript already holds those messages), bounded to the
//   reconstructed-prompt limits.
//
// Text-prompt adapters (Codex, OpenCode, ACP, Antigravity) send
// `buildTurnPrompt`'s text, with the skill's slash prefix when one is
// dispatched. Claude sends structured messages, so it takes
// `decideTurnContent` and encodes the messages and attachments natively.
// Adapters keep their native probe, their native session handling and their
// report of how the turn started (`turn.session`).
import { describeAttachment } from "../../shared/attachment-content.js";

/**
 * The bound on a reconstructed prompt, in characters: the whole prompt, each
 * non-user message, and each tool input or output in the transcript. The
 * oldest messages are dropped first.
 */
export const RECONSTRUCTED_PROMPT_BOUND = Object.freeze({
  maxChars: 700_000,
  maxMessageChars: 200_000,
  maxToolValueChars: 12_000,
});

const TEXT_INPUT_CHUNK_CHAR_LIMIT = 900_000;

const getCharLimit = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;

const stringifyValue = (value) => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const truncateText = (value, maxChars, label, limitLabel) => {
  const limit = getCharLimit(maxChars);
  if (limit === null || value.length <= limit) {
    return value;
  }

  const marker = `\n...[${label} truncated to fit ${limitLabel} input limits]...\n`;
  if (limit <= marker.length) {
    return value.slice(0, limit);
  }

  const availableChars = limit - marker.length;
  const headChars = Math.ceil(availableChars * 0.65);
  const tailChars = availableChars - headChars;
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
};

const buildBoundedTranscript = (serializedMessages, maxChars, limitLabel) => {
  const limit = getCharLimit(maxChars);
  const transcript = serializedMessages.join("\n\n");
  if (limit === null || transcript.length <= limit) {
    return transcript;
  }

  const notice = `[Conversation transcript truncated to fit ${limitLabel} input limits.]`;
  if (limit <= notice.length) {
    return notice.slice(0, limit);
  }

  let remainingChars = limit - notice.length - 2;
  const selectedMessages = [];

  for (let index = serializedMessages.length - 1; index >= 0; index -= 1) {
    const serialized = serializedMessages[index];
    const separatorChars = selectedMessages.length > 0 ? 2 : 0;
    const availableChars = remainingChars - separatorChars;
    if (availableChars <= 0) {
      break;
    }

    if (serialized.length <= availableChars) {
      selectedMessages.unshift(serialized);
      remainingChars -= serialized.length + separatorChars;
      continue;
    }

    selectedMessages.unshift(
      truncateText(serialized, availableChars, "message", limitLabel),
    );
    break;
  }

  return [notice, ...selectedMessages].join("\n\n");
};

export const getLatestUserMessage = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") {
      return message;
    }
  }

  return null;
};

/** Splits a long text into parts a provider accepts one at a time. */
export const chunkTextInput = (
  text,
  chunkSize = TEXT_INPUT_CHUNK_CHAR_LIMIT,
) => {
  if (typeof text !== "string" || text.length <= chunkSize) {
    return [text ?? ""];
  }

  const chunks = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
};

/**
 * One message as prompt text: its text, its attachments described by the
 * shared attachment rules, and its tool calls. Labelled with its role
 * (`USER:`) unless `labelled` is false.
 *
 * @param {any} message
 * @param {{ labelled?: boolean, limitLabel?: string, maxMessageChars?: number,
 *   maxToolValueChars?: number }} [options]
 */
export const serializeTurnMessage = (message, options) => {
  if (!message || typeof message !== "object") {
    return "";
  }

  const {
    labelled = true,
    limitLabel = "provider",
    maxMessageChars: messageLimit,
    maxToolValueChars: toolValueLimit,
  } = options && typeof options === "object" ? options : {};
  const maxMessageChars = getCharLimit(messageLimit);
  const maxToolValueChars = getCharLimit(toolValueLimit);
  const role =
    typeof message.role === "string" && message.role.trim()
      ? message.role.trim()
      : "unknown";
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const sections = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.trim();
      if (text) {
        sections.push(text);
      }
      continue;
    }

    if (part.type === "file") {
      sections.push(describeAttachment(part));
      continue;
    }

    if (
      typeof part.type === "string" &&
      (part.type.startsWith("tool-") || part.type === "dynamic-tool")
    ) {
      const toolName =
        part.type === "dynamic-tool"
          ? typeof part.toolName === "string" && part.toolName.trim()
            ? part.toolName.trim()
            : "tool"
          : part.type.slice(5);
      const formatToolValue = (value, label) =>
        truncateText(
          stringifyValue(value),
          maxToolValueChars,
          `${toolName} ${label}`,
          limitLabel,
        );
      const toolSummary = [
        `[Tool ${toolName}]`,
        part.input !== undefined
          ? `input:\n${formatToolValue(part.input, "input")}`
          : null,
        part.output !== undefined
          ? `output:\n${formatToolValue(part.output, "output")}`
          : null,
        typeof part.errorText === "string" && part.errorText.trim()
          ? `error:\n${formatToolValue(part.errorText.trim(), "error")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      if (toolSummary) {
        sections.push(toolSummary);
      }
    }
  }

  if (sections.length === 0) {
    return "";
  }

  const body = sections.join("\n\n");
  return truncateText(
    labelled ? `${role.toUpperCase()}:\n${body}` : body,
    role.toLowerCase() === "user" ? null : maxMessageChars,
    `${role} message`,
    limitLabel,
  );
};

/** The project references with the handoff after them, or null. */
export const withSessionHandoff = (projectReferencesPrompt, sessionHandoff) =>
  [projectReferencesPrompt, sessionHandoff].filter(Boolean).join("\n\n") ||
  null;

/** A `$skill` dispatched as the agent's own `/name`, which it reads first. */
export const applySkillSlashPrefix = (prompt, slashCommand) => {
  if (!slashCommand) {
    return prompt;
  }
  return `/${slashCommand} ${prompt}`;
};

/**
 * The history reconstructed as one prompt: framing, the transcript, the
 * references and the current turn's attachments. With a `bound`, the oldest
 * messages give way first so the whole prompt fits.
 *
 * @param {{
 *   bound?: { maxChars?: number, maxMessageChars?: number,
 *     maxToolValueChars?: number } | null,
 *   currentTurnAttachments?: string | null,
 *   currentTurnProjectReferences?: string | null,
 *   limitLabel?: string,
 *   messages: any[],
 *   projectPath: string,
 *   runtimeDescription: string,
 *   systemPrompt?: string | null,
 * }} options
 */
export const buildReconstructedPrompt = ({
  bound = null,
  currentTurnAttachments,
  currentTurnProjectReferences,
  limitLabel = "provider",
  messages,
  projectPath,
  runtimeDescription,
  systemPrompt,
}) => {
  const { maxChars, maxMessageChars, maxToolValueChars } = bound ?? {};
  const serializedMessages = messages
    .map((message) =>
      serializeTurnMessage(message, {
        limitLabel,
        maxMessageChars,
        maxToolValueChars,
      }),
    )
    .filter(Boolean);
  const composePrompt = (transcript) =>
    [
      systemPrompt,
      `Active project: ${projectPath}`,
      runtimeDescription,
      transcript ? `Conversation transcript:\n\n${transcript}` : null,
      currentTurnProjectReferences,
      currentTurnAttachments,
      "Continue the conversation naturally and complete the user's latest request.",
    ]
      .filter(Boolean)
      .join("\n\n");
  const promptLimit = getCharLimit(maxChars);

  if (promptLimit === null || serializedMessages.length === 0) {
    return truncateText(
      composePrompt(serializedMessages.join("\n\n")),
      promptLimit,
      "prompt",
      limitLabel,
    );
  }

  const promptWithoutTranscript = composePrompt(null);
  const transcriptPrefix = "Conversation transcript:\n\n";
  const transcriptBudget = Math.max(
    0,
    promptLimit - promptWithoutTranscript.length - transcriptPrefix.length - 2,
  );
  const transcript = buildBoundedTranscript(
    serializedMessages,
    transcriptBudget,
    limitLabel,
  );

  return truncateText(
    composePrompt(transcript),
    promptLimit,
    "prompt",
    limitLabel,
  );
};

/**
 * The latest user message with the context and attachments after it.
 * `labelled: false` sends the user's own words without the `USER:` label.
 */
export const buildLatestUserPrompt = (
  messages,
  currentTurnAttachments = null,
  context = null,
  { labelled = true } = {},
) => {
  const latestUserMessage = getLatestUserMessage(messages);
  const serialized = latestUserMessage
    ? serializeTurnMessage(latestUserMessage, { labelled })
    : null;
  return [serialized, context, currentTurnAttachments]
    .filter(Boolean)
    .join("\n\n");
};

/**
 * The shared decision, for any form the provider takes: which messages the
 * turn carries and the context sent with them. A resumed turn carries only
 * the latest user message, with the handoff after the references; a turn
 * that did not resume carries the whole history and the references alone.
 *
 * @param {{ resumed: boolean, messages: any[],
 *   projectReferencesPrompt?: string | null, sessionHandoff?: string | null }} options
 * @returns {{ resumed: boolean, messages: any[], context: string | null }}
 */
export const decideTurnContent = ({
  messages,
  projectReferencesPrompt = null,
  resumed,
  sessionHandoff = null,
}) =>
  resumed
    ? {
        context: withSessionHandoff(projectReferencesPrompt, sessionHandoff),
        messages: [getLatestUserMessage(messages)].filter(Boolean),
        resumed: true,
      }
    : {
        context: projectReferencesPrompt || null,
        messages,
        resumed: false,
      };

/**
 * The text a text-prompt provider is sent for this turn.
 *
 * `form` is the provider's framing: `label` names it in a truncation notice,
 * `runtimeDescription` and `systemPrompt` frame a reconstruction, and
 * `plain` is for a provider that takes the user's own words, so the latest
 * message is sent unlabelled and a first turn (a single message) is sent as
 * that message rather than as a transcript.
 *
 * @param {{
 *   resumed: boolean,
 *   messages: any[],
 *   projectPath: string,
 *   projectReferencesPrompt?: string | null,
 *   sessionHandoff?: string | null,
 *   currentTurnAttachments?: string | null,
 *   skillSlashCommand?: string | null,
 *   form: { label: string, runtimeDescription: string,
 *     systemPrompt?: string | null, plain?: boolean },
 * }} options
 */
export const buildTurnPrompt = ({
  currentTurnAttachments = null,
  form,
  messages,
  projectPath,
  projectReferencesPrompt = null,
  resumed,
  sessionHandoff = null,
  skillSlashCommand = null,
}) => {
  const { context } = decideTurnContent({
    messages,
    projectReferencesPrompt,
    resumed,
    sessionHandoff,
  });
  const plain = form.plain === true;
  const prompt =
    resumed || (plain && messages.length <= 1)
      ? buildLatestUserPrompt(messages, currentTurnAttachments, context, {
          labelled: !plain,
        })
      : buildReconstructedPrompt({
          bound: RECONSTRUCTED_PROMPT_BOUND,
          currentTurnAttachments,
          currentTurnProjectReferences: context,
          limitLabel: form.label,
          messages,
          projectPath,
          runtimeDescription: form.runtimeDescription,
          systemPrompt: form.systemPrompt,
        });
  return applySkillSlashPrefix(prompt, skillSlashCommand);
};
