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
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { serve } from "@hono/node-server";
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

// ---------------------------------------------------------------------------
// Anthropic OAuth helpers (was src/lib/anthropic-oauth.ts)
// ---------------------------------------------------------------------------

const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_REDIRECT_URI =
  "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
const ANTHROPIC_OAUTH_TOKEN_URL =
  "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_OAUTH_REQUIRED_BETA_HEADER =
  "oauth-2025-04-20,interleaved-thinking-2025-05-14";
const execFileAsync = promisify(execFile);

const toBase64Url = (input) => {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const generateAnthropicPkceVerifier = () => {
  return toBase64Url(randomBytes(48));
};

const getPkceChallenge = (verifier) => {
  return toBase64Url(createHash("sha256").update(verifier).digest());
};

const createAnthropicAuthorizationUrl = (mode, verifier) => {
  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", getPkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);
  return url.toString();
};

const parseAnthropicCode = (codeInput) => {
  const [code = "", state] = codeInput.trim().split("#");
  return { code, state };
};

const parseOAuthTokenResponse = async (response) => {
  if (!response.ok) {
    throw new Error(`Anthropic OAuth request failed (${response.status}).`);
  }

  const payload = await response.json();
  const accessToken = payload.access_token?.trim() ?? "";
  const refreshToken = payload.refresh_token?.trim() ?? "";
  const expiresIn = payload.expires_in ?? 0;

  if (!accessToken || !refreshToken || !expiresIn) {
    throw new Error(
      "Anthropic OAuth response is missing required token fields.",
    );
  }

  return {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken,
  };
};

const exchangeAnthropicAuthorizationCode = async (codeInput, verifier) => {
  const { code, state } = parseAnthropicCode(codeInput);
  if (!code) {
    throw new Error("Authorization code is required.");
  }

  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    body: JSON.stringify({
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
      state,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  return parseOAuthTokenResponse(response);
};

const refreshAnthropicAccessToken = async (refreshToken) => {
  const token = refreshToken.trim();
  if (!token) {
    throw new Error("Refresh token is required.");
  }

  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    body: JSON.stringify({
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: token,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  return parseOAuthTokenResponse(response);
};

// ---------------------------------------------------------------------------
// Codex Auth helpers (was src/lib/codex-auth.ts)
// ---------------------------------------------------------------------------

const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");

const readCodexAuthFile = async () => {
  try {
    const contents = await fs.readFile(CODEX_AUTH_FILE, "utf8");
    return JSON.parse(contents);
  } catch {
    return null;
  }
};

const readCodexCredential = async () => {
  const authData = await readCodexAuthFile();

  if (!authData) {
    return { authMode: "unknown", credential: null, source: "none" };
  }

  const authMode = authData.auth_mode ?? "unknown";
  const accessToken = authData.tokens?.access_token?.trim();

  if (accessToken) {
    return { authMode, credential: accessToken, source: "chatgpt" };
  }

  const apiKey = authData.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return { authMode, credential: apiKey, source: "apiKey" };
  }

  return { authMode, credential: null, source: "none" };
};

const getCodexAuthStatus = async () => {
  const credential = await readCodexCredential();

  if (!credential.credential) {
    return {
      authMode: credential.authMode,
      loggedIn: false,
      message:
        credential.authMode === "unknown"
          ? "Not logged in. Run `codex login` in your terminal."
          : "Codex auth file found, but no usable credential is available.",
    };
  }

  return {
    authMode: credential.authMode,
    loggedIn: true,
    message:
      credential.source === "chatgpt"
        ? `Logged in with ChatGPT via Codex (${credential.authMode}).`
        : `Logged in with API key via Codex (${credential.authMode}).`,
  };
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
    return isReasoning ? ["low", "medium", "high"] : [];
  }

  if (provider === "anthropic") {
    if (["opus", "sonnet", "haiku"].includes(id)) {
      return ["low", "medium", "high"];
    }
    const newFormat = id.match(/^claude-(?:sonnet|opus|haiku)-(\d+)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) return ["low", "medium", "high"];
    }
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7)) {
        return ["low", "medium", "high"];
      }
    }
    if (/^claude-(\d+)(?!\d)/.test(id)) {
      const majorOnly = Number(id.match(/^claude-(\d+)/)?.[1]);
      if (majorOnly >= 4) return ["low", "medium", "high"];
    }
    return [];
  }

  if (provider === "gemini") {
    return id.includes("thinking") ? ["low", "medium", "high"] : [];
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

const GEMINI_TOKEN_LABELS = {
  exp: "Experimental",
  flash: "Flash",
  gemini: "Gemini",
  lite: "Lite",
  preview: "Preview",
  pro: "Pro",
  thinking: "Thinking",
};

const formatToken = (provider, token, isFirstToken) => {
  if (!token) return "";
  if (/^\d+(\.\d+)*$/.test(token)) return token;
  if (/^o\d/i.test(token)) return token.toLowerCase();
  const labels =
    provider === "openai"
      ? OPENAI_TOKEN_LABELS
      : provider === "anthropic"
        ? ANTHROPIC_TOKEN_LABELS
        : GEMINI_TOKEN_LABELS;
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
  if (provider === "gemini" && parts[0]?.toLowerCase() === "gemini") {
    const rest = parts
      .slice(1)
      .map((p, i) => formatToken(provider, p, i === 0))
      .join(" ");
    return rest ? `Gemini ${rest}` : "Gemini";
  }
  return parts.map((p, i) => formatToken(provider, p, i === 0)).join(" ");
};

const createModelOption = (provider, id, label) => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  return {
    id: trimmedId,
    label: trimmedLabel || formatModelIdLabel(provider, trimmedId),
  };
};

const dedupeModelOptions = (models) => {
  const seen = new Map();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const label = model.label.trim() || id;
    if (!seen.has(id)) seen.set(id, { id, label });
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

app.get("/api/codex-auth", async (c) => {
  const status = await getCodexAuthStatus();
  return c.json(status);
});

app.post("/api/anthropic-oauth/authorize", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const requestBodySchema = z.object({
    mode: z.enum(["max", "console"]).default("max"),
  });
  const parsed = requestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const mode = parsed.data.mode;
  const verifier = generateAnthropicPkceVerifier();
  const url = createAnthropicAuthorizationUrl(mode, verifier);

  return c.json({ url, verifier });
});

app.post("/api/anthropic-oauth/exchange", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const requestBodySchema = z.object({
    code: z.string().min(1),
    verifier: z.string().min(1),
  });
  const parsed = requestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  try {
    const tokens = await exchangeAnthropicAuthorizationCode(
      parsed.data.code,
      parsed.data.verifier,
    );
    return c.json(tokens);
  } catch (error) {
    return c.text(
      error instanceof Error
        ? error.message
        : "Unable to exchange Anthropic authorization code.",
      400,
    );
  }
});

app.post("/api/anthropic-oauth/refresh", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const requestBodySchema = z.object({
    refreshToken: z.string().min(1),
  });
  const parsed = requestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  try {
    const tokens = await refreshAnthropicAccessToken(parsed.data.refreshToken);
    return c.json(tokens);
  } catch (error) {
    return c.text(
      error instanceof Error
        ? error.message
        : "Unable to refresh Anthropic access token.",
      400,
    );
  }
});

// ── /api/provider-models ─────────────────────────────────────────────────────

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENAI_CODEX_CHATGPT_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const CODEX_CLIENT_VERSION = "1.0.0";

const dedupeAndSort = (models) => {
  return dedupeModelOptions(models)
    .sort((a, b) => a.id.localeCompare(b.id))
    .reverse();
};

const isOpenAiChatModel = (model) => {
  return model.startsWith("gpt-") || /^o\d/.test(model);
};

const fetchOpenAiModelsWithApiKey = async (apiKey) => {
  const response = await fetch(OPENAI_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}).`);
  }
  const payload = await response.json();
  const modelIds = (payload.data ?? []).flatMap((entry) => {
    const id = entry.id?.trim() ?? "";
    return id ? [id] : [];
  });
  const chatModels = modelIds.filter((model) => isOpenAiChatModel(model));
  return dedupeAndSort(
    (chatModels.length > 0 ? chatModels : modelIds).map((id) =>
      createModelOption("openai", id),
    ),
  );
};

const fetchOpenAiModelsWithCodexChatgpt = async (accessToken) => {
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
    return [createModelOption("openai", id)];
  });
  return dedupeAndSort(modelIds);
};

const fetchOpenAiModels = async (authMode, openAiApiKey) => {
  if (authMode === "apiKey") {
    if (!openAiApiKey) {
      return {
        error: "Add an OpenAI API key to fetch the latest model list.",
        models: [],
        source: "unavailable",
      };
    }
    try {
      const models = await fetchOpenAiModelsWithApiKey(openAiApiKey);
      if (models.length === 0) {
        return {
          error: "OpenAI returned no models.",
          models: [],
          source: "unavailable",
        };
      }
      return { models, source: "api" };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch OpenAI models.",
        models: [],
        source: "unavailable",
      };
    }
  }

  const codexCredential = await readCodexCredential();
  if (!codexCredential.credential) {
    return {
      error: "Run `codex login` to fetch Codex models.",
      models: [],
      source: "unavailable",
    };
  }

  if (codexCredential.source === "chatgpt") {
    try {
      const models = await fetchOpenAiModelsWithCodexChatgpt(
        codexCredential.credential,
      );
      if (models.length === 0) {
        return {
          error: "Codex returned no models.",
          models: [],
          source: "unavailable",
        };
      }
      return { models, source: "api" };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch Codex models.",
        models: [],
        source: "unavailable",
      };
    }
  }

  try {
    const models = await fetchOpenAiModelsWithApiKey(
      codexCredential.credential,
    );
    if (models.length === 0) {
      return {
        error: "OpenAI returned no models.",
        models: [],
        source: "unavailable",
      };
    }
    return { models, source: "api" };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch OpenAI models.",
      models: [],
      source: "unavailable",
    };
  }
};

const isAnthropicTokenExpired = (expiresAt) => {
  if (typeof expiresAt !== "number") return true;
  return expiresAt <= Date.now() + 15_000;
};

const _fetchAnthropicModelsWithOAuth = async (oauthInput) => {
  const refreshToken = oauthInput.refreshToken.trim();
  if (!refreshToken) {
    return {
      error: "Log in with Claude Pro/Max before fetching models.",
      models: [],
      source: "unavailable",
    };
  }

  let tokens = {
    accessToken: oauthInput.accessToken.trim(),
    expiresAt: oauthInput.expiresAt,
    refreshToken,
  };

  try {
    if (!tokens.accessToken || isAnthropicTokenExpired(tokens.expiresAt)) {
      const refreshed = await refreshAnthropicAccessToken(tokens.refreshToken);
      tokens = {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        refreshToken: refreshed.refreshToken,
      };
    }

    const requestModels = async (accessToken) => {
      const response = await fetch(ANTHROPIC_MODELS_URL, {
        headers: {
          "anthropic-beta": ANTHROPIC_OAUTH_REQUIRED_BETA_HEADER,
          "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${accessToken}`,
        },
        method: "GET",
      });
      if (!response.ok) {
        throw new Error(`Anthropic request failed (${response.status}).`);
      }
      const payload = await response.json();
      return dedupeAndSort(
        (payload.data ?? []).flatMap((entry) => {
          const id = entry.id?.trim() ?? "";
          return id
            ? [createModelOption("anthropic", id, entry.display_name)]
            : [];
        }),
      );
    };

    const models = await requestModels(tokens.accessToken);
    if (models.length === 0) {
      return {
        error: "Anthropic returned no models.",
        models: [],
        source: "unavailable",
      };
    }

    return {
      models,
      oauth: {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt ?? Date.now() + 15 * 60 * 1000,
        refreshToken: tokens.refreshToken,
      },
      source: "api",
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Anthropic models.",
      models: [],
      source: "unavailable",
    };
  }
};

const fetchAnthropicModels = async (authMode, anthropicApiKey, _oauthInput) => {
  if (authMode === "claudeCode") {
    return {
      models: await fetchClaudeCodeModelOptionsFromDocs(),
      source: "api",
    };
  }

  if (!anthropicApiKey) {
    return {
      error: "Add an Anthropic API key to fetch the latest model list.",
      models: [],
      source: "unavailable",
    };
  }

  try {
    const response = await fetch(ANTHROPIC_MODELS_URL, {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": anthropicApiKey,
      },
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Anthropic request failed (${response.status}).`);
    }
    const payload = await response.json();
    const models = dedupeAndSort(
      (payload.data ?? []).flatMap((entry) => {
        const id = entry.id?.trim() ?? "";
        return id
          ? [createModelOption("anthropic", id, entry.display_name)]
          : [];
      }),
    );
    if (models.length === 0) {
      return {
        error: "Anthropic returned no models.",
        models: [],
        source: "unavailable",
      };
    }
    return { models, source: "api" };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Anthropic models.",
      models: [],
      source: "unavailable",
    };
  }
};

const GEMINI_NATIVE_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const fetchGeminiModels = async (geminiApiKey) => {
  if (!geminiApiKey) {
    return {
      error: "Add a Gemini API key to fetch the latest model list.",
      models: [],
      source: "unavailable",
    };
  }

  try {
    const url = `${GEMINI_NATIVE_MODELS_URL}?key=${encodeURIComponent(geminiApiKey)}&pageSize=1000`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Gemini request failed (${response.status}).`);
    }
    const payload = await response.json();
    const modelIds = (payload.models ?? [])
      .flatMap((entry) => {
        let name = entry.name?.trim() ?? "";
        if (name.toLowerCase().startsWith("models/")) {
          name = name.slice("models/".length);
        }
        return name ? [name] : [];
      })
      .filter((id) => id.toLowerCase().startsWith("gemini"));
    const models = dedupeAndSort(
      modelIds.map((id) => createModelOption("gemini", id)),
    );
    if (models.length === 0) {
      return {
        error: "Gemini returned no models.",
        models: [],
        source: "unavailable",
      };
    }
    return { models, source: "api" };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Gemini models.",
      models: [],
      source: "unavailable",
    };
  }
};

app.post("/api/provider-models", async (c) => {
  let rawBody;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.text("Invalid JSON payload.", 400);
  }

  const requestBodySchema = z.object({
    anthropicAccessToken: z.string().optional(),
    anthropicAccessTokenExpiresAt: z.number().nullable().optional(),
    anthropicAuthMode: z.enum(["apiKey", "claudeCode"]).default("apiKey"),
    anthropicApiKey: z.string().optional(),
    anthropicRefreshToken: z.string().optional(),
    geminiApiKey: z.string().optional(),
    openAiApiKey: z.string().optional(),
    openAiAuthMode: z.enum(["apiKey", "codex"]).default("apiKey"),
  });
  const parsed = requestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.text(parsed.error.message, 400);
  }

  const openAiApiKey = parsed.data.openAiApiKey?.trim() ?? "";
  const anthropicApiKey = parsed.data.anthropicApiKey?.trim() ?? "";
  const geminiApiKey = parsed.data.geminiApiKey?.trim() ?? "";
  const openAiAuthMode = parsed.data.openAiAuthMode;
  const anthropicAuthMode = parsed.data.anthropicAuthMode;
  const anthropicOAuthInput = {
    accessToken: parsed.data.anthropicAccessToken?.trim() ?? "",
    expiresAt: parsed.data.anthropicAccessTokenExpiresAt ?? null,
    refreshToken: parsed.data.anthropicRefreshToken?.trim() ?? "",
  };

  const [openai, anthropic, gemini] = await Promise.all([
    fetchOpenAiModels(openAiAuthMode, openAiApiKey),
    fetchAnthropicModels(
      anthropicAuthMode,
      anthropicApiKey,
      anthropicOAuthInput,
    ),
    fetchGeminiModels(geminiApiKey),
  ]);

  return c.json({
    anthropic,
    fetchedAt: new Date().toISOString(),
    gemini,
    openai,
  });
});

// ── /api/chat ────────────────────────────────────────────────────────────────

const chatRequestBodySchema = z.object({
  authMode: z.enum(["apiKey", "codex", "claudeCode"]).default("apiKey"),
  chatMode: z.enum(["plan", "build"]).default("build"),
  credential: z.string().optional(),
  messages: z.array(z.unknown()),
  model: z.string().min(1),
  projectPath: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "gemini"]),
  remoteConversationId: z.string().nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  threadId: z.string().min(1).optional(),
});

const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const SYSTEM_PROMPT_BUILD = `You are an expert coding copilot embedded in a desktop IDE.

Your primary responsibility is to safely edit files inside the active project.
Use the available tools to inspect files before proposing changes.
Always reference concrete files and exact updates.
When writing files, prefer complete and correct output over partial snippets.
Never attempt to access files outside the active project root.

Important: Always explain your reasoning and findings in text before and after making tool calls. Briefly describe what you are looking for, what you found, and what you plan to do next. Do not make sequences of tool calls without any explanatory text in between.`;

const SYSTEM_PROMPT_PLAN = `You are an expert coding copilot embedded in a desktop IDE.

Your role is to analyze code and create detailed plans without making any changes.
Use the available tools to read and search files to understand the codebase.
Provide concrete, actionable plans that reference specific files and line numbers.
Describe exactly what changes should be made and why, but do NOT write or modify any files.
Never attempt to access files outside the active project root.

Important: Always explain your reasoning and findings in text before and after making tool calls. Briefly describe what you are looking for, what you found, and what you plan to do next. Do not make sequences of tool calls without any explanatory text in between.`;

const OPENAI_CODEX_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TOOL_STEP_LIMIT = 8;
const REASONING_TOOL_STEP_LIMIT = 50;

const normalizePath = (value) => value.replace(/\\/g, "/");

const getAnthropicThinkingOptions = (provider, modelId, effort) => {
  const efforts = getModelReasoningEfforts(provider, modelId);
  if (efforts.length === 0) return undefined;
  const budgetMap = { low: 2048, medium: 8192, high: 32768, xhigh: 65536 };
  return { thinking: { type: "enabled", budgetTokens: budgetMap[effort] } };
};

const getGeminiThinkingOptions = (provider, modelId, effort) => {
  const efforts = getModelReasoningEfforts(provider, modelId);
  if (efforts.length === 0) return undefined;
  const budgetMap = { low: 1024, medium: 8192, high: 24576, xhigh: 24576 };
  return { thinkingConfig: { thinkingBudget: budgetMap[effort] } };
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

const codexSessionIdsByThreadId = new Map();

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
      const label =
        (typeof part.filename === "string" && part.filename.trim()) ||
        (typeof part.mediaType === "string" && part.mediaType.trim()) ||
        "attachment";
      sections.push(`[Attached file: ${label}]`);
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
    "Continue the conversation naturally and complete the user's latest request.",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const getLatestUserPrompt = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") {
      continue;
    }

    const serialized = serializeCodexMessage(message);
    if (serialized) {
      return serialized;
    }
  }

  return "";
};

const writeCodexTextPart = (writer, id, text, type) => {
  if (!text) {
    return;
  }

  writer.write({ type: `${type}-start`, id });
  writer.write({ type: `${type}-delta`, delta: text, id });
  writer.write({ type: `${type}-end`, id });
};

const streamCodexCliResponse = ({
  abortSignal,
  chatMode,
  messages,
  model,
  projectPath,
  systemPrompt,
  threadId,
  remoteConversationId,
}) => {
  const existingSessionId =
    (threadId ? codexSessionIdsByThreadId.get(threadId) : null) ??
    (typeof remoteConversationId === "string" &&
    remoteConversationId.trim().length > 0
      ? remoteConversationId.trim()
      : null);
  const prompt = existingSessionId
    ? getLatestUserPrompt(messages) ||
      buildCodexConversationPrompt({
        messages,
        projectPath,
        systemPrompt,
      })
    : buildCodexConversationPrompt({
        messages,
        projectPath,
        systemPrompt,
      });

  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error ? error.message : "Codex CLI request failed.",
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        const args = existingSessionId
          ? [
              "exec",
              "resume",
              "--json",
              "--skip-git-repo-check",
              ...(model ? ["--model", model] : []),
              existingSessionId,
              "-",
            ]
          : [
              "exec",
              "--json",
              "--cd",
              projectPath,
              "--skip-git-repo-check",
              "--sandbox",
              chatMode === "plan" ? "read-only" : "workspace-write",
              ...(model ? ["--model", model] : []),
              "-",
            ];
        const child = spawn("codex", args, {
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const startedToolCalls = new Set();
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let finished = false;

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          callback();
        };

        const ensureCommandToolStarted = (item) => {
          if (!item?.id || startedToolCalls.has(item.id)) {
            return;
          }

          startedToolCalls.add(item.id);
          writer.write({
            type: "tool-input-start",
            dynamic: true,
            title: "Command",
            toolCallId: item.id,
            toolName: "runCommand",
          });
          writer.write({
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

          if (
            event.type === "thread.started" &&
            typeof event.thread_id === "string" &&
            threadId
          ) {
            codexSessionIdsByThreadId.set(threadId, event.thread_id);
            return;
          }

          if (event.type === "item.started" && event.item?.type === "command_execution") {
            ensureCommandToolStarted(event.item);
            return;
          }

          if (event.type !== "item.completed" || !event.item) {
            return;
          }

          const item = event.item;
          if (item.type === "agent_message" && typeof item.text === "string") {
            writeCodexTextPart(writer, item.id ?? `text-${Date.now()}`, item.text, "text");
            return;
          }

          if (item.type === "reasoning" && typeof item.text === "string") {
            writeCodexTextPart(
              writer,
              item.id ?? `reasoning-${Date.now()}`,
              item.text,
              "reasoning",
            );
            return;
          }

          if (item.type === "command_execution") {
            ensureCommandToolStarted(item);
            writer.write({
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
            writeCodexTextPart(writer, item.id ?? `text-${Date.now()}`, item.text, "text");
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
          child.kill("SIGTERM");
          finish(resolve);
        };

        abortSignal?.addEventListener("abort", handleAbort, { once: true });

        child.stdout.on("data", handleStdoutChunk);
        child.stderr.on("data", (chunk) => {
          stderrBuffer += chunk.toString();
        });
        child.on("error", (error) => {
          abortSignal?.removeEventListener("abort", handleAbort);
          finish(() => reject(error));
        });
        child.on("close", (code) => {
          abortSignal?.removeEventListener("abort", handleAbort);

          const trimmed = stdoutBuffer.trim();
          if (trimmed) {
            try {
              handleEvent(JSON.parse(trimmed));
            } catch {
              stderrBuffer += `${trimmed}\n`;
            }
          }

          finish(() => {
            if (code === 0 || abortSignal?.aborted) {
              resolve();
              return;
            }

            const detail =
              stderrBuffer.trim() || `Codex CLI exited with code ${code}.`;
            reject(new Error(detail));
          });
        });

        child.stdin.end(prompt);
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
    authMode,
    chatMode,
    model,
    projectPath,
    provider,
    reasoningEffort,
    remoteConversationId,
    threadId,
  } = parsed.data;
  const isPlanMode = chatMode === "plan";
  const systemPrompt = isPlanMode ? SYSTEM_PROMPT_PLAN : SYSTEM_PROMPT_BUILD;
  let credential = parsed.data.credential?.trim() ?? "";
  const messages = parsed.data.messages;

  try {
    const projectStats = await fs.stat(projectPath);
    if (!projectStats.isDirectory()) {
      return c.text("projectPath must point to a directory.", 400);
    }
  } catch {
    return c.text("Project path does not exist.", 400);
  }

  let useChatgptCodexEndpoint = false;

  if (provider === "openai" && authMode === "codex") {
    const codexCredential = await readCodexCredential();
    if (!codexCredential.credential) {
      return c.text(
        "Codex login not found. Run `codex login` and try again.",
        401,
      );
    }

    return streamCodexCliResponse({
      abortSignal: c.req.raw.signal,
      chatMode,
      messages,
      model,
      projectPath,
      remoteConversationId,
      systemPrompt,
      threadId,
    });
  }

  const usesClaudeCode = provider === "anthropic" && authMode === "claudeCode";

  if (!credential && !usesClaudeCode) {
    return c.text("Missing provider credential.", 400);
  }

  const providerFactory =
    provider === "anthropic"
      ? authMode === "claudeCode"
        ? (modelId) => claudeCode(normalizeClaudeCodeModel(modelId))
        : createAnthropic({ apiKey: credential })
      : provider === "gemini"
        ? createGoogleGenerativeAI({
            apiKey: credential,
          })
        : createOpenAI({
            apiKey: credential,
            ...(useChatgptCodexEndpoint
              ? { baseURL: OPENAI_CODEX_CHATGPT_BASE_URL }
              : {}),
          });

  const openAiProviderOptions =
    provider === "openai"
      ? {
          ...(useChatgptCodexEndpoint
            ? { instructions: systemPrompt, store: false }
            : {}),
          reasoningEffort,
        }
      : undefined;
  const anthropicProviderOptions =
    provider === "anthropic" && authMode !== "claudeCode"
      ? getAnthropicThinkingOptions(provider, model, reasoningEffort)
      : undefined;
  const geminiProviderOptions =
    provider === "gemini"
      ? getGeminiThinkingOptions(provider, model, reasoningEffort)
      : undefined;

  const usesReasoningModel =
    getModelReasoningEfforts(provider, model).length > 0;
  const languageModel = providerFactory(model);

  const providerOptions = {
    ...(openAiProviderOptions ? { openai: openAiProviderOptions } : {}),
    ...(anthropicProviderOptions
      ? { anthropic: anthropicProviderOptions }
      : {}),
    ...(geminiProviderOptions ? { google: geminiProviderOptions } : {}),
  };
  const hasProviderOptions = Object.keys(providerOptions).length > 0;

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
    ...(hasProviderOptions ? { providerOptions } : {}),
    stopWhen: stepCountIs(
      usesReasoningModel ? REASONING_TOOL_STEP_LIMIT : DEFAULT_TOOL_STEP_LIMIT,
    ),
    system:
      provider === "openai" && useChatgptCodexEndpoint
        ? undefined
        : systemPrompt,
    ...(usesReasoningModel ? {} : { temperature: 0.2 }),
    tools: {
      listFiles: tool({
        description: isPlanMode
          ? "List project files recursively. Use this to explore the project structure."
          : "List project files recursively. Use this before reading or editing unfamiliar areas.",
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
      ...(isPlanMode
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
              requireApproval: true,
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
                return {
                  bytesWritten: Buffer.byteLength(content, "utf8"),
                  filePath,
                  mode,
                  status: "ok",
                  ...(previousContent !== undefined ? { previousContent } : {}),
                  content,
                };
              },
            }),
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
    },
  });

  return textResult.toUIMessageStreamResponse({
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

const projectGitStatusRequestSchema = z.object({
  projectPath: z.string().min(1),
});

const projectGitDiffRequestSchema = z.object({
  filePath: z.string().min(1),
  projectPath: z.string().min(1),
});

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;

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
      branch: repoInfo.branch,
      changes: [],
      isRepo: false,
      repoRoot: null,
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
        path: projectRelativePath,
        previousPath: previousProjectRelativePath,
        status: mapGitChangeStatus(fields[1] ?? "", fields[8]?.[0] ?? ""),
      });
    }
  }

  changes.sort((left, right) => left.path.localeCompare(right.path));

  return {
    branch: repoInfo.branch,
    changes,
    isRepo: true,
    repoRoot: repoInfo.repoRoot,
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

const getProjectGitDiff = async (projectPath, filePath) => {
  const gitStatus = await listProjectGitChanges(projectPath);
  if (!gitStatus.isRepo || !gitStatus.repoRoot) {
    throw new Error("Project is not a Git repository.");
  }

  const normalizedFilePath = normalizePath(filePath);
  const change =
    gitStatus.changes.find((entry) => entry.path === normalizedFilePath) ??
    null;

  if (!change) {
    throw new Error("File does not have Git changes.");
  }

  if (change.status === "untracked") {
    return {
      branch: gitStatus.branch,
      diff: await buildUntrackedFileDiff(projectPath, normalizedFilePath),
      filePath: normalizedFilePath,
      previousPath: change.previousPath,
      status: change.status,
    };
  }

  const repoRelativePath = normalizePath(
    path.relative(
      gitStatus.repoRoot,
      resolveProjectPath(projectPath, normalizedFilePath),
    ),
  );
  const baseRef = await getGitDiffBaseRef(gitStatus.repoRoot);
  const diffResult = await runGitCommand(gitStatus.repoRoot, [
    "diff",
    "--find-renames",
    "--no-ext-diff",
    "--submodule=diff",
    baseRef,
    "--",
    repoRelativePath,
  ]);

  return {
    branch: gitStatus.branch,
    diff: diffResult.stdout,
    filePath: normalizedFilePath,
    previousPath: change.previousPath,
    status: change.status,
  };
};

const ensureProjectDirectory = async (projectPath) => {
  const stats = await fs.stat(projectPath);
  if (!stats.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }
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

  const { filePath, projectPath } = parsed.data;

  try {
    await ensureProjectDirectory(projectPath);
    return c.json(await getProjectGitDiff(projectPath, filePath));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read Git diff.";
    return c.text(message, 400);
  }
});

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
