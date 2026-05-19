import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const getCodexSessionId = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const isCodexResumeFailure = (detail) => {
  if (typeof detail !== "string") {
    return false;
  }

  const normalized = detail.toLowerCase();
  return (
    normalized.includes("thread/resume failed") ||
    normalized.includes("no rollout found for thread id")
  );
};

export const stringifyCodexValue = (value) => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const parseCodexErrorPayload = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

export const getCodexErrorDetail = (event) => {
  if (!event || typeof event !== "object") {
    return null;
  }

  const directMessage =
    typeof event.message === "string" ? event.message.trim() : "";
  const parsedDirectMessage = parseCodexErrorPayload(directMessage);
  const nestedMessage =
    typeof event.error?.message === "string" ? event.error.message.trim() : "";
  const parsedNestedMessage = parseCodexErrorPayload(nestedMessage);

  return (
    parsedDirectMessage?.error?.message ||
    directMessage ||
    parsedNestedMessage?.error?.message ||
    nestedMessage ||
    null
  );
};

const CODEX_IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const TEXT_ATTACHMENT_CHAR_LIMIT = 60_000;
const TEXT_ATTACHMENT_MEDIA_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-sh",
  "application/xml",
  "application/yaml",
]);

const getCodexAttachmentLabel = (part) => {
  return (
    (typeof part.filename === "string" && part.filename.trim()) ||
    (typeof part.mediaType === "string" && part.mediaType.trim()) ||
    "attachment"
  );
};

const parseCodexDataUrl = (value) => {
  if (typeof value !== "string" || !value.startsWith("data:")) {
    return null;
  }

  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }

  const metadata = value.slice(5, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const segments = metadata.split(";").filter(Boolean);
  const isBase64 = segments.includes("base64");
  const mediaType = segments.find((segment) => segment !== "base64") || null;

  try {
    return {
      buffer: isBase64
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8"),
      mediaType,
    };
  } catch {
    return null;
  }
};

const getAttachmentExtensionFromMediaType = (mediaType) => {
  switch (mediaType) {
    case "application/javascript":
      return ".js";
    case "application/json":
    case "application/ld+json":
      return ".json";
    case "application/sql":
      return ".sql";
    case "application/toml":
      return ".toml";
    case "application/typescript":
      return ".ts";
    case "application/x-httpd-php":
      return ".php";
    case "application/x-sh":
      return ".sh";
    case "application/xml":
      return ".xml";
    case "application/yaml":
      return ".yaml";
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    case "text/css":
      return ".css";
    case "text/html":
      return ".html";
    case "text/javascript":
      return ".js";
    case "text/markdown":
      return ".md";
    case "text/plain":
      return ".txt";
    case "text/typescript":
      return ".ts";
    case "text/x-python":
      return ".py";
    case "text/xml":
      return ".xml";
    case "text/yaml":
      return ".yaml";
    default:
      return "";
  }
};

const sanitizeCodexAttachmentFilename = (filename, fallback) => {
  const basename = path.basename(
    typeof filename === "string" && filename.trim()
      ? filename.trim()
      : fallback,
  );
  const sanitized = basename
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
};

const isCodexImageAttachment = (mediaType, filename) => {
  if (typeof mediaType === "string" && CODEX_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return true;
  }

  return /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(filename || "");
};

const isCodexTextAttachment = (mediaType, filename) => {
  if (typeof mediaType === "string") {
    if (mediaType.startsWith("text/")) {
      return true;
    }

    if (TEXT_ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
      return true;
    }
  }

  return /\.(?:c|cc|cpp|css|go|html?|java|js|json|jsx|md|mjs|php|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml)$/i.test(
    filename || "",
  );
};

const buildCodexFilePartSummary = (part) => {
  const label = getCodexAttachmentLabel(part);
  const parsedDataUrl = parseCodexDataUrl(part.url);
  const mediaType =
    (typeof part.mediaType === "string" && part.mediaType.trim()) ||
    parsedDataUrl?.mediaType ||
    null;

  if (isCodexImageAttachment(mediaType, part.filename)) {
    return `[Attached image: ${label}${mediaType ? ` (${mediaType})` : ""}]`;
  }

  if (parsedDataUrl && isCodexTextAttachment(mediaType, part.filename)) {
    const text = parsedDataUrl.buffer.toString("utf8");
    const truncated = text.length > TEXT_ATTACHMENT_CHAR_LIMIT;
    const content = truncated
      ? text.slice(0, TEXT_ATTACHMENT_CHAR_LIMIT)
      : text;

    return [
      `[Attached file: ${label}${mediaType ? ` (${mediaType})` : ""}]`,
      "Attached file contents:",
      "```text",
      content,
      "```",
      truncated ? "[File content truncated for prompt size.]" : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `[Attached file: ${label}${mediaType ? ` (${mediaType})` : ""}]`;
};

export const getCodexMessageFileParts = (message) => {
  if (!message || typeof message !== "object") {
    return [];
  }

  return (Array.isArray(message.parts) ? message.parts : []).filter(
    (part) => part && typeof part === "object" && part.type === "file",
  );
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

export const prepareCodexPromptAttachments = async (message) => {
  const fileParts = getCodexMessageFileParts(message);
  if (fileParts.length === 0) {
    return null;
  }

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "dream-codex-attachments-"),
  );
  const imagePaths = [];
  const promptLines = ["Current turn attachments:"];

  for (const [index, part] of fileParts.entries()) {
    const label = getCodexAttachmentLabel(part);
    const parsedDataUrl = parseCodexDataUrl(part.url);
    const mediaType =
      (typeof part.mediaType === "string" && part.mediaType.trim()) ||
      parsedDataUrl?.mediaType ||
      null;

    if (!parsedDataUrl) {
      promptLines.push(
        `- ${label}${mediaType ? ` (${mediaType})` : ""}: attachment payload unavailable in the Codex bridge.`,
      );
      continue;
    }

    const fallbackName = `attachment-${index + 1}${getAttachmentExtensionFromMediaType(mediaType)}`;
    const filename = sanitizeCodexAttachmentFilename(
      part.filename,
      fallbackName,
    );
    const filePath = path.join(tempDir, `${index + 1}-${filename}`);
    await fs.writeFile(filePath, parsedDataUrl.buffer);

    const isImage = isCodexImageAttachment(mediaType, filePath);
    if (isImage) {
      imagePaths.push(filePath);
    }

    promptLines.push(
      `- ${label}${mediaType ? ` (${mediaType})` : ""}: ${filePath}${isImage ? " [also passed via --image]" : ""}`,
    );
  }

  return {
    addDirs: [tempDir],
    cleanup: () => {
      void fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
    },
    imagePaths,
    promptText: promptLines.join("\n"),
  };
};

export const serializeCodexMessage = (message) => {
  if (!message || typeof message !== "object") {
    return "";
  }

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
      sections.push(buildCodexFilePartSummary(part));
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
      const toolSummary = [
        `[Tool ${toolName}]`,
        part.input !== undefined
          ? `input:\n${stringifyCodexValue(part.input)}`
          : null,
        part.output !== undefined
          ? `output:\n${stringifyCodexValue(part.output)}`
          : null,
        typeof part.errorText === "string" && part.errorText.trim()
          ? `error:\n${part.errorText.trim()}`
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

  return `${role.toUpperCase()}:\n${sections.join("\n\n")}`;
};

export const buildCodexConversationPrompt = ({
  currentTurnAttachments,
  currentTurnProjectReferences,
  messages,
  projectPath,
  runtimeDescription = "You are running through the real Codex CLI with native shell and git access.",
  systemPrompt,
}) => {
  const transcript = messages
    .map(serializeCodexMessage)
    .filter(Boolean)
    .join("\n\n");

  return [
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
};

export const getLatestUserPrompt = (
  messages,
  currentTurnAttachments = null,
  currentTurnProjectReferences = null,
) => {
  const latestUserMessage = getLatestUserMessage(messages);
  if (!latestUserMessage) {
    return [currentTurnProjectReferences, currentTurnAttachments]
      .filter(Boolean)
      .join("\n\n");
  }

  const serialized = serializeCodexMessage(latestUserMessage);
  return [serialized, currentTurnProjectReferences, currentTurnAttachments]
    .filter(Boolean)
    .join("\n\n");
};
