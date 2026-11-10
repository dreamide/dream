// Attachment content as a prompt can describe it, independent of provider
// translation and of whether files live for a turn or for a whole chat.
import path from "node:path";

const IMAGE_MEDIA_TYPES = new Set([
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

export const getAttachmentLabel = (part) => {
  return (
    (typeof part.filename === "string" && part.filename.trim()) ||
    (typeof part.mediaType === "string" && part.mediaType.trim()) ||
    "attachment"
  );
};

export const parseAttachmentDataUrl = (value) => {
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

export const getAttachmentExtensionFromMediaType = (mediaType) => {
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

export const sanitizeAttachmentFilename = (filename, fallback) => {
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

export const isImageAttachment = (mediaType, filename) => {
  if (typeof mediaType === "string" && IMAGE_MEDIA_TYPES.has(mediaType)) {
    return true;
  }

  return /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(filename || "");
};

const isTextAttachment = (mediaType, filename) => {
  if (typeof mediaType === "string") {
    if (mediaType.startsWith("text/")) {
      return true;
    }

    if (TEXT_ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
      return true;
    }
  }

  return /\.(?:c|cc|cpp|css|csv|go|html?|java|js|json|jsx|log|md|mjs|php|py|rb|rs|sh|sql|svg|toml|ts|tsv|tsx|txt|xml|ya?ml)$/i.test(
    filename || "",
  );
};

const getAttachmentMediaType = (part, parsedDataUrl) =>
  (typeof part.mediaType === "string" && part.mediaType.trim()) ||
  parsedDataUrl?.mediaType ||
  null;

/** Whether a provider that forwards images inline will receive this part. */
export const isImageFilePart = (part) =>
  /^image\//i.test(
    getAttachmentMediaType(part, parseAttachmentDataUrl(part.url)) ?? "",
  );

/** Whether a summary of this part stands for its contents, not just its name. */
export const isAttachmentContentInPrompt = (part) => {
  const parsedDataUrl = parseAttachmentDataUrl(part.url);
  const mediaType = getAttachmentMediaType(part, parsedDataUrl);
  return (
    isImageAttachment(mediaType, part.filename) ||
    (Boolean(parsedDataUrl) && isTextAttachment(mediaType, part.filename))
  );
};

export const describeAttachment = (part) => {
  const label = getAttachmentLabel(part);
  const parsedDataUrl = parseAttachmentDataUrl(part.url);
  const mediaType = getAttachmentMediaType(part, parsedDataUrl);

  if (isImageAttachment(mediaType, part.filename)) {
    return `[Attached image: ${label}${mediaType ? ` (${mediaType})` : ""}]`;
  }

  if (parsedDataUrl && isTextAttachment(mediaType, part.filename)) {
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

export const getMessageFileParts = (message) => {
  if (!message || typeof message !== "object") {
    return [];
  }

  return (Array.isArray(message.parts) ? message.parts : []).filter(
    (part) => part && typeof part === "object" && part.type === "file",
  );
};
