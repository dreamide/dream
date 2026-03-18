/**
 * Hono-based API server for Dream IDE.
 *
 * Migrated from Next.js App Router route handlers.  Each route keeps the same
 * Request/Response contract so the renderer `fetch("/api/…")` calls work
 * unchanged.
 *
 * This file is loaded by the Electron main process at startup.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { serve } from "@hono/node-server";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
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
    const newFormat = id.match(/^claude-(?:sonnet|opus|haiku)-(\d+)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) return ["low", "medium", "high"];
    }
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7))
        return ["low", "medium", "high"];
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

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable message from a streaming error.
 *
 * Provider SDK errors (APICallError) carry statusCode, responseBody, data, and
 * cause. We try each source in turn so the user sees something actionable
 * rather than the bare word "Error".
 */
const formatStreamError = (error) => {
  if (error == null) return "An unknown error occurred.";
  if (typeof error === "string") return error || "An unknown error occurred.";
  if (typeof error !== "object")
    return String(error) || "An unknown error occurred.";

  const details = [];
  const isGeneric = (s) =>
    !s || s === "Error" || s === "error" || s === "Unknown error";

  // 1. Status code (e.g. 400, 401, 429, 529)
  const statusCode = error.statusCode ?? error.status;
  if (statusCode) details.push(`[${statusCode}]`);

  // 2. Primary message
  const msg = error.message;
  if (!isGeneric(msg)) {
    details.push(msg);
  }

  // 3. Structured `data` from provider SDKs
  //    Anthropic: { type: "error", error: { type: "invalid_request_error", message: "..." } }
  //    OpenAI:    { error: { message: "...", type: "...", code: "..." } }
  const errData = error.data?.error ?? error.data;
  if (errData && typeof errData === "object") {
    // Error type/code (e.g. "invalid_request_error", "insufficient_quota")
    const errType = errData.type ?? errData.code;
    if (typeof errType === "string" && errType.length > 0) {
      details.push(errType.replaceAll("_", " "));
    }
    // Message from the structured body (only if different from what we have)
    const errMsg = errData.message;
    if (typeof errMsg === "string" && !isGeneric(errMsg) && errMsg !== msg) {
      details.push(errMsg);
    }
  }

  // 4. responseBody — raw text (fallback if data didn't help)
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

  // 5. Cause chain
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

  if (details.length > 0) return details.join(" \u2014 ");

  return "An unexpected error occurred. Check the server console for details.";
};

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// ── /api/codex-auth ──────────────────────────────────────────────────────────

app.get("/api/codex-auth", async (c) => {
  const status = await getCodexAuthStatus();
  return c.json(status);
});

// ── /api/anthropic-oauth/authorize ───────────────────────────────────────────

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

// ── /api/anthropic-oauth/exchange ────────────────────────────────────────────

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

// ── /api/anthropic-oauth/refresh ─────────────────────────────────────────────

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

const fetchAnthropicModelsWithOAuth = async (oauthInput) => {
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

const fetchAnthropicModels = async (authMode, anthropicApiKey, oauthInput) => {
  if (authMode === "claudeProMax") {
    return fetchAnthropicModelsWithOAuth(oauthInput);
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
        // Native API returns name like "models/gemini-2.0-flash"
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
    anthropicAuthMode: z.enum(["apiKey", "claudeProMax"]).default("apiKey"),
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
  anthropicOAuth: z
    .object({
      accessToken: z.string().optional(),
      expiresAt: z.number().optional(),
      refreshToken: z.string().optional(),
    })
    .optional(),
  authMode: z.enum(["apiKey", "codex", "claudeProMax"]).default("apiKey"),
  chatMode: z.enum(["plan", "build"]).default("build"),
  credential: z.string().optional(),
  messages: z.array(z.unknown()),
  model: z.string().min(1),
  projectPath: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "gemini"]),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
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
const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
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
    anthropicOAuth,
    authMode,
    chatMode,
    model,
    projectPath,
    provider,
    reasoningEffort,
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
    credential = codexCredential.credential;
    useChatgptCodexEndpoint = codexCredential.source === "chatgpt";
  }

  if (provider === "anthropic" && authMode === "claudeProMax") {
    const refreshToken = anthropicOAuth?.refreshToken?.trim() ?? "";
    const oauthAccessToken = anthropicOAuth?.accessToken?.trim() ?? "";
    const oauthExpiresAt =
      typeof anthropicOAuth?.expiresAt === "number"
        ? anthropicOAuth.expiresAt
        : null;

    if (!refreshToken) {
      return c.text(
        "Claude Pro/Max session is missing. Reconnect Anthropic in Settings.",
        401,
      );
    }

    const needsRefresh =
      !oauthAccessToken ||
      (oauthExpiresAt !== null && oauthExpiresAt <= Date.now() + 15_000);

    if (needsRefresh) {
      const refreshed = await refreshAnthropicAccessToken(refreshToken);
      credential = refreshed.accessToken;
    } else {
      credential = oauthAccessToken;
    }
  }

  if (!credential) {
    return c.text("Missing provider credential.", 400);
  }

  const anthropicOauthFetch = async (input, init) => {
    const requestHeaders = new Headers();
    if (input instanceof Request) {
      input.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    }
    if (init?.headers) {
      const incoming = new Headers(init.headers);
      incoming.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    }
    const incomingBeta = requestHeaders.get("anthropic-beta") ?? "";
    const mergedBetas = Array.from(
      new Set(
        [
          ...ANTHROPIC_OAUTH_REQUIRED_BETA_HEADER.split(","),
          ...incomingBeta.split(","),
        ]
          .map((beta) => beta.trim())
          .filter(Boolean),
      ),
    ).join(",");
    requestHeaders.set("anthropic-beta", mergedBetas);
    requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");

    let requestInput = input;
    try {
      const inputUrl =
        typeof input === "string" || input instanceof URL
          ? new URL(input.toString())
          : new URL(input.url);
      if (
        inputUrl.pathname === "/v1/messages" &&
        !inputUrl.searchParams.has("beta")
      ) {
        inputUrl.searchParams.set("beta", "true");
        requestInput =
          input instanceof Request
            ? new Request(inputUrl.toString(), input)
            : inputUrl;
      }
    } catch {
      // Ignore URL parsing failures
    }
    return fetch(requestInput, { ...init, headers: requestHeaders });
  };

  const providerFactory =
    provider === "anthropic"
      ? authMode === "claudeProMax"
        ? createAnthropic({
            authToken: credential,
            fetch: anthropicOauthFetch,
            headers: {
              "anthropic-beta": ANTHROPIC_OAUTH_REQUIRED_BETA_HEADER,
              "user-agent": "claude-cli/2.1.2 (external, cli)",
            },
          })
        : createAnthropic({ apiKey: credential })
      : provider === "gemini"
        ? createOpenAI({
            apiKey: credential,
            baseURL: GEMINI_OPENAI_BASE_URL,
            name: "gemini",
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
    provider === "anthropic"
      ? getAnthropicThinkingOptions(provider, model, reasoningEffort)
      : undefined;
  const geminiProviderOptions =
    provider === "gemini"
      ? getGeminiThinkingOptions(provider, model, reasoningEffort)
      : undefined;

  const usesReasoningModel =
    getModelReasoningEfforts(provider, model).length > 0;
  const languageModel =
    provider === "gemini"
      ? providerFactory.chat(model)
      : providerFactory(model);

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

/**
 * Start the API server on the given port.
 * Returns the Node.js HTTP server instance.
 */
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
