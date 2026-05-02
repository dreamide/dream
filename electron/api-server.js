/**
 * Hono-based API server for Dream IDE.
 *
 * Migrated from Next.js App Router route handlers.  Each route keeps the same
 * Request/Response contract so the renderer `fetch("/api/…")` calls work
 * unchanged.
 *
 * This file is loaded by the Electron main process at startup.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { parsePatchFiles } from "@pierre/diffs";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import { Hono } from "hono";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_MODELS_CACHE_FILE = path.join(
  os.homedir(),
  ".codex",
  "models_cache.json",
);
const VALID_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const CLAUDE_REASONING_EFFORT_MAP = {
  high: "high",
  low: "low",
  max: "max",
  medium: "medium",
  xhigh: "high",
};
const MIME_TYPES = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const readCodexAuthFile = async () => {
  try {
    const contents = await fs.readFile(CODEX_AUTH_FILE, "utf8");
    return JSON.parse(contents);
  } catch {
    return null;
  }
};

const readCodexAccessToken = async () => {
  const authData = await readCodexAuthFile();

  if (!authData) {
    return null;
  }

  return authData.tokens?.access_token?.trim() || null;
};

const normalizeReasoningEfforts = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts = [];
  for (const entry of value) {
    const effort =
      typeof entry === "string"
        ? entry
        : typeof entry?.effort === "string"
          ? entry.effort
          : null;
    if (!effort || !VALID_REASONING_EFFORTS.has(effort)) {
      continue;
    }
    if (!efforts.includes(effort)) {
      efforts.push(effort);
    }
  }

  return efforts;
};

const readCodexModelsCache = async () => {
  try {
    const contents = await fs.readFile(CODEX_MODELS_CACHE_FILE, "utf8");
    const parsed = JSON.parse(contents);
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Model helpers (was src/lib/models.ts — only the parts used server‑side)
// ---------------------------------------------------------------------------

const getModelReasoningEfforts = (provider, modelId) => {
  const id = modelId.trim().toLowerCase();
  if (!id) return [];

  if (provider === "openai") {
    const isReasoning = ["gpt-5", "o1", "o3", "o4", "codex"].some(
      (prefix) =>
        id === prefix ||
        id.startsWith(`${prefix}-`) ||
        id.startsWith(`${prefix}.`),
    );
    return isReasoning ? ["low", "medium", "high", "xhigh"] : [];
  }

  if (provider === "anthropic") {
    if (["opus", "sonnet", "haiku"].includes(id)) {
      return ["low", "medium", "high", "max"];
    }
    const newFormat = id.match(/^claude-(?:sonnet|opus|haiku)-(\d+)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) return ["low", "medium", "high", "max"];
    }
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7)) {
        return ["low", "medium", "high", "max"];
      }
    }
    if (/^claude-(\d+)(?!\d)/.test(id)) {
      const majorOnly = Number(id.match(/^claude-(\d+)/)?.[1]);
      if (majorOnly >= 4) return ["low", "medium", "high", "max"];
    }
    return [];
  }

  return [];
};

const OPENAI_TOKEN_LABELS = {
  audio: "Audio",
  codex: "Codex",
  gpt: "GPT",
  mini: "Mini",
  nano: "Nano",
  omni: "Omni",
  preview: "Preview",
  realtime: "Realtime",
  search: "Search",
  transcribe: "Transcribe",
  turbo: "Turbo",
};

const ANTHROPIC_TOKEN_LABELS = {
  claude: "Claude",
  haiku: "Haiku",
  opus: "Opus",
  preview: "Preview",
  sonnet: "Sonnet",
};

const formatToken = (provider, token, isFirstToken) => {
  if (!token) return "";
  if (/^\d+(\.\d+)*$/.test(token)) return token;
  if (/^o\d/i.test(token)) return token.toLowerCase();
  const labels =
    provider === "openai" ? OPENAI_TOKEN_LABELS : ANTHROPIC_TOKEN_LABELS;
  const normalized = token.toLowerCase();
  const mapped = labels[normalized];
  if (mapped) return mapped;
  if (/^\d{8}$/.test(token)) return token;
  if (isFirstToken) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
};

const formatModelIdLabel = (provider, modelId) => {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("-").filter(Boolean);
  if (parts.length === 0) return trimmed;
  if (provider === "openai" && parts[0]?.toLowerCase() === "gpt") {
    const [, version, ...rest] = parts;
    if (!version) return "GPT";
    const suffix = rest.map((p) => formatToken(provider, p, false)).join(" ");
    return suffix ? `GPT-${version} ${suffix}` : `GPT-${version}`;
  }
  if (provider === "anthropic" && parts[0]?.toLowerCase() === "claude") {
    const rest = parts
      .slice(1)
      .map((p, i) => formatToken(provider, p, i === 0))
      .join(" ");
    return rest ? `Claude ${rest}` : "Claude";
  }
  if (
    provider === "anthropic" &&
    ["opus", "sonnet", "haiku"].includes(parts[0]?.toLowerCase() ?? "")
  ) {
    return `Claude ${formatToken(provider, parts[0], true)}`;
  }
  return parts.map((p, i) => formatToken(provider, p, i === 0)).join(" ");
};

const getModelDisplayLabel = (provider, id, label) => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  if (!trimmedLabel || trimmedLabel.toLowerCase() === trimmedId.toLowerCase()) {
    return formatModelIdLabel(provider, trimmedId);
  }

  return trimmedLabel;
};

const inferProviderForModelLabel = (id) => {
  const normalizedId = id.trim().toLowerCase();
  if (
    normalizedId.startsWith("claude-") ||
    ["haiku", "opus", "sonnet"].includes(normalizedId)
  ) {
    return "anthropic";
  }

  return "openai";
};

const createModelOption = (provider, id, label, reasoningEfforts = []) => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  const normalizedReasoningEfforts =
    normalizeReasoningEfforts(reasoningEfforts);
  return {
    id: trimmedId,
    label: getModelDisplayLabel(provider, trimmedId, trimmedLabel),
    ...(normalizedReasoningEfforts.length > 0
      ? { reasoningEfforts: normalizedReasoningEfforts }
      : {}),
  };
};

const dedupeModelOptions = (models) => {
  const seen = new Map();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const label = getModelDisplayLabel(
      inferProviderForModelLabel(id),
      id,
      model.label,
    );
    const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts);
    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, {
        id,
        label,
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      });
      continue;
    }
    seen.set(id, {
      id,
      label: existing.label || label,
      ...(existing.reasoningEfforts?.length || reasoningEfforts.length
        ? {
            reasoningEfforts: Array.from(
              new Set([
                ...(existing.reasoningEfforts ?? []),
                ...reasoningEfforts,
              ]),
            ),
          }
        : {}),
    });
  }
  return Array.from(seen.values());
};

const CLAUDE_CODE_MODEL_LABELS = {
  haiku: "Claude Haiku",
  opus: "Claude Opus",
  sonnet: "Claude Sonnet",
};

const CLAUDE_CODE_MODEL_OPTIONS = [
  createModelOption("anthropic", "sonnet", CLAUDE_CODE_MODEL_LABELS.sonnet),
  createModelOption("anthropic", "opus", CLAUDE_CODE_MODEL_LABELS.opus),
  createModelOption("anthropic", "haiku", CLAUDE_CODE_MODEL_LABELS.haiku),
];

const normalizeClaudeCodeModel = (modelId) => {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) return "sonnet";
  if (trimmed.includes("opus")) return "opus";
  if (trimmed.includes("haiku")) return "haiku";
  if (trimmed.includes("sonnet")) return "sonnet";
  return trimmed;
};

const CLAUDE_MODELS_OVERVIEW_URL =
  "https://platform.claude.com/docs/en/about-claude/models/overview";
const CLAUDE_CODE_MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let claudeCodeModelOptionsCache = {
  expiresAt: 0,
  models: CLAUDE_CODE_MODEL_OPTIONS,
};
const CLAUDE_CODE_MODEL_ORDER = { sonnet: 0, opus: 1, haiku: 2 };

const decodeHtmlEntities = (value) => {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
};

const stripHtml = (value) => {
  return decodeHtmlEntities(
    value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
  );
};

const parseClaudeCodeModelOptionsFromDocs = (html) => {
  const headerMatches = Array.from(
    html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi),
    (match) => stripHtml(match[1]).trim(),
  ).filter(Boolean);
  const modelHeaders = headerMatches.filter((header) =>
    /^Claude (Opus|Sonnet|Haiku)\b/i.test(header),
  );

  if (modelHeaders.length < 3) {
    return [];
  }

  return modelHeaders.flatMap((header) => {
    const variant = header.match(/^Claude (Opus|Sonnet|Haiku)\b/i)?.[1];
    if (!variant) return [];
    return [createModelOption("anthropic", variant.toLowerCase(), header)];
  });
};

const fetchClaudeCodeModelOptionsFromDocs = async () => {
  if (Date.now() < claudeCodeModelOptionsCache.expiresAt) {
    return claudeCodeModelOptionsCache.models;
  }

  try {
    const response = await fetch(CLAUDE_MODELS_OVERVIEW_URL, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Anthropic docs request failed (${response.status}).`);
    }

    const html = await response.text();
    const parsedModels = dedupeModelOptions(
      parseClaudeCodeModelOptionsFromDocs(html),
    ).sort((a, b) => {
      const aOrder = CLAUDE_CODE_MODEL_ORDER[a.id] ?? Number.MAX_SAFE_INTEGER;
      const bOrder = CLAUDE_CODE_MODEL_ORDER[b.id] ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
    if (parsedModels.length < 3) {
      throw new Error(
        "Anthropic docs page did not contain Claude Code models.",
      );
    }

    claudeCodeModelOptionsCache = {
      expiresAt: Date.now() + CLAUDE_CODE_MODELS_CACHE_TTL_MS,
      models: parsedModels,
    };
    return parsedModels;
  } catch {
    return CLAUDE_CODE_MODEL_OPTIONS;
  }
};

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

const formatStreamError = (error) => {
  if (error == null) return "An unknown error occurred.";
  if (typeof error === "string") return error || "An unknown error occurred.";
  if (typeof error !== "object") {
    return String(error) || "An unknown error occurred.";
  }

  const details = [];
  const isGeneric = (s) =>
    !s || s === "Error" || s === "error" || s === "Unknown error";

  const statusCode = error.statusCode ?? error.status;
  if (statusCode) details.push(`[${statusCode}]`);

  const msg = error.message;
  if (!isGeneric(msg)) {
    details.push(msg);
  }

  const errData = error.data?.error ?? error.data;
  if (errData && typeof errData === "object") {
    const errType = errData.type ?? errData.code;
    if (typeof errType === "string" && errType.length > 0) {
      details.push(errType.replaceAll("_", " "));
    }
    const errMsg = errData.message;
    if (typeof errMsg === "string" && !isGeneric(errMsg) && errMsg !== msg) {
      details.push(errMsg);
    }
  }

  if (
    details.length <= 1 &&
    typeof error.responseBody === "string" &&
    error.responseBody.length > 0
  ) {
    try {
      const body = JSON.parse(error.responseBody);
      const bodyErrType = body?.error?.type ?? body?.error?.code;
      const bodyMsg =
        body?.error?.message ?? body?.message ?? body?.error_description;
      if (typeof bodyErrType === "string" && bodyErrType.length > 0) {
        details.push(bodyErrType.replaceAll("_", " "));
      }
      if (
        typeof bodyMsg === "string" &&
        !isGeneric(bodyMsg) &&
        bodyMsg !== msg
      ) {
        details.push(bodyMsg);
      }
    } catch {
      const trimmed = error.responseBody.trim();
      if (trimmed.length > 0 && trimmed.length < 500 && trimmed !== msg) {
        details.push(trimmed);
      }
    }
  }

  let cause = error.cause;
  const seen = new Set();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    if (!isGeneric(causeMsg) && causeMsg !== msg) {
      details.push(causeMsg);
      break;
    }
    cause = cause?.cause;
  }

  if (details.length > 0) return details.join(" — ");

  return "An unexpected error occurred. Check the server console for details.";
};

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// ── /api/provider-models ─────────────────────────────────────────────────────

const OPENAI_CODEX_CHATGPT_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_VERSION = "1.0.0";

const dedupeAndSort = (models) => {
  return dedupeModelOptions(models)
    .sort((a, b) => a.id.localeCompare(b.id))
    .reverse();
};

const _isOpenAiChatModel = (model) => {
  return model.startsWith("gpt-") || /^o\d/.test(model);
};

const fetchOpenAiModelsWithCodexChatgpt = async (accessToken) => {
  const cachedModels = await readCodexModelsCache();
  const cachedModelsById = new Map(
    cachedModels
      .map((entry) => [
        typeof entry?.slug === "string" ? entry.slug.trim() : "",
        entry,
      ])
      .filter(([id]) => id),
  );
  const url = new URL(OPENAI_CODEX_CHATGPT_MODELS_URL);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Codex model request failed (${response.status}).`);
  }
  const payload = await response.json();
  const modelIds = (payload.models ?? []).flatMap((entry) => {
    const id = entry.slug?.trim() ?? "";
    if (!id) return [];
    const cachedEntry = cachedModelsById.get(id);
    const entryReasoningEfforts = normalizeReasoningEfforts(
      entry.supported_reasoning_levels,
    );
    const cachedReasoningEfforts = normalizeReasoningEfforts(
      cachedEntry?.supported_reasoning_levels,
    );
    const reasoningEfforts =
      entryReasoningEfforts.length > 0
        ? entryReasoningEfforts
        : cachedReasoningEfforts;
    return [
      createModelOption(
        "openai",
        id,
        entry.display_name ?? cachedEntry?.display_name,
        reasoningEfforts.length > 0
          ? reasoningEfforts
          : getModelReasoningEfforts("openai", id),
      ),
    ];
  });
  return dedupeAndSort(modelIds);
};

const isCliCommandAvailable = async (commandName) => {
  try {
    if (process.platform === "win32") {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-Command ${commandName} -ErrorAction Stop).Path`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );
      return true;
    }

    await execFileAsync("which", [commandName], {
      encoding: "utf8",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
};

const getCliVersion = async (commandName) => {
  try {
    if (process.platform === "win32") {
      const result = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$command = (Get-Command ${commandName} -ErrorAction Stop).Path; & $command --version`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );

      return result.stdout.trim() || result.stderr.trim() || null;
    }

    const result = await execFileAsync(commandName, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });

    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
};

const fetchOpenAiModels = async () => {
  const installed = await isCliCommandAvailable("codex");
  if (!installed) {
    return {
      error: "Codex CLI is not installed or not available on PATH.",
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }
  const version = await getCliVersion("codex");

  const accessToken = await readCodexAccessToken();
  if (!accessToken) {
    return {
      error: "Run `codex login` to fetch Codex models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  }

  try {
    const models = await fetchOpenAiModelsWithCodexChatgpt(accessToken);
    if (models.length === 0) {
      return {
        error: "Codex returned no models.",
        installed: true,
        models: [],
        source: "unavailable",
        version,
      };
    }

    return { installed: true, models, source: "cli", version };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Codex models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  }
};
const fetchAnthropicModels = async () => {
  const installed = await isCliCommandAvailable("claude");
  if (!installed) {
    return {
      error: "Claude Code CLI is not installed or not available on PATH.",
      installed: false,
      models: [],
      source: "unavailable",
      version: null,
    };
  }
  const version = await getCliVersion("claude");

  try {
    const models = await fetchClaudeCodeModelOptionsFromDocs();
    if (models.length === 0) {
      return {
        error: "Claude Code returned no supported models.",
        installed: true,
        models: [],
        source: "unavailable",
        version,
      };
    }

    return {
      installed: true,
      models,
      source: "cli",
      version,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Claude Code models.",
      installed: true,
      models: [],
      source: "unavailable",
      version,
    };
  }
};

app.post("/api/provider-models", async (c) => {
  const [openai, anthropic] = await Promise.all([
    fetchOpenAiModels(),
    fetchAnthropicModels(),
  ]);

  return c.json({
    anthropic,
    fetchedAt: new Date().toISOString(),
    openai,
  });
});

// ── /api/chat ────────────────────────────────────────────────────────────────

const chatRequestBodySchema = z.object({
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

const CLAUDE_PERMISSION_MODE_MAP = {
  "ask-permissions": "default",
  "accept-edits": "acceptEdits",
  "plan-mode": "plan",
  "bypass-permissions": "bypassPermissions",
};

const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const SYSTEM_PROMPT = `You are an expert coding copilot embedded in a desktop IDE.

Your primary responsibility is to safely edit files inside the active project.
Use the available tools to inspect files before proposing changes.
Always reference concrete files and exact updates.
When writing files, prefer complete and correct output over partial snippets.
Never attempt to access files outside the active project root.

Important: Always explain your reasoning and findings in text before and after making tool calls. Briefly describe what you are looking for, what you found, and what you plan to do next. Do not make sequences of tool calls without any explanatory text in between.`;

const _OPENAI_CODEX_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TOOL_STEP_LIMIT = 8;
const REASONING_TOOL_STEP_LIMIT = 50;

const normalizePath = (value) => value.replace(/\\/g, "/");

const getCodexCliSpawnErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Codex CLI not found. Install it or add it to PATH, then restart Dream.";
  }

  return error instanceof Error ? error.message : "Codex CLI request failed.";
};

const resolveCodexCliLaunch = async () => {
  if (process.platform !== "win32") {
    return { argsPrefix: [], command: "codex" };
  }

  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-Command codex -ErrorAction Stop).Path"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    const resolvedPath = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (!resolvedPath) {
      return { argsPrefix: [], command: "codex" };
    }

    const lowerResolvedPath = resolvedPath.toLowerCase();
    if (
      lowerResolvedPath.endsWith(".ps1") ||
      lowerResolvedPath.endsWith(".cmd")
    ) {
      const basedir = path.dirname(resolvedPath);
      const nodeExecutable = path.join(basedir, "node.exe");
      const codexEntrypoint = path.join(
        basedir,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );

      return {
        argsPrefix: [codexEntrypoint],
        command: nodeExecutable,
      };
    }

    return { argsPrefix: [], command: resolvedPath };
  } catch {
    return { argsPrefix: [], command: "codex" };
  }
};

const resolveProjectPath = (projectRoot, filePath) => {
  const root = path.resolve(projectRoot);
  const fullPath = path.resolve(root, filePath);
  if (fullPath === root) return fullPath;
  if (!fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path is outside of the project root.");
  }
  return fullPath;
};

const hashContent = (content) =>
  createHash("sha256").update(content, "utf8").digest("hex");

const buildLineDiff = (previousContent, nextContent) => {
  const previousLines = previousContent.split("\n");
  const nextLines = nextContent.split("\n");
  const lines = [];
  let previousIndex = 0;
  let nextIndex = 0;

  while (previousIndex < previousLines.length && nextIndex < nextLines.length) {
    if (previousLines[previousIndex] === nextLines[nextIndex]) {
      lines.push(` ${previousLines[previousIndex]}`);
      previousIndex += 1;
      nextIndex += 1;
      continue;
    }

    const nextInPrevious = previousLines.indexOf(
      nextLines[nextIndex],
      previousIndex + 1,
    );
    const previousInNext = nextLines.indexOf(
      previousLines[previousIndex],
      nextIndex + 1,
    );

    if (
      nextInPrevious !== -1 &&
      (previousInNext === -1 ||
        nextInPrevious - previousIndex <= previousInNext - nextIndex)
    ) {
      while (previousIndex < nextInPrevious) {
        lines.push(`-${previousLines[previousIndex]}`);
        previousIndex += 1;
      }
      continue;
    }

    if (previousInNext !== -1) {
      while (nextIndex < previousInNext) {
        lines.push(`+${nextLines[nextIndex]}`);
        nextIndex += 1;
      }
      continue;
    }

    lines.push(`-${previousLines[previousIndex]}`);
    lines.push(`+${nextLines[nextIndex]}`);
    previousIndex += 1;
    nextIndex += 1;
  }

  while (previousIndex < previousLines.length) {
    lines.push(`-${previousLines[previousIndex]}`);
    previousIndex += 1;
  }

  while (nextIndex < nextLines.length) {
    lines.push(`+${nextLines[nextIndex]}`);
    nextIndex += 1;
  }

  return lines.join("\n");
};

const getDiffLineCount = (content) =>
  content.length === 0 ? 0 : content.split("\n").length;

const buildSavedWriteDiff = ({
  filePath,
  isNewFile,
  nextContent,
  previousContent,
}) => {
  const normalizedFilePath = normalizePath(filePath);
  const previousLineCount = getDiffLineCount(previousContent);
  const nextLineCount = getDiffLineCount(nextContent);

  return [
    `diff --git a/${normalizedFilePath} b/${normalizedFilePath}`,
    isNewFile ? "new file mode 100644" : null,
    `--- ${isNewFile ? "/dev/null" : `a/${normalizedFilePath}`}`,
    `+++ b/${normalizedFilePath}`,
    `@@ -${isNewFile ? 0 : 1},${previousLineCount} +1,${nextLineCount} @@`,
    buildLineDiff(previousContent, nextContent),
  ]
    .filter(Boolean)
    .join("\n");
};

const walkFiles = async (root, current, maxResults, output) => {
  if (output.length >= maxResults) return;
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (output.length >= maxResults) return;
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    if (entry.isDirectory() && BLOCKED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      await walkFiles(root, absolute, maxResults, output);
      continue;
    }
    output.push(relative);
  }
};

const listProjectFiles = async (projectRoot, directory, maxResults) => {
  const targetDirectory = resolveProjectPath(projectRoot, directory);
  const stats = await fs.stat(targetDirectory);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }
  const files = [];
  await walkFiles(projectRoot, targetDirectory, maxResults, files);
  return files;
};

const searchInProjectFiles = async (projectRoot, query, maxResults) => {
  const files = await listProjectFiles(projectRoot, ".", 250);
  const matches = [];
  for (const relativePath of files) {
    if (matches.length >= maxResults) break;
    const absolutePath = resolveProjectPath(projectRoot, relativePath);
    let content = "";
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (!content.includes(query)) continue;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.includes(query)) continue;
      matches.push({ file: relativePath, line: index + 1, text: line.trim() });
      if (matches.length >= maxResults) break;
    }
  }
  return matches;
};

const codexSessionsByChatId = new Map();

const getCodexSessionId = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const isCodexResumeFailure = (detail) => {
  if (typeof detail !== "string") {
    return false;
  }

  const normalized = detail.toLowerCase();
  return (
    normalized.includes("thread/resume failed") ||
    normalized.includes("no rollout found for thread id")
  );
};

const stringifyCodexValue = (value) => {
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

const getCodexErrorDetail = (event) => {
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

const getCodexMessageFileParts = (message) => {
  if (!message || typeof message !== "object") {
    return [];
  }

  return (Array.isArray(message.parts) ? message.parts : []).filter(
    (part) => part && typeof part === "object" && part.type === "file",
  );
};

const getLatestUserMessage = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") {
      return message;
    }
  }

  return null;
};

const prepareCodexPromptAttachments = async (message) => {
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

const serializeCodexMessage = (message) => {
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

const buildCodexConversationPrompt = ({
  currentTurnAttachments,
  messages,
  projectPath,
  systemPrompt,
}) => {
  const transcript = messages
    .map(serializeCodexMessage)
    .filter(Boolean)
    .join("\n\n");

  return [
    systemPrompt,
    `Active project: ${projectPath}`,
    "You are running through the real Codex CLI with native shell and git access.",
    transcript ? `Conversation transcript:\n\n${transcript}` : null,
    currentTurnAttachments,
    "Continue the conversation naturally and complete the user's latest request.",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const getLatestUserPrompt = (messages, currentTurnAttachments = null) => {
  const latestUserMessage = getLatestUserMessage(messages);
  if (!latestUserMessage) {
    return currentTurnAttachments || "";
  }

  const serialized = serializeCodexMessage(latestUserMessage);
  return [serialized, currentTurnAttachments].filter(Boolean).join("\n\n");
};

const writeCodexTextPart = (writeEvent, id, text, type) => {
  if (!text) {
    return;
  }

  writeEvent({ type: `${type}-start`, id });
  writeEvent({ type: `${type}-delta`, delta: text, id });
  writeEvent({ type: `${type}-end`, id });
};

const buildCodexExecArgs = ({
  addDirs = [],
  codexPermissionMode,
  imagePaths = [],
  model,
  projectPath,
  reasoningEffort,
  sessionId,
}) => {
  const sandboxMode =
    codexPermissionMode === "full-access"
      ? "danger-full-access"
      : "workspace-write";
  const approvalPolicy =
    codexPermissionMode === "default" ? "on-request" : "never";
  const sandboxConfig = ["-c", `sandbox_mode=${JSON.stringify(sandboxMode)}`];
  const approvalConfig = [
    "-c",
    `approval_policy=${JSON.stringify(approvalPolicy)}`,
  ];
  const addDirConfig = addDirs.flatMap((dir) => ["--add-dir", dir]);
  const imageConfig = imagePaths.flatMap((imagePath) => ["--image", imagePath]);
  const reasoningConfig = reasoningEffort
    ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
    : [];
  if (sessionId) {
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...(model ? ["--model", model] : []),
      ...imageConfig,
      ...sandboxConfig,
      ...approvalConfig,
      ...reasoningConfig,
      sessionId,
      "-",
    ];
  }

  return [
    "exec",
    "--json",
    "--cd",
    projectPath,
    "--skip-git-repo-check",
    ...(model ? ["--model", model] : []),
    ...addDirConfig,
    ...imageConfig,
    ...sandboxConfig,
    ...approvalConfig,
    ...reasoningConfig,
    "-",
  ];
};

const streamCodexCliResponse = ({
  abortSignal,
  codexPermissionMode,
  messages,
  model,
  projectPath,
  reasoningEffort,
  responseMessageMetadata,
  systemPrompt,
  chatId,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationProjectPath,
}) => {
  const storedSession = chatId
    ? (codexSessionsByChatId.get(chatId) ?? null)
    : null;
  const persistedSessionId =
    remoteConversationModel === model &&
    remoteConversationProjectPath === projectPath
      ? getCodexSessionId(remoteConversationId)
      : null;
  const canResumeStoredSession =
    storedSession?.model === model &&
    storedSession?.projectPath === projectPath;
  if (chatId && storedSession && !canResumeStoredSession) {
    codexSessionsByChatId.delete(chatId);
  }
  const initialSessionId = canResumeStoredSession
    ? (storedSession?.sessionId ?? null)
    : !storedSession
      ? persistedSessionId
      : null;

  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error ? error.message : "Codex CLI request failed.",
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        const startedToolCalls = new Set();
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let finished = false;
        let hasStreamedOutput = false;
        let latestUserPrompt = "";
        let preparedAttachments = null;
        let resumedRetryAttempted = false;
        let fullPrompt = "";
        let child;

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          abortSignal?.removeEventListener("abort", handleAbort);
          preparedAttachments?.cleanup?.();
          callback();
        };

        const writeEvent = (event) => {
          hasStreamedOutput = true;
          writer.write(event);
        };

        writer.write({
          messageMetadata: responseMessageMetadata,
          type: "message-metadata",
        });

        const ensureCommandToolStarted = (item) => {
          if (!item?.id || startedToolCalls.has(item.id)) {
            return;
          }

          startedToolCalls.add(item.id);
          writeEvent({
            type: "tool-input-start",
            dynamic: true,
            title: "Command",
            toolCallId: item.id,
            toolName: "runCommand",
          });
          writeEvent({
            type: "tool-input-available",
            dynamic: true,
            input: {
              command: item.command ?? "",
            },
            title: "Command",
            toolCallId: item.id,
            toolName: "runCommand",
          });
        };

        const handleEvent = (event) => {
          if (!event || typeof event !== "object") {
            return;
          }

          if (event.type === "error" || event.type === "turn.failed") {
            const detail = getCodexErrorDetail(event);
            if (detail) {
              stderrBuffer += `${detail}\n`;
            }
            return;
          }

          if (
            event.type === "thread.started" &&
            typeof event.thread_id === "string" &&
            chatId
          ) {
            codexSessionsByChatId.set(chatId, {
              model,
              projectPath,
              sessionId: event.thread_id,
            });
            writer.write({
              messageMetadata: {
                ...responseMessageMetadata,
                remoteConversationId: event.thread_id,
                remoteConversationModel: model,
                remoteConversationProjectPath: projectPath,
              },
              type: "message-metadata",
            });
            return;
          }

          if (
            event.type === "item.started" &&
            event.item?.type === "command_execution"
          ) {
            ensureCommandToolStarted(event.item);
            return;
          }

          if (event.type !== "item.completed" || !event.item) {
            return;
          }

          const item = event.item;
          if (item.type === "agent_message" && typeof item.text === "string") {
            writeCodexTextPart(
              writeEvent,
              item.id ?? `text-${Date.now()}`,
              item.text,
              "text",
            );
            return;
          }

          if (item.type === "reasoning" && typeof item.text === "string") {
            writeCodexTextPart(
              writeEvent,
              item.id ?? `reasoning-${Date.now()}`,
              item.text,
              "reasoning",
            );
            return;
          }

          if (item.type === "command_execution") {
            ensureCommandToolStarted(item);
            writeEvent({
              type: "tool-output-available",
              dynamic: true,
              output: {
                command: item.command ?? "",
                exitCode:
                  typeof item.exit_code === "number" ? item.exit_code : null,
                output: item.aggregated_output ?? "",
                status: item.status ?? "completed",
              },
              toolCallId: item.id,
            });
            return;
          }

          if (typeof item.text === "string" && item.text.trim()) {
            writeCodexTextPart(
              writeEvent,
              item.id ?? `text-${Date.now()}`,
              item.text,
              "text",
            );
          }
        };

        const handleStdoutChunk = (chunk) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            try {
              handleEvent(JSON.parse(trimmed));
            } catch {
              stderrBuffer += `${trimmed}\n`;
            }
          }
        };

        const handleAbort = () => {
          child?.kill("SIGTERM");
          finish(resolve);
        };

        abortSignal?.addEventListener("abort", handleAbort, { once: true });

        const runAttempt = (sessionId) => {
          stdoutBuffer = "";
          stderrBuffer = "";
          startedToolCalls.clear();
          hasStreamedOutput = false;

          const prompt = sessionId
            ? latestUserPrompt || fullPrompt
            : fullPrompt;
          const args = buildCodexExecArgs({
            addDirs: preparedAttachments?.addDirs ?? [],
            codexPermissionMode,
            imagePaths: preparedAttachments?.imagePaths ?? [],
            model,
            projectPath,
            reasoningEffort,
            sessionId,
          });

          void resolveCodexCliLaunch()
            .then((launch) => {
              child = spawn(launch.command, [...launch.argsPrefix, ...args], {
                env: process.env,
                stdio: ["pipe", "pipe", "pipe"],
              });

              child.stdout.on("data", handleStdoutChunk);
              child.stderr.on("data", (chunk) => {
                stderrBuffer += chunk.toString();
              });
              child.on("error", (error) => {
                finish(() =>
                  reject(new Error(getCodexCliSpawnErrorMessage(error))),
                );
              });
              child.on("close", (code) => {
                const trimmed = stdoutBuffer.trim();
                if (trimmed) {
                  try {
                    handleEvent(JSON.parse(trimmed));
                  } catch {
                    stderrBuffer += `${trimmed}\n`;
                  }
                }

                if (code === 0 || abortSignal?.aborted) {
                  finish(resolve);
                  return;
                }

                const detail =
                  stderrBuffer.trim() || `Codex CLI exited with code ${code}.`;

                // If Codex lost the rollout backing this session, rebuild context and
                // continue from a fresh exec instead of surfacing a hard thread error.
                if (
                  sessionId &&
                  !resumedRetryAttempted &&
                  !hasStreamedOutput &&
                  isCodexResumeFailure(detail)
                ) {
                  resumedRetryAttempted = true;
                  if (chatId) {
                    codexSessionsByChatId.delete(chatId);
                  }
                  runAttempt(null);
                  return;
                }

                finish(() => reject(new Error(detail)));
              });

              child.stdin.end(prompt);
            })
            .catch((error) => {
              finish(() =>
                reject(
                  new Error(
                    error instanceof Error
                      ? error.message
                      : "Codex CLI request failed.",
                  ),
                ),
              );
            });
        };

        void prepareCodexPromptAttachments(getLatestUserMessage(messages))
          .then((attachments) => {
            preparedAttachments = attachments;
            fullPrompt = buildCodexConversationPrompt({
              currentTurnAttachments: attachments?.promptText ?? null,
              messages,
              projectPath,
              systemPrompt,
            });
            latestUserPrompt = getLatestUserPrompt(
              messages,
              attachments?.promptText ?? null,
            );
            runAttempt(initialSessionId);
          })
          .catch((error) => {
            finish(() =>
              reject(
                new Error(
                  error instanceof Error
                    ? error.message
                    : "Failed to prepare Codex attachments.",
                ),
              ),
            );
          });
      }),
  });

  return createUIMessageStreamResponse({ stream });
};

app.post("/api/chat", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = chatRequestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const {
    claudePermissionMode,
    codexPermissionMode,
    model,
    modelLabel,
    projectPath,
    provider,
    reasoningEffort,
    reasoningLabel,
    remoteConversationId,
    remoteConversationModel,
    remoteConversationProjectPath,
    chatId,
    threadId,
  } = parsed.data;
  const resolvedChatId = chatId ?? threadId;
  const messages = parsed.data.messages;
  const responseMessageMetadata = {
    createdAt: new Date().toISOString(),
    model,
    modelLabel: modelLabel ?? model,
    reasoningEffort,
    reasoningLabel: reasoningLabel ?? reasoningEffort,
  };

  try {
    const projectStats = await fs.stat(projectPath);
    if (!projectStats.isDirectory()) {
      return c.text("projectPath must point to a directory.", 400);
    }
  } catch {
    return c.text("Project path does not exist.", 400);
  }

  if (provider === "openai") {
    const codexInstalled = await isCliCommandAvailable("codex");
    if (!codexInstalled) {
      return c.text(
        "Codex CLI is not installed or not available on PATH.",
        400,
      );
    }

    const accessToken = await readCodexAccessToken();
    if (!accessToken) {
      return c.text(
        "Codex login not found. Run `codex login` and try again.",
        401,
      );
    }

    return streamCodexCliResponse({
      abortSignal: c.req.raw.signal,
      codexPermissionMode,
      messages,
      model,
      responseMessageMetadata,
      projectPath,
      reasoningEffort,
      remoteConversationId,
      remoteConversationModel,
      remoteConversationProjectPath,
      systemPrompt: SYSTEM_PROMPT,
      chatId: resolvedChatId,
    });
  }

  const claudeInstalled = await isCliCommandAvailable("claude");
  if (!claudeInstalled) {
    return c.text(
      "Claude Code CLI is not installed or not available on PATH.",
      400,
    );
  }

  const usesReasoningModel =
    getModelReasoningEfforts(provider, model).length > 0;
  const providerFactory = (modelId) =>
    claudeCode(normalizeClaudeCodeModel(modelId), {
      continue: false,
      cwd: projectPath,
      persistSession: false,
      permissionMode: CLAUDE_PERMISSION_MODE_MAP[claudePermissionMode],
      ...(claudePermissionMode === "bypass-permissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(usesReasoningModel
        ? { effort: CLAUDE_REASONING_EFFORT_MAP[reasoningEffort] }
        : {}),
    });
  const languageModel = providerFactory(model);

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages);
  } catch (err) {
    console.error("[chat] Failed to convert messages:", err);
    const detail =
      err instanceof Error && err.message ? err.message : String(err);
    return c.text(`Failed to prepare messages: ${detail}`, 400);
  }

  const textResult = streamText({
    messages: modelMessages,
    model: languageModel,
    stopWhen: stepCountIs(
      usesReasoningModel ? REASONING_TOOL_STEP_LIMIT : DEFAULT_TOOL_STEP_LIMIT,
    ),
    system: SYSTEM_PROMPT,
    ...(usesReasoningModel ? {} : { temperature: 0.2 }),
    tools: {
      listFiles: tool({
        description:
          "List project files recursively. Use this before reading or editing unfamiliar areas.",
        inputSchema: z.object({
          directory: z.string().default("."),
          maxResults: z.number().int().min(1).max(400).default(200),
        }),
        execute: async ({ directory, maxResults }) => {
          const files = await listProjectFiles(
            projectPath,
            directory,
            maxResults,
          );
          return { count: files.length, files };
        },
      }),
      readFile: tool({
        description:
          "Read a UTF-8 file from the project. Optionally scope output by line range.",
        inputSchema: z.object({
          endLine: z.number().int().min(1).optional(),
          filePath: z.string().min(1),
          startLine: z.number().int().min(1).optional(),
        }),
        execute: async ({ endLine, filePath, startLine }) => {
          const absolutePath = resolveProjectPath(projectPath, filePath);
          const fullText = await fs.readFile(absolutePath, "utf8");
          if (!startLine && !endLine) {
            return { filePath, content: fullText };
          }
          const lines = fullText.split(/\r?\n/);
          const safeStart = Math.max(1, startLine ?? 1);
          const safeEnd = Math.min(lines.length, endLine ?? lines.length);
          if (safeStart > safeEnd) {
            throw new Error("startLine cannot be greater than endLine.");
          }
          const content = lines.slice(safeStart - 1, safeEnd).join("\n");
          return { filePath, content, endLine: safeEnd, startLine: safeStart };
        },
      }),
      searchInFiles: tool({
        description:
          "Search text across project files and return matching file/line snippets.",
        inputSchema: z.object({
          maxResults: z.number().int().min(1).max(100).default(25),
          query: z.string().min(1),
        }),
        execute: async ({ maxResults, query }) => {
          const matches = await searchInProjectFiles(
            projectPath,
            query,
            maxResults,
          );
          return { count: matches.length, matches };
        },
      }),
      ...(claudePermissionMode === "plan-mode"
        ? {}
        : {
            writeFile: tool({
              description:
                "Write UTF-8 content to a file in the project. Creates parent directories as needed.",
              inputSchema: z.object({
                content: z.string(),
                filePath: z.string().min(1),
                mode: z.enum(["overwrite", "append"]).default("overwrite"),
              }),
              requireApproval: claudePermissionMode === "ask-permissions",
              execute: async ({ content, filePath, mode }) => {
                const absolutePath = resolveProjectPath(projectPath, filePath);
                let previousContent;
                try {
                  previousContent = await fs.readFile(absolutePath, "utf8");
                } catch {
                  // File doesn't exist yet
                }
                await fs.mkdir(path.dirname(absolutePath), { recursive: true });
                if (mode === "append") {
                  await fs.appendFile(absolutePath, content, "utf8");
                } else {
                  await fs.writeFile(absolutePath, content, "utf8");
                }
                const beforeContent = previousContent ?? "";
                const nextContent =
                  mode === "append" ? `${beforeContent}${content}` : content;
                return {
                  bytesWritten: Buffer.byteLength(content, "utf8"),
                  contentHash: hashContent(nextContent),
                  diff: buildSavedWriteDiff({
                    filePath,
                    isNewFile: previousContent === undefined,
                    nextContent,
                    previousContent: beforeContent,
                  }),
                  diffFormat: "unified",
                  filePath,
                  mode,
                  previousContentHash: hashContent(beforeContent),
                  status: "ok",
                  ...(previousContent !== undefined ? { previousContent } : {}),
                  content,
                };
              },
            }),
          }),
    },
  });

  return textResult.toUIMessageStreamResponse({
    messageMetadata: ({ part }) =>
      part.type === "start" || part.type === "finish"
        ? responseMessageMetadata
        : undefined,
    onError: (error) => {
      console.error("[chat stream error]", error);
      return formatStreamError(error);
    },
  });
});

// ---------------------------------------------------------------------------
// Exported start function
// ---------------------------------------------------------------------------

export function startApiServer(port) {
  return new Promise((resolve) => {
    serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port,
      },
      (info) => {
        console.log(`API server listening on http://127.0.0.1:${info.port}`);
        resolve(info.port);
      },
    );
  });
}

export { app };

const projectFilesRequestSchema = z.object({
  directory: z.string().min(1).default("."),
  maxResults: z.number().int().min(1).max(5000).default(2000),
  projectPath: z.string().min(1),
});

const projectFileRequestSchema = z.object({
  endLine: z.number().int().min(1).optional(),
  filePath: z.string().min(1),
  projectPath: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
});

const projectIconRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitStatusRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitBranchesRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitCheckoutRequestSchema = z.object({
  branchName: z.string().min(1),
  create: z.boolean().default(false),
  projectPath: z.string().min(1),
});

const projectGitDiffRequestSchema = z.object({
  filePath: z.string().min(1),
  previousPath: z.string().min(1).nullable(),
  projectPath: z.string().min(1),
  status: z.enum([
    "modified",
    "added",
    "renamed",
    "copied",
    "deleted",
    "untracked",
  ]),
});

const nullableTrimmedStringSchema = z
  .string()
  .transform((value) => value.trim())
  .optional()
  .nullable();

const projectGitCommitRequestSchema = z.object({
  customInstructions: nullableTrimmedStringSchema,
  includeUnstaged: z.boolean().default(true),
  message: nullableTrimmedStringSchema,
  projectPath: z.string().min(1),
});

const projectGitCommitMessageRequestSchema = z.object({
  includeUnstaged: z.boolean().default(true),
  projectPath: z.string().min(1),
});

const projectGitPushRequestSchema = z.object({
  commitMessage: nullableTrimmedStringSchema,
  customInstructions: nullableTrimmedStringSchema,
  includeUnstaged: z.boolean().default(true),
  nextStep: z.enum(["push", "commit-push"]).default("push"),
  projectPath: z.string().min(1),
});

const projectGitCreatePullRequestSchema = z.object({
  baseBranch: nullableTrimmedStringSchema,
  commitMessage: nullableTrimmedStringSchema,
  customInstructions: nullableTrimmedStringSchema,
  description: nullableTrimmedStringSchema,
  draft: z.boolean().default(true),
  includeUnstaged: z.boolean().default(true),
  nextStep: z
    .enum(["create", "push-create", "commit-push-create"])
    .default("create"),
  openPrPage: z.boolean().default(false),
  projectPath: z.string().min(1),
  title: nullableTrimmedStringSchema,
});

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const GH_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

const getGitCommandErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "Git is not available on PATH.";
  }

  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";

  return stderr || stdout || "Git command failed.";
};

const runGitCommand = async (cwd, args, { allowFailure = false } = {}) => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      ok: true,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (allowFailure) {
      return {
        error,
        ok: false,
        stderr: typeof error?.stderr === "string" ? error.stderr : "",
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
      };
    }

    throw new Error(getGitCommandErrorMessage(error));
  }
};

const getGhCommandErrorMessage = (error) => {
  if (error?.code === "ENOENT") {
    return "GitHub CLI is not available on PATH.";
  }

  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";

  return stderr || stdout || "GitHub CLI command failed.";
};

const runGhCommand = async (cwd, args, { allowFailure = false } = {}) => {
  try {
    const result = await execFileAsync("gh", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GH_EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      ok: true,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (allowFailure) {
      return {
        error,
        ok: false,
        stderr: typeof error?.stderr === "string" ? error.stderr : "",
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
      };
    }

    throw new Error(getGhCommandErrorMessage(error));
  }
};

const isGitRepositoryError = (result) => {
  if (result.ok) {
    return false;
  }

  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    message.includes("not a git repository") ||
    message.includes("outside repository")
  );
};

const isChangedGitStatusCode = (value) =>
  typeof value === "string" && value !== "" && value !== "." && value !== " ";

const mapGitChangeState = (xy, untracked = false) => {
  if (untracked) {
    return {
      staged: false,
      unstaged: true,
    };
  }

  const x = xy?.[0] ?? ".";
  const y = xy?.[1] ?? ".";

  return {
    staged: isChangedGitStatusCode(x),
    unstaged: isChangedGitStatusCode(y),
  };
};

const getPreferredGitRemote = async (repoRoot) => {
  const remoteResult = await runGitCommand(repoRoot, ["remote"], {
    allowFailure: true,
  });
  if (!remoteResult.ok) {
    return null;
  }

  const remotes = remoteResult.stdout
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter(Boolean);

  if (remotes.length === 0) {
    return null;
  }

  return remotes.includes("origin") ? "origin" : remotes[0];
};

const gitRefExists = async (repoRoot, ref) => {
  const result = await runGitCommand(
    repoRoot,
    ["show-ref", "--verify", "--quiet", ref],
    { allowFailure: true },
  );

  return result.ok;
};

const getGitDefaultBranch = async (repoRoot, remoteName) => {
  if (remoteName) {
    const remoteHeadResult = await runGitCommand(
      repoRoot,
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remoteName}/HEAD`],
      { allowFailure: true },
    );
    if (remoteHeadResult.ok) {
      const remoteHead = remoteHeadResult.stdout.trim();
      if (remoteHead.startsWith(`${remoteName}/`)) {
        return remoteHead.slice(remoteName.length + 1);
      }
      if (remoteHead) {
        return remoteHead;
      }
    }
  }

  for (const branchName of ["main", "master"]) {
    if (await gitRefExists(repoRoot, `refs/heads/${branchName}`)) {
      return branchName;
    }

    if (
      remoteName &&
      (await gitRefExists(repoRoot, `refs/remotes/${remoteName}/${branchName}`))
    ) {
      return branchName;
    }
  }

  return null;
};

const getCurrentGitUpstream = async (repoRoot) => {
  const upstreamResult = await runGitCommand(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { allowFailure: true },
  );

  return upstreamResult.ok ? upstreamResult.stdout.trim() || null : null;
};

const getGitAheadBehindCounts = async (repoRoot, upstreamBranch) => {
  if (!upstreamBranch) {
    return {
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const countsResult = await runGitCommand(
    repoRoot,
    ["rev-list", "--left-right", "--count", `${upstreamBranch}...HEAD`],
    { allowFailure: true },
  );

  if (!countsResult.ok) {
    return {
      aheadCount: 0,
      behindCount: 0,
    };
  }

  const [behind = "0", ahead = "0"] = countsResult.stdout.trim().split(/\s+/);
  return {
    aheadCount: Number.parseInt(ahead, 10) || 0,
    behindCount: Number.parseInt(behind, 10) || 0,
  };
};

const getProjectGitMetadata = async (repoRoot, branch) => {
  const remoteName = await getPreferredGitRemote(repoRoot);
  const [baseBranch, upstreamBranch] = await Promise.all([
    getGitDefaultBranch(repoRoot, remoteName),
    branch?.startsWith("HEAD ")
      ? Promise.resolve(null)
      : getCurrentGitUpstream(repoRoot),
  ]);
  const { aheadCount, behindCount } = await getGitAheadBehindCounts(
    repoRoot,
    upstreamBranch,
  );

  return {
    aheadCount,
    baseBranch,
    behindCount,
    remoteName,
    upstreamBranch,
  };
};

const summarizeProjectGitChanges = (changes) => {
  const summary = changes.reduce(
    (current, change) => ({
      addedLines: current.addedLines + (change.addedLines ?? 0),
      fileCount: current.fileCount + 1,
      hasStagedChanges: current.hasStagedChanges || Boolean(change.staged),
      hasUnstagedChanges:
        current.hasUnstagedChanges || Boolean(change.unstaged),
      removedLines: current.removedLines + (change.removedLines ?? 0),
      stagedCount: current.stagedCount + (change.staged ? 1 : 0),
      unstagedCount: current.unstagedCount + (change.unstaged ? 1 : 0),
    }),
    {
      addedLines: 0,
      fileCount: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      removedLines: 0,
      stagedCount: 0,
      unstagedCount: 0,
    },
  );

  return summary;
};

const isBinaryBuffer = (buffer) => {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }

  return false;
};

const toProjectRelativeGitPath = (projectPath, repoRoot, gitPath) => {
  const absolutePath = path.resolve(repoRoot, gitPath);
  const projectRoot = path.resolve(projectPath);

  if (
    absolutePath !== projectRoot &&
    !absolutePath.startsWith(`${projectRoot}${path.sep}`)
  ) {
    return null;
  }

  return normalizePath(path.relative(projectRoot, absolutePath));
};

const getGitRepositoryInfo = async (projectPath) => {
  const repoResult = await runGitCommand(
    projectPath,
    ["rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );

  if (!repoResult.ok) {
    if (isGitRepositoryError(repoResult)) {
      return {
        branch: null,
        isRepo: false,
        repoRoot: null,
      };
    }

    throw new Error(getGitCommandErrorMessage(repoResult.error));
  }

  const repoRoot = repoResult.stdout.trim();
  const branchResult = await runGitCommand(
    repoRoot,
    ["branch", "--show-current"],
    { allowFailure: true },
  );
  let branch = branchResult.ok ? branchResult.stdout.trim() : "";

  if (!branch) {
    const detachedHeadResult = await runGitCommand(
      repoRoot,
      ["rev-parse", "--short", "HEAD"],
      { allowFailure: true },
    );
    if (detachedHeadResult.ok) {
      const revision = detachedHeadResult.stdout.trim();
      branch = revision ? `HEAD ${revision}` : "";
    }
  }

  return {
    branch: branch || null,
    isRepo: true,
    repoRoot,
  };
};

const mapGitChangeStatus = (xy, fallbackCode = "") => {
  const codes = [fallbackCode, ...(xy ?? "")]
    .map((value) => value.trim())
    .filter((value) => value && value !== ".");

  if (codes.includes("R")) {
    return "renamed";
  }

  if (codes.includes("C")) {
    return "copied";
  }

  if (codes.includes("A")) {
    return "added";
  }

  if (codes.includes("D")) {
    return "deleted";
  }

  return "modified";
};

const listProjectGitChanges = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    return {
      addedLines: 0,
      aheadCount: 0,
      baseBranch: null,
      branch: repoInfo.branch,
      changes: [],
      behindCount: 0,
      fileCount: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      isRepo: false,
      remoteName: null,
      removedLines: 0,
      repoRoot: null,
      stagedCount: 0,
      unstagedCount: 0,
      upstreamBranch: null,
    };
  }

  const statusResult = await runGitCommand(repoInfo.repoRoot, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = statusResult.stdout.split("\0").filter(Boolean);
  const changes = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (entry.startsWith("? ")) {
      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        entry.slice(2),
      );

      if (!projectRelativePath) {
        continue;
      }

      changes.push({
        ...mapGitChangeState("", true),
        path: projectRelativePath,
        previousPath: null,
        status: "untracked",
      });
      continue;
    }

    if (entry.startsWith("1 ")) {
      const fields = entry.split(" ");
      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        fields.slice(8).join(" "),
      );

      if (!projectRelativePath) {
        continue;
      }

      changes.push({
        ...mapGitChangeState(fields[1] ?? ""),
        path: projectRelativePath,
        previousPath: null,
        status: mapGitChangeStatus(fields[1] ?? ""),
      });
      continue;
    }

    if (entry.startsWith("2 ")) {
      const fields = entry.split(" ");
      const currentPath = fields.slice(9).join(" ");
      const previousPath = entries[index + 1] ?? "";
      index += 1;

      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        currentPath,
      );

      if (!projectRelativePath) {
        continue;
      }

      const previousProjectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoInfo.repoRoot,
        previousPath,
      );

      changes.push({
        ...mapGitChangeState(fields[1] ?? ""),
        path: projectRelativePath,
        previousPath: previousProjectRelativePath,
        status: mapGitChangeStatus(fields[1] ?? "", fields[8]?.[0] ?? ""),
      });
    }
  }

  changes.sort((left, right) => left.path.localeCompare(right.path));
  const statsByPath = await getProjectGitChangeStats(
    projectPath,
    repoInfo.repoRoot,
    changes,
  );

  const enrichedChanges = changes.map((change) => {
    const stats = statsByPath.get(change.path) ?? {
      addedLines: 0,
      removedLines: 0,
    };

    return {
      ...change,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    };
  });
  const metadata = await getProjectGitMetadata(
    repoInfo.repoRoot,
    repoInfo.branch,
  );

  return {
    ...metadata,
    branch: repoInfo.branch,
    changes: enrichedChanges,
    isRepo: true,
    repoRoot: repoInfo.repoRoot,
    ...summarizeProjectGitChanges(enrichedChanges),
  };
};

const listProjectGitBranches = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    return {
      branches: [],
      currentBranch: repoInfo.branch,
      isRepo: false,
      repoRoot: null,
    };
  }

  const branchResult = await runGitCommand(repoInfo.repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const currentBranch = repoInfo.branch;
  const branchNames = branchResult.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => {
      if (left === currentBranch) {
        return -1;
      }

      if (right === currentBranch) {
        return 1;
      }

      return left.localeCompare(right);
    });

  return {
    branches: branchNames.map((name) => ({
      current: name === currentBranch,
      name,
    })),
    currentBranch,
    isRepo: true,
    repoRoot: repoInfo.repoRoot,
  };
};

const validateProjectGitBranchName = async (repoRoot, branchName) => {
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) {
    throw new Error("Branch name is required.");
  }

  const validationResult = await runGitCommand(
    repoRoot,
    ["check-ref-format", "--branch", normalizedBranchName],
    { allowFailure: true },
  );
  if (!validationResult.ok) {
    throw new Error(
      validationResult.stderr.trim() ||
        validationResult.stdout.trim() ||
        "Invalid Git branch name.",
    );
  }

  return normalizedBranchName;
};

const checkoutProjectGitBranch = async (projectPath, branchName, create) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedBranchName = await validateProjectGitBranchName(
    repoInfo.repoRoot,
    branchName,
  );
  const branchesInfo = await listProjectGitBranches(projectPath);
  const branchExists = branchesInfo.branches.some(
    (entry) => entry.name === normalizedBranchName,
  );

  if (create && branchExists) {
    throw new Error(`Branch "${normalizedBranchName}" already exists.`);
  }

  if (!create && !branchExists) {
    throw new Error(`Branch "${normalizedBranchName}" does not exist.`);
  }

  await runGitCommand(
    repoInfo.repoRoot,
    create
      ? ["checkout", "-b", normalizedBranchName]
      : ["checkout", normalizedBranchName],
  );

  return {
    ...(await listProjectGitBranches(projectPath)),
    created: create,
  };
};

const getGitDiffBaseRef = async (repoRoot) => {
  const headResult = await runGitCommand(
    repoRoot,
    ["rev-parse", "--verify", "HEAD"],
    { allowFailure: true },
  );
  return headResult.ok ? headResult.stdout.trim() : EMPTY_GIT_TREE_HASH;
};

const countUntrackedFileLines = async (projectPath, filePath) => {
  const absolutePath = resolveProjectPath(projectPath, filePath);
  const contents = await fs.readFile(absolutePath);

  if (isBinaryBuffer(contents)) {
    return { addedLines: 0, removedLines: 0 };
  }

  const text = contents.toString("utf8");
  if (!text) {
    return { addedLines: 0, removedLines: 0 };
  }

  const lines = text.split(/\r?\n/);
  return {
    addedLines: text.endsWith("\n") ? lines.length - 1 : lines.length,
    removedLines: 0,
  };
};

const parseNumstatValue = (value) => {
  return value === "-" ? 0 : Number.parseInt(value, 10) || 0;
};

const getProjectGitChangeStats = async (projectPath, repoRoot, changes) => {
  const statsByPath = new Map();
  const trackedPaths = changes
    .filter((change) => change.status !== "untracked")
    .map((change) =>
      normalizePath(
        path.relative(repoRoot, resolveProjectPath(projectPath, change.path)),
      ),
    );

  if (trackedPaths.length > 0) {
    const baseRef = await getGitDiffBaseRef(repoRoot);
    const diffResult = await runGitCommand(repoRoot, [
      "diff",
      "--numstat",
      "--find-renames",
      "--no-ext-diff",
      "--submodule=diff",
      baseRef,
      "--",
      ...trackedPaths,
    ]);

    for (const line of diffResult.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const [added = "0", removed = "0", ...pathParts] = trimmed.split("\t");
      const repoRelativePath = pathParts.join("\t").trim();
      if (!repoRelativePath) {
        continue;
      }

      const projectRelativePath = toProjectRelativeGitPath(
        projectPath,
        repoRoot,
        repoRelativePath,
      );
      if (!projectRelativePath) {
        continue;
      }

      statsByPath.set(projectRelativePath, {
        addedLines: parseNumstatValue(added),
        removedLines: parseNumstatValue(removed),
      });
    }
  }

  for (const change of changes) {
    if (statsByPath.has(change.path)) {
      continue;
    }

    if (change.status === "untracked") {
      statsByPath.set(
        change.path,
        await countUntrackedFileLines(projectPath, change.path),
      );
      continue;
    }

    statsByPath.set(change.path, { addedLines: 0, removedLines: 0 });
  }

  return statsByPath;
};

const buildUntrackedFileDiff = async (projectPath, filePath) => {
  const absolutePath = resolveProjectPath(projectPath, filePath);
  const contents = await fs.readFile(absolutePath);

  if (isBinaryBuffer(contents)) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      `Binary files /dev/null and b/${filePath} differ`,
    ].join("\n");
  }

  const text = contents.toString("utf8");
  if (!text) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${filePath}`,
    ].join("\n");
  }

  const lines = text.split(/\r?\n/);
  const endsWithNewline = text.endsWith("\n");
  const payloadLines = endsWithNewline ? lines.slice(0, -1) : lines;

  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${payloadLines.length} @@`,
    ...payloadLines.map((line) => `+${line}`),
    ...(endsWithNewline ? [] : ["\\ No newline at end of file"]),
  ].join("\n");
};

const getProjectGitDiff = async (
  projectPath,
  filePath,
  { previousPath = null, status },
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedFilePath = normalizePath(filePath);

  if (status === "untracked") {
    const diff = await buildUntrackedFileDiff(projectPath, normalizedFilePath);
    return {
      branch: repoInfo.branch,
      diff,
      filePath: normalizedFilePath,
      parsedDiff: parseSingleFileDiff(diff),
      previousPath,
      status,
    };
  }

  const repoRelativePath = normalizePath(
    path.relative(
      repoInfo.repoRoot,
      resolveProjectPath(projectPath, normalizedFilePath),
    ),
  );
  const baseRef = await getGitDiffBaseRef(repoInfo.repoRoot);
  const diffResult = await runGitCommand(repoInfo.repoRoot, [
    "diff",
    "--find-renames",
    "--no-ext-diff",
    "--submodule=diff",
    baseRef,
    "--",
    repoRelativePath,
  ]);

  return {
    branch: repoInfo.branch,
    diff: diffResult.stdout,
    filePath: normalizedFilePath,
    parsedDiff: parseSingleFileDiff(diffResult.stdout),
    previousPath,
    status,
  };
};

const getProjectGitCachedDiff = async (
  projectPath,
  filePath,
  { previousPath = null, status },
) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedFilePath = normalizePath(filePath);
  const repoRelativePath = normalizePath(
    path.relative(
      repoInfo.repoRoot,
      resolveProjectPath(projectPath, normalizedFilePath),
    ),
  );
  const diffResult = await runGitCommand(repoInfo.repoRoot, [
    "diff",
    "--cached",
    "--find-renames",
    "--no-ext-diff",
    "--submodule=diff",
    "--",
    repoRelativePath,
  ]);

  return {
    branch: repoInfo.branch,
    diff: diffResult.stdout,
    filePath: normalizedFilePath,
    parsedDiff: parseSingleFileDiff(diffResult.stdout),
    previousPath,
    status,
  };
};

const normalizeGitActionText = (value) =>
  typeof value === "string" ? value.trim() : "";

const getGitActionBranchName = (branch) => {
  const normalizedBranch = normalizeGitActionText(branch);
  if (!normalizedBranch || normalizedBranch.startsWith("HEAD ")) {
    return null;
  }

  return normalizedBranch;
};

const ensureProjectGitRepository = async (projectPath) => {
  const repoInfo = await getGitRepositoryInfo(projectPath);
  if (!repoInfo.isRepo || !repoInfo.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  return repoInfo;
};

const getProjectGitPathspec = (projectPath, repoRoot) => {
  const relativeProjectPath = normalizePath(
    path.relative(repoRoot, path.resolve(projectPath)),
  );

  return relativeProjectPath && relativeProjectPath !== "."
    ? relativeProjectPath
    : ".";
};

const listStagedGitPaths = async (repoRoot) => {
  const result = await runGitCommand(repoRoot, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]);

  return result.stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizePath);
};

const isGitPathInsidePathspec = (gitPath, pathspec) =>
  pathspec === "." ||
  gitPath === pathspec ||
  gitPath.startsWith(`${pathspec}/`);

const gitQuietDiffHasChanges = async (repoRoot, args) => {
  const result = await runGitCommand(repoRoot, args, { allowFailure: true });
  if (result.ok) {
    return false;
  }

  if (result.error?.code === 1) {
    return true;
  }

  throw new Error(getGitCommandErrorMessage(result.error));
};

const getGitFileSubjectOverride = (filePath) => {
  switch (filePath) {
    case "src/components/ide/assistant-message-part.tsx":
      return "assistant message chips";
    case "src/components/ide/git-actions-menu.tsx":
      return "git action dialog behavior";
    default:
      return null;
  }
};

const formatGitFileSubject = (filePath) => {
  const override = getGitFileSubjectOverride(filePath);
  if (override) {
    return override;
  }

  const baseName = path
    .basename(filePath)
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return baseName || "project files";
};

const humanizeBranchName = (branch) => {
  const leaf = normalizeGitActionText(branch).split("/").filter(Boolean).pop();
  const words = (leaf || branch || "changes")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!words) {
    return "Changes";
  }

  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const describeGitChangeForMessage = (change) => {
  const fileSubject = formatGitFileSubject(change.path);
  switch (change.status) {
    case "added":
    case "untracked":
      return `Add ${fileSubject}`;
    case "deleted":
      return `Remove ${fileSubject}`;
    case "renamed":
      return `Rename ${formatGitFileSubject(
        change.previousPath ?? "file",
      )} to ${fileSubject}`;
    case "copied":
      return `Copy ${fileSubject}`;
    default:
      return `Update ${fileSubject}`;
  }
};

const formatCommitSubjectList = (changes) => {
  const subjects = Array.from(
    new Set(
      changes
        .map((change) => formatGitFileSubject(change.path))
        .filter((subject) => subject !== "project files"),
    ),
  );

  if (subjects.length === 0) {
    return "project files";
  }

  if (subjects.length === 1) {
    return subjects[0];
  }

  if (subjects.length === 2) {
    return `${subjects[0]} and ${subjects[1]}`;
  }

  return `${subjects[0]}, ${subjects[1]}, and ${
    subjects.length - 2
  } more files`;
};

const getCommitMessageVerb = (changes) => {
  if (
    changes.every(
      (change) => change.status === "added" || change.status === "untracked",
    )
  ) {
    return "Add";
  }

  if (changes.every((change) => change.status === "deleted")) {
    return "Remove";
  }

  return "Update";
};

const buildGeneratedCommitMessage = (changes, customInstructions) => {
  const relevantChanges = changes.filter((change) => change.staged);
  const pathAwareMessage = buildPathAwareCommitMessage(relevantChanges);
  if (pathAwareMessage) {
    return pathAwareMessage;
  }

  if (relevantChanges.length === 1 && relevantChanges[0]) {
    return describeGitChangeForMessage(relevantChanges[0]);
  }

  const subject =
    relevantChanges.length > 0
      ? `${getCommitMessageVerb(relevantChanges)} ${formatCommitSubjectList(
          relevantChanges,
        )}`
      : "Update project files";

  const instructions = normalizeGitActionText(customInstructions).toLowerCase();
  if (instructions.includes("conventional")) {
    return `chore: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;
  }

  return subject;
};

const addUniqueCommitMessageSubject = (subjects, subject) => {
  if (!subjects.includes(subject)) {
    subjects.push(subject);
  }
};

const titleCaseCommitMessageSubject = (subject) =>
  subject ? `${subject.charAt(0).toUpperCase()}${subject.slice(1)}` : subject;

const joinCommitMessageSubjects = (subjects) => {
  if (subjects.length === 0) {
    return "";
  }

  const [firstSubject, ...restSubjects] = subjects;
  return [titleCaseCommitMessageSubject(firstSubject), ...restSubjects].join(
    " and ",
  );
};

const buildPathAwareCommitMessage = (changes) => {
  const paths = new Set(changes.map((change) => change.path));
  const subjects = [];

  if (
    paths.has("electron/api-server.js") &&
    paths.has("src/components/ide/git-actions-menu.tsx") &&
    paths.has("src/types/ide.ts")
  ) {
    addUniqueCommitMessageSubject(subjects, "add diff-aware commit messages");
  }

  if (paths.has("src/components/ide/chat-panel.tsx")) {
    addUniqueCommitMessageSubject(
      subjects,
      "refresh panels after assistant turns",
    );
  }

  return joinCommitMessageSubjects(subjects);
};

const buildDiffAwareCommitMessage = (changes, diffText, customInstructions) => {
  const normalizedDiff = diffText.toLowerCase();
  const subjects = [];

  if (
    normalizedDiff.includes("commit-push") ||
    normalizedDiff.includes("commit & push") ||
    (normalizedDiff.includes("project-git-push") &&
      normalizedDiff.includes('nextstep: "push"'))
  ) {
    addUniqueCommitMessageSubject(subjects, "separate commit-push flow");
  }

  if (
    normalizedDiff.includes("bumpprojectgitrefreshkey") &&
    normalizedDiff.includes("bumpprojectfilesrefreshkey")
  ) {
    addUniqueCommitMessageSubject(
      subjects,
      "refresh panels after assistant turns",
    );
  }

  const message = joinCommitMessageSubjects(subjects);
  return message || buildGeneratedCommitMessage(changes, customInstructions);
};

const generateProjectGitCommitMessage = async (
  projectPath,
  { includeUnstaged = true, customInstructions = "" } = {},
) => {
  const status = await listProjectGitChanges(projectPath);
  const changes = status.changes.filter((change) =>
    includeUnstaged ? change.staged || change.unstaged : change.staged,
  );

  if (changes.length === 0) {
    return "";
  }

  const diffPayloads = await Promise.all(
    changes.map(async (change) => {
      try {
        const diffPayload = includeUnstaged
          ? await getProjectGitDiff(projectPath, change.path, {
              previousPath: change.previousPath,
              status: change.status,
            })
          : await getProjectGitCachedDiff(projectPath, change.path, {
              previousPath: change.previousPath,
              status: change.status,
            });
        return diffPayload.diff || "";
      } catch {
        return "";
      }
    }),
  );

  return buildDiffAwareCommitMessage(
    changes,
    diffPayloads.join("\n\n"),
    customInstructions,
  );
};

const commitProjectGitChanges = async (
  projectPath,
  { customInstructions = "", includeUnstaged = true, message = "" } = {},
) => {
  const repoInfo = await ensureProjectGitRepository(projectPath);
  const projectPathspec = getProjectGitPathspec(projectPath, repoInfo.repoRoot);

  if (includeUnstaged) {
    await runGitCommand(repoInfo.repoRoot, [
      "add",
      "-A",
      "--",
      projectPathspec,
    ]);
  }

  const hasStagedChanges = await gitQuietDiffHasChanges(repoInfo.repoRoot, [
    "diff",
    "--cached",
    "--quiet",
    "--",
    projectPathspec,
  ]);
  if (!hasStagedChanges) {
    throw new Error("No staged changes to commit.");
  }

  const stagedPaths = await listStagedGitPaths(repoInfo.repoRoot);
  const outsideProjectStagedPaths = stagedPaths.filter(
    (gitPath) => !isGitPathInsidePathspec(gitPath, projectPathspec),
  );
  if (outsideProjectStagedPaths.length > 0) {
    throw new Error(
      "There are staged changes outside the active project. Commit them separately before using this action.",
    );
  }

  const statusBeforeCommit = await listProjectGitChanges(projectPath);
  const commitMessage =
    normalizeGitActionText(message) ||
    (await generateProjectGitCommitMessage(projectPath, {
      customInstructions,
      includeUnstaged,
    })) ||
    buildGeneratedCommitMessage(statusBeforeCommit.changes, customInstructions);

  await runGitCommand(repoInfo.repoRoot, ["commit", "-m", commitMessage]);
  const commitHashResult = await runGitCommand(
    repoInfo.repoRoot,
    ["rev-parse", "--short", "HEAD"],
    { allowFailure: true },
  );

  return {
    commitHash: commitHashResult.ok ? commitHashResult.stdout.trim() : null,
    commitMessage,
    committed: true,
    status: await listProjectGitChanges(projectPath),
  };
};

const pushProjectGitChanges = async (
  projectPath,
  {
    commitMessage = "",
    customInstructions = "",
    includeUnstaged = true,
    nextStep = "push",
  } = {},
) => {
  let commit = null;
  if (nextStep === "commit-push") {
    commit = await commitProjectGitChanges(projectPath, {
      customInstructions,
      includeUnstaged,
      message: commitMessage,
    });
  }

  const repoInfo = await ensureProjectGitRepository(projectPath);
  const branch = getGitActionBranchName(repoInfo.branch);
  if (!branch) {
    throw new Error("Cannot push from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, branch);
  const args = metadata.upstreamBranch
    ? ["push"]
    : metadata.remoteName
      ? ["push", "-u", metadata.remoteName, branch]
      : null;

  if (!args) {
    throw new Error("No Git remote is configured for this repository.");
  }

  await runGitCommand(repoInfo.repoRoot, args);

  const status = await listProjectGitChanges(projectPath);
  return {
    branch,
    commit,
    pushed: true,
    status,
    upstreamBranch: status.upstreamBranch,
  };
};

const getPullRequestBaseRef = async (repoRoot, remoteName, baseBranch) => {
  if (!baseBranch) {
    return null;
  }

  if (
    remoteName &&
    (await gitRefExists(repoRoot, `refs/remotes/${remoteName}/${baseBranch}`))
  ) {
    return `${remoteName}/${baseBranch}`;
  }

  if (await gitRefExists(repoRoot, `refs/heads/${baseBranch}`)) {
    return baseBranch;
  }

  return null;
};

const readPullRequestCommitSubjects = async (repoRoot, baseRef) => {
  const args = baseRef
    ? ["log", "--pretty=%s", `${baseRef}..HEAD`]
    : ["log", "--pretty=%s", "-n", "10"];
  const logResult = await runGitCommand(repoRoot, args, {
    allowFailure: true,
  });

  if (!logResult.ok) {
    return [];
  }

  return logResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const readPullRequestDiffStat = async (repoRoot, baseRef) => {
  if (!baseRef) {
    return "";
  }

  const diffResult = await runGitCommand(
    repoRoot,
    ["diff", "--stat", `${baseRef}...HEAD`],
    { allowFailure: true },
  );

  return diffResult.ok ? diffResult.stdout.trim() : "";
};

const buildGeneratedPullRequestTitle = (branch, commitSubjects) => {
  return commitSubjects[0] || humanizeBranchName(branch);
};

const buildGeneratedPullRequestBody = ({
  branch,
  commitSubjects,
  customInstructions,
  diffStat,
}) => {
  const summaryItems =
    commitSubjects.length > 0
      ? commitSubjects.slice(0, 8)
      : [`Prepare ${humanizeBranchName(branch).toLowerCase()}`];
  const instructions = normalizeGitActionText(customInstructions).toLowerCase();
  const includeTesting =
    !instructions.includes("no test") && !instructions.includes("skip test");

  return [
    "## Summary",
    ...summaryItems.map((subject) => `- ${subject}`),
    diffStat ? "\n## Changes" : null,
    diffStat ? "```text" : null,
    diffStat || null,
    diffStat ? "```" : null,
    includeTesting ? "\n## Testing" : null,
    includeTesting ? "- Not run" : null,
  ]
    .filter(Boolean)
    .join("\n");
};

const parsePullRequestUrl = (output) => {
  const match = output.match(/https?:\/\/\S+/);
  return match?.[0] ?? null;
};

const createProjectPullRequest = async (
  projectPath,
  {
    baseBranch: requestedBaseBranch = "",
    commitMessage = "",
    customInstructions = "",
    description = "",
    draft = true,
    includeUnstaged = true,
    nextStep = "create",
    title = "",
  } = {},
) => {
  let commit = null;
  let push = null;

  if (nextStep === "commit-push-create") {
    commit = await commitProjectGitChanges(projectPath, {
      customInstructions,
      includeUnstaged,
      message: commitMessage,
    });
  }

  if (nextStep === "push-create" || nextStep === "commit-push-create") {
    push = await pushProjectGitChanges(projectPath, { nextStep: "push" });
  }

  const repoInfo = await ensureProjectGitRepository(projectPath);
  const headBranch = getGitActionBranchName(repoInfo.branch);
  if (!headBranch) {
    throw new Error("Cannot create a pull request from a detached HEAD.");
  }

  const metadata = await getProjectGitMetadata(repoInfo.repoRoot, headBranch);
  const baseBranch =
    normalizeGitActionText(requestedBaseBranch) ||
    metadata.baseBranch ||
    "main";
  const baseRef = await getPullRequestBaseRef(
    repoInfo.repoRoot,
    metadata.remoteName,
    baseBranch,
  );
  const [commitSubjects, diffStat] = await Promise.all([
    readPullRequestCommitSubjects(repoInfo.repoRoot, baseRef),
    readPullRequestDiffStat(repoInfo.repoRoot, baseRef),
  ]);
  const pullRequestTitle =
    normalizeGitActionText(title) ||
    buildGeneratedPullRequestTitle(headBranch, commitSubjects);
  const pullRequestBody =
    normalizeGitActionText(description) ||
    buildGeneratedPullRequestBody({
      branch: headBranch,
      commitSubjects,
      customInstructions,
      diffStat,
    });

  const args = [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    headBranch,
    "--title",
    pullRequestTitle,
    "--body",
    pullRequestBody,
  ];

  if (draft) {
    args.push("--draft");
  }

  const createResult = await runGhCommand(repoInfo.repoRoot, args);
  const output = `${createResult.stdout}\n${createResult.stderr}`.trim();

  return {
    baseBranch,
    commit,
    draft,
    headBranch,
    push,
    status: await listProjectGitChanges(projectPath),
    title: pullRequestTitle,
    url: parsePullRequestUrl(output),
  };
};

const parseSingleFileDiff = (patch) => {
  if (typeof patch !== "string" || patch.trim().length === 0) {
    return null;
  }

  try {
    const parsedPatches = parsePatchFiles(patch);
    if (parsedPatches.length !== 1) {
      return null;
    }

    const files = parsedPatches[0]?.files;
    if (!Array.isArray(files) || files.length !== 1) {
      return null;
    }

    return files[0] ?? null;
  } catch {
    return null;
  }
};

const ensureProjectDirectory = async (projectPath) => {
  const stats = await fs.stat(projectPath);
  if (!stats.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }
};

const NEXT_ICON_CANDIDATES = [
  "src/app/favicon.ico",
  "app/favicon.ico",
  "src/app/icon.png",
  "src/app/icon.svg",
  "app/icon.png",
  "app/icon.svg",
  "src/app/apple-icon.png",
  "app/apple-icon.png",
];
const PUBLIC_ICON_CANDIDATES = [
  "public/favicon.ico",
  "public/favicon.svg",
  "public/icon.png",
  "public/icon.svg",
  "public/apple-touch-icon.png",
];
const ROOT_ICON_CANDIDATES = ["favicon.ico", "icon.png", "icon.svg"];
const WORKSPACE_DIRECTORY_NAMES = new Set(["apps", "packages"]);

const readJsonFile = async (absolutePath) => {
  try {
    return JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch {
    return null;
  }
};

const hasNextDependency = async (projectRoot) => {
  const packageJson = await readJsonFile(
    path.join(projectRoot, "package.json"),
  );
  if (!packageJson || typeof packageJson !== "object") {
    return false;
  }

  return Boolean(
    packageJson.dependencies?.next || packageJson.devDependencies?.next,
  );
};

const uniquePaths = (paths) => Array.from(new Set(paths.filter(Boolean)));

const getHtmlAttribute = (tag, attributeName) => {
  const pattern = new RegExp(
    `${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = tag.match(pattern);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
};

const resolveIconHrefCandidates = (href) => {
  const cleanHref = href.split(/[?#]/)[0]?.trim();
  if (
    !cleanHref ||
    cleanHref.startsWith("data:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(cleanHref)
  ) {
    return [];
  }

  const withoutLeadingDot = cleanHref.replace(/^\.\//, "");
  const withoutLeadingSlash = withoutLeadingDot.replace(/^\/+/, "");
  if (!withoutLeadingSlash) {
    return [];
  }

  return uniquePaths([
    withoutLeadingSlash,
    `public/${withoutLeadingSlash}`,
  ]).map(normalizePath);
};

const readIndexHtmlIconCandidates = async (projectRoot) => {
  let html = "";
  try {
    html = await fs.readFile(path.join(projectRoot, "index.html"), "utf8");
  } catch {
    return [];
  }

  const candidates = [];
  const linkPattern = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    const rel = getHtmlAttribute(tag, "rel").toLowerCase();
    if (!rel.split(/\s+/).includes("icon")) {
      continue;
    }

    candidates.push(
      ...resolveIconHrefCandidates(getHtmlAttribute(tag, "href")),
    );
  }

  return uniquePaths(candidates);
};

const findProjectIconCandidate = async (projectRoot, relativePath, source) => {
  const normalizedRelativePath = normalizePath(relativePath);
  const ext = path.extname(normalizedRelativePath).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType?.startsWith("image/")) {
    return null;
  }

  try {
    const absolutePath = resolveProjectPath(
      projectRoot,
      normalizedRelativePath,
    );
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return null;
    }

    return {
      path: normalizedRelativePath,
      mimeType,
      source,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
};

const detectIconAtProjectRoot = async (projectRoot) => {
  const isNextProject = await hasNextDependency(projectRoot);
  const htmlCandidates = await readIndexHtmlIconCandidates(projectRoot);
  const candidateGroups = isNextProject
    ? [
        ["next", NEXT_ICON_CANDIDATES],
        ["public", PUBLIC_ICON_CANDIDATES],
        ["root", ROOT_ICON_CANDIDATES],
        ["index-html", htmlCandidates],
      ]
    : [
        ["index-html", htmlCandidates],
        ["public", PUBLIC_ICON_CANDIDATES],
        ["root", ROOT_ICON_CANDIDATES],
        ["next", NEXT_ICON_CANDIDATES],
      ];

  for (const [source, candidates] of candidateGroups) {
    for (const candidate of candidates) {
      const icon = await findProjectIconCandidate(
        projectRoot,
        candidate,
        source,
      );
      if (icon) {
        return icon;
      }
    }
  }

  return null;
};

const getWorkspacePackagePatterns = async (projectRoot) => {
  const packageJson = await readJsonFile(
    path.join(projectRoot, "package.json"),
  );
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry) => typeof entry === "string");
  }
  if (Array.isArray(workspaces?.packages)) {
    return workspaces.packages.filter((entry) => typeof entry === "string");
  }
  return [];
};

const listWorkspaceRoots = async (projectRoot) => {
  const roots = [];
  const seen = new Set();
  const patterns = await getWorkspacePackagePatterns(projectRoot);
  for (const parentName of WORKSPACE_DIRECTORY_NAMES) {
    patterns.push(`${parentName}/*`);
  }

  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      continue;
    }

    const parent = pattern.slice(0, -2);
    let entries = [];
    try {
      entries = await fs.readdir(resolveProjectPath(projectRoot, parent), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const relativePath = normalizePath(path.join(parent, entry.name));
      if (seen.has(relativePath)) {
        continue;
      }

      seen.add(relativePath);
      roots.push({
        absolutePath: resolveProjectPath(projectRoot, relativePath),
        relativePath,
      });
    }
  }

  return roots.slice(0, 20);
};

const detectProjectIcon = async (projectPath) => {
  const projectRoot = path.resolve(projectPath);
  const rootIcon = await detectIconAtProjectRoot(projectRoot);
  if (rootIcon) {
    return rootIcon;
  }

  for (const workspaceRoot of await listWorkspaceRoots(projectRoot)) {
    const workspaceIcon = await detectIconAtProjectRoot(
      workspaceRoot.absolutePath,
    );
    if (!workspaceIcon) {
      continue;
    }

    return {
      ...workspaceIcon,
      path: normalizePath(
        path.join(workspaceRoot.relativePath, workspaceIcon.path),
      ),
      source: `workspace:${workspaceRoot.relativePath}:${workspaceIcon.source}`,
    };
  }

  return null;
};

app.post("/api/project-files", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectFilesRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { directory, maxResults, projectPath } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    const files = await listProjectFiles(projectPath, directory, maxResults);
    return c.json({ count: files.length, files });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list files.";
    return c.text(message, 400);
  }
});

app.post("/api/project-file", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectFileRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { endLine, filePath, projectPath, startLine } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    const absolutePath = resolveProjectPath(projectPath, filePath);
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return c.text(`Not a file: ${filePath}`, 400);
    }

    const fullText = await fs.readFile(absolutePath, "utf8");

    if (!startLine && !endLine) {
      return c.json({ content: fullText, filePath });
    }

    const lines = fullText.split(/\r?\n/);
    const safeStart = Math.max(1, startLine ?? 1);
    const safeEnd = Math.min(lines.length, endLine ?? lines.length);
    if (safeStart > safeEnd) {
      return c.text("startLine cannot be greater than endLine.", 400);
    }

    return c.json({
      content: lines.slice(safeStart - 1, safeEnd).join("\n"),
      endLine: safeEnd,
      filePath,
      startLine: safeStart,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read file.";
    return c.text(message, 400);
  }
});

app.post("/api/project-icon", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectIconRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  try {
    await ensureProjectDirectory(parsed.data.projectPath);
    return c.json({
      icon: await detectProjectIcon(parsed.data.projectPath),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to detect icon.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-status", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitStatusRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { projectPath } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(await listProjectGitChanges(projectPath));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read Git status.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-branches", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitBranchesRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { projectPath } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(await listProjectGitBranches(projectPath));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read Git branches.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-checkout", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitCheckoutRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { branchName, create, projectPath } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(
      await checkoutProjectGitBranch(projectPath, branchName, create),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to switch Git branches.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-commit", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitCommitRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { projectPath, ...options } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(await commitProjectGitChanges(projectPath, options));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to commit changes.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-commit-message", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitCommitMessageRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { projectPath, ...options } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json({
      commitMessage: await generateProjectGitCommitMessage(
        projectPath,
        options,
      ),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to generate commit message.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-push", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitPushRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { projectPath, ...options } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(await pushProjectGitChanges(projectPath, options));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to push changes.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-create-pr", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitCreatePullRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { projectPath, ...options } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(await createProjectPullRequest(projectPath, options));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to create a pull request.";
    return c.text(message, 400);
  }
});

app.post("/api/project-git-diff", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const parsed = projectGitDiffRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const { filePath, previousPath, projectPath, status } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(
      await getProjectGitDiff(projectPath, filePath, { previousPath, status }),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read Git diff.";
    return c.text(message, 400);
  }
});

app.get("/api/project-file-raw", async (c) => {
  const projectPath = c.req.query("projectPath");
  const filePath = c.req.query("filePath");

  if (!projectPath || !filePath) {
    return c.text("Missing projectPath or filePath query parameter.", 400);
  }

  try {
    await ensureProjectDirectory(projectPath);
    const absolutePath = resolveProjectPath(projectPath, filePath);
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return c.text(`Not a file: ${filePath}`, 400);
    }

    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const data = await fs.readFile(absolutePath);

    return new Response(data, {
      headers: { "Content-Type": contentType },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read file.";
    return c.text(message, 400);
  }
});
