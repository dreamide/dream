import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createOpencode } from "@opencode-ai/sdk";
import { execCliCommand, isCliCommandAvailable } from "../shared/cli.js";
import { readCodexChatGptAuthTokens } from "./codex-auth.js";

const OPENAI_CODEX_CHATGPT_USAGE_URL =
  "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_KEYCHAIN_SERVICES = ["Claude Code-credentials", "Claude Code"];
const OPENCODE_STATS_DAYS = 30;
const OPENCODE_STATS_MODEL_LIMIT = 10;
const OPENCODE_STATS_SERVER_TIMEOUT_MS = 10_000;
const PROVIDER_USAGE_SESSION_FILE_LIMIT = 80;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  "g",
);

const providerUsageLimitSnapshots = new Map();
const execFileAsync = promisify(execFile);

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizeResetAt = (value) => {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  const number = toFiniteNumber(value);
  if (number === null || number <= 0) {
    return null;
  }

  return new Date(
    number > 1_000_000_000_000 ? number : number * 1000,
  ).toISOString();
};

const getUsageWindowSeconds = (entry) => {
  const seconds = toFiniteNumber(entry?.limit_window_seconds);
  if (seconds !== null && seconds > 0) {
    return seconds;
  }

  const minutes = toFiniteNumber(entry?.window_minutes);
  if (minutes !== null && minutes > 0) {
    return minutes * 60;
  }

  return null;
};

const formatUsageWindowLabel = (seconds, fallbackLabel) => {
  if (seconds === 18_000) {
    return "5h limit";
  }

  if (seconds === 604_800) {
    return "Weekly limit";
  }

  if (!seconds) {
    return fallbackLabel;
  }

  if (seconds % 604_800 === 0) {
    const weeks = seconds / 604_800;
    return `${weeks}w limit`;
  }

  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 7 ? "Weekly limit" : `${days}d limit`;
  }

  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h limit`;
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m limit`;
  }

  return fallbackLabel;
};

const normalizeUsageLimitWindow = (entry, fallbackLabel) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const usedPercent =
    toFiniteNumber(entry.used_percent) ??
    toFiniteNumber(entry.used_percentage) ??
    toFiniteNumber(entry.usedPercent);
  if (usedPercent === null) {
    return null;
  }

  const windowSeconds = getUsageWindowSeconds(entry);

  return {
    label: formatUsageWindowLabel(windowSeconds, fallbackLabel),
    resetAfterSeconds:
      toFiniteNumber(entry.reset_after_seconds) ??
      toFiniteNumber(entry.resetAfterSeconds),
    resetAt:
      normalizeResetAt(entry.reset_at) ??
      normalizeResetAt(entry.resets_at) ??
      normalizeResetAt(entry.resetAt),
    usedPercent,
  };
};

const normalizeProviderRateLimits = (rateLimits) => {
  if (!rateLimits || typeof rateLimits !== "object") {
    return [];
  }

  return [
    normalizeUsageLimitWindow(
      rateLimits.primary_window ?? rateLimits.primary,
      "Primary limit",
    ),
    normalizeUsageLimitWindow(
      rateLimits.secondary_window ?? rateLimits.secondary,
      "Secondary limit",
    ),
  ].filter(Boolean);
};

const makeUsageLimitsResult = ({
  error = null,
  limits = [],
  modelStats = [],
  note = null,
  provider,
  source = "unavailable",
  status = limits.length > 0 ? "ok" : "unavailable",
  stats = [],
  toolStats = [],
}) => ({
  error,
  fetchedAt: new Date().toISOString(),
  limits,
  modelStats,
  note,
  provider,
  source,
  stats,
  status,
  toolStats,
});

export const storeProviderUsageLimitSnapshot = (
  provider,
  rateLimits,
  source,
) => {
  const limits = normalizeProviderRateLimits(rateLimits);
  if (limits.length === 0) {
    return;
  }

  providerUsageLimitSnapshots.set(provider, {
    fetchedAt: new Date().toISOString(),
    limits,
    provider,
    source,
    status: "ok",
  });
};

export const findRateLimitsObject = (value, depth = 0) => {
  if (!value || typeof value !== "object" || depth > 6) {
    return null;
  }

  if (value.rate_limits && typeof value.rate_limits === "object") {
    return value.rate_limits;
  }

  if (value.rate_limit && typeof value.rate_limit === "object") {
    return value.rate_limit;
  }

  if (value.rateLimits && typeof value.rateLimits === "object") {
    return value.rateLimits;
  }

  if (value.rateLimit && typeof value.rateLimit === "object") {
    return value.rateLimit;
  }

  for (const child of Object.values(value)) {
    const found = findRateLimitsObject(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
};

const collectRecentJsonFiles = async (rootPath, maxFiles) => {
  const files = [];

  const walk = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }

        if (!entry.isFile() || !/\.(jsonl|json)$/i.test(entry.name)) {
          return;
        }

        try {
          const stats = await fs.stat(entryPath);
          files.push({ mtimeMs: stats.mtimeMs, path: entryPath });
        } catch {
          // Ignore files that disappear while scanning.
        }
      }),
    );
  };

  await walk(rootPath);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
};

const readLatestRateLimitsFromFiles = async (rootPaths) => {
  const files = (
    await Promise.all(
      rootPaths.map((rootPath) =>
        collectRecentJsonFiles(rootPath, PROVIDER_USAGE_SESSION_FILE_LIMIT),
      ),
    )
  )
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, PROVIDER_USAGE_SESSION_FILE_LIMIT);

  for (const file of files) {
    let contents;
    try {
      contents = await fs.readFile(file.path, "utf8");
    } catch {
      continue;
    }

    const lines = contents.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const rateLimits = findRateLimitsObject(parsed);
        if (rateLimits) {
          const limits = normalizeProviderRateLimits(rateLimits);
          if (limits.length > 0) {
            return {
              file: file.path,
              limits,
            };
          }
        }
      } catch {
        // Session logs can contain non-JSON diagnostic lines.
      }
    }
  }

  return null;
};

const stripAnsi = (value) =>
  String(value ?? "").replace(ANSI_ESCAPE_PATTERN, "");

const parseOpenCodeStatsRow = (value) => {
  const match = value.match(/^(.+?)\s{2,}(.+)$/);
  if (!match) {
    return null;
  }

  return {
    label: match[1].trim(),
    value: match[2].trim(),
  };
};

const parseOpenCodeStatsOutput = (value) => {
  const sectionHeaders = new Set([
    "OVERVIEW",
    "COST & TOKENS",
    "MODEL USAGE",
    "TOOL USAGE",
  ]);
  const stats = [];
  const modelStats = [];
  const toolStats = [];
  let section = null;
  let currentModel = null;

  const finishModel = () => {
    if (currentModel?.id && currentModel.stats.length > 0) {
      modelStats.push(currentModel);
    }
    currentModel = null;
  };

  for (const rawLine of stripAnsi(value).split(/\r?\n/)) {
    const content = rawLine.replace(/[│]/g, "").trim();
    if (!content || /^[┌┐└┘├┤─\s]+$/u.test(content)) {
      continue;
    }

    if (sectionHeaders.has(content)) {
      finishModel();
      section = content;
      continue;
    }

    if (section === "OVERVIEW" || section === "COST & TOKENS") {
      const row = parseOpenCodeStatsRow(content);
      if (row) {
        stats.push(row);
      }
      continue;
    }

    if (section !== "MODEL USAGE") {
      if (section === "TOOL USAGE") {
        const toolMatch = content.match(/^(\S+)\s+.*?(\d+\s+\([^)]+\))$/);
        if (toolMatch) {
          toolStats.push({
            label: toolMatch[1].trim(),
            value: toolMatch[2].trim(),
          });
        }
      }
      continue;
    }

    const row = parseOpenCodeStatsRow(content);
    if (row && currentModel) {
      currentModel.stats.push(row);
      continue;
    }

    if (content.includes("/")) {
      finishModel();
      currentModel = {
        id: content,
        stats: [],
      };
    }
  }

  finishModel();
  return { modelStats, stats, toolStats };
};

const getOpenCodeRequestQuery = (projectPath) => {
  const directory =
    typeof projectPath === "string" && projectPath.trim()
      ? projectPath.trim()
      : null;

  return directory ? { directory } : undefined;
};

const getOpenCodeSessionTimestamp = (session) => {
  const updated = toFiniteNumber(session?.time?.updated);
  if (updated !== null) {
    return updated;
  }

  return toFiniteNumber(session?.time?.created) ?? 0;
};

const getOpenCodeMessageTimestamp = (message) => {
  const created = toFiniteNumber(message?.time?.created);
  if (created !== null) {
    return created;
  }

  return toFiniteNumber(message?.time?.completed) ?? 0;
};

const formatCompactNumber = (value) => {
  const number = Math.max(0, Math.round(Number(value) || 0));
  if (number < 1000) {
    return String(number);
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(number);
};

const formatCost = (value, digits = 2) =>
  `$${Math.max(0, Number(value) || 0).toFixed(digits)}`;

const getMessageTokenTotal = (tokens) =>
  (toFiniteNumber(tokens?.input) ?? 0) +
  (toFiniteNumber(tokens?.output) ?? 0) +
  (toFiniteNumber(tokens?.reasoning) ?? 0) +
  (toFiniteNumber(tokens?.cache?.read) ?? 0) +
  (toFiniteNumber(tokens?.cache?.write) ?? 0);

const createOpenCodeStatsRows = ({ totals }) => {
  return [
    { label: "Total Cost", value: formatCost(totals.cost, 2) },
    { label: "Messages", value: String(totals.messages) },
    { label: "Sessions", value: String(totals.sessions) },
    { label: "Tokens", value: formatCompactNumber(totals.tokenTotal) },
  ];
};

const createOpenCodeModelStats = (modelTotals) =>
  [...modelTotals.entries()]
    .sort(([, left], [, right]) => right.messages - left.messages)
    .slice(0, OPENCODE_STATS_MODEL_LIMIT)
    .map(([id, totals]) => ({
      id,
      stats: [
        { label: "Messages", value: String(totals.messages) },
        { label: "Input Tokens", value: formatCompactNumber(totals.input) },
        { label: "Output Tokens", value: formatCompactNumber(totals.output) },
        { label: "Cache Read", value: formatCompactNumber(totals.cacheRead) },
        { label: "Cache Write", value: formatCompactNumber(totals.cacheWrite) },
        { label: "Cost", value: formatCost(totals.cost, 4) },
      ],
    }));

const createOpenCodeToolStats = (toolTotals) => {
  const total = [...toolTotals.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return [];
  }

  return [...toolTotals.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, OPENCODE_STATS_MODEL_LIMIT)
    .map(([label, count]) => ({
      label,
      value: `${count} (${((count / total) * 100).toFixed(1)}%)`,
    }));
};

const fetchOpenCodeUsageStatsWithSdk = async ({ projectPath } = {}) => {
  const query = getOpenCodeRequestQuery(projectPath);
  const since = Date.now() - OPENCODE_STATS_DAYS * 24 * 60 * 60 * 1000;
  const opencode = await createOpencode({
    hostname: "127.0.0.1",
    port: 0,
    timeout: OPENCODE_STATS_SERVER_TIMEOUT_MS,
  });

  try {
    const sessionsResult = await opencode.client.session.list(
      query ? { query } : undefined,
    );
    const sessions = Array.isArray(sessionsResult.data)
      ? sessionsResult.data
      : [];
    const recentSessions = sessions.filter(
      (session) => getOpenCodeSessionTimestamp(session) >= since,
    );
    const totals = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      inputTokens: 0,
      messages: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      sessions: recentSessions.length,
      tokenTotal: 0,
    };
    const modelTotals = new Map();
    const toolTotals = new Map();

    for (const session of recentSessions) {
      const messagesResult = await opencode.client.session.messages({
        path: { id: session.id },
        query: {
          ...(query ?? {}),
        },
      });
      const messages = Array.isArray(messagesResult.data)
        ? messagesResult.data
        : [];

      for (const entry of messages) {
        const info = entry?.info;
        if (!info || getOpenCodeMessageTimestamp(info) < since) {
          continue;
        }

        totals.messages += 1;

        for (const part of entry.parts ?? []) {
          if (part?.type !== "tool" || typeof part.tool !== "string") {
            continue;
          }

          toolTotals.set(part.tool, (toolTotals.get(part.tool) ?? 0) + 1);
        }

        if (info.role !== "assistant") {
          continue;
        }

        const cost = toFiniteNumber(info.cost) ?? 0;
        const input = toFiniteNumber(info.tokens?.input) ?? 0;
        const output = toFiniteNumber(info.tokens?.output) ?? 0;
        const reasoning = toFiniteNumber(info.tokens?.reasoning) ?? 0;
        const cacheRead = toFiniteNumber(info.tokens?.cache?.read) ?? 0;
        const cacheWrite = toFiniteNumber(info.tokens?.cache?.write) ?? 0;
        const tokenTotal = getMessageTokenTotal(info.tokens);

        totals.cost += cost;
        totals.inputTokens += input;
        totals.outputTokens += output;
        totals.reasoningTokens += reasoning;
        totals.cacheReadTokens += cacheRead;
        totals.cacheWriteTokens += cacheWrite;
        totals.tokenTotal += tokenTotal;

        const modelId = [info.providerID, info.modelID]
          .filter((value) => typeof value === "string" && value.trim())
          .join("/");
        if (!modelId) {
          continue;
        }

        const model = modelTotals.get(modelId) ?? {
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          input: 0,
          messages: 0,
          output: 0,
        };
        model.cacheRead += cacheRead;
        model.cacheWrite += cacheWrite;
        model.cost += cost;
        model.input += input;
        model.messages += 1;
        model.output += output;
        modelTotals.set(modelId, model);
      }
    }

    if (
      totals.sessions === 0 &&
      totals.messages === 0 &&
      modelTotals.size === 0
    ) {
      throw new Error("OpenCode returned no usage stats.");
    }

    const hasProjectScope = typeof query?.directory === "string";
    return makeUsageLimitsResult({
      modelStats: createOpenCodeModelStats(modelTotals),
      note: `Local ${OPENCODE_STATS_DAYS}d usage${hasProjectScope ? " for this project" : ""}.`,
      provider: "opencode",
      source: "opencode sdk",
      stats: createOpenCodeStatsRows({
        totals,
      }),
      status: "ok",
      toolStats: createOpenCodeToolStats(toolTotals),
    });
  } finally {
    opencode.server.close();
  }
};

const fetchOpenCodeUsageStatsWithCli = async ({ projectPath } = {}) => {
  const hasProjectPath = typeof projectPath === "string" && projectPath.trim();
  const args = [
    "stats",
    "--days",
    String(OPENCODE_STATS_DAYS),
    "--models",
    String(OPENCODE_STATS_MODEL_LIMIT),
    ...(hasProjectPath ? ["--project", ""] : []),
  ];
  const result = await execCliCommand("opencode", args, {
    ...(hasProjectPath ? { cwd: projectPath.trim() } : {}),
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = parseOpenCodeStatsOutput(`${result.stdout}\n${result.stderr}`);
  if (parsed.stats.length === 0 && parsed.modelStats.length === 0) {
    throw new Error("OpenCode returned no usage stats.");
  }

  return makeUsageLimitsResult({
    modelStats: parsed.modelStats,
    note: `Local ${OPENCODE_STATS_DAYS}d usage${hasProjectPath ? " for this project" : ""}.`,
    provider: "opencode",
    source: "opencode stats",
    stats: parsed.stats,
    status: "ok",
    toolStats: parsed.toolStats,
  });
};

export const fetchOpenCodeUsageStats = async ({ projectPath } = {}) => {
  const installed = await isCliCommandAvailable("opencode");
  if (!installed) {
    return makeUsageLimitsResult({
      error: "OpenCode CLI is not installed or not available on PATH.",
      provider: "opencode",
    });
  }

  try {
    return await fetchOpenCodeUsageStatsWithSdk({ projectPath });
  } catch (error) {
    try {
      const result = await fetchOpenCodeUsageStatsWithCli({ projectPath });
      return {
        ...result,
        error:
          error instanceof Error
            ? `SDK usage failed: ${error.message}`
            : "SDK usage failed.",
      };
    } catch (fallbackError) {
      return makeUsageLimitsResult({
        error:
          fallbackError instanceof Error
            ? fallbackError.message
            : error instanceof Error
              ? error.message
              : "Unable to fetch OpenCode usage stats.",
        provider: "opencode",
      });
    }
  }
};

export const fetchOpenAiUsageLimits = async () => {
  const tokens = await readCodexChatGptAuthTokens();
  if (!tokens) {
    return makeUsageLimitsResult({
      error: "Run `codex login` to fetch Codex usage limits.",
      provider: "openai",
    });
  }

  try {
    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
    };
    if (tokens.chatgptAccountId) {
      headers["ChatGPT-Account-Id"] = tokens.chatgptAccountId;
    }

    const response = await fetch(OPENAI_CODEX_CHATGPT_USAGE_URL, {
      headers,
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Codex usage request failed (${response.status}).`);
    }

    const payload = await response.json();
    const rateLimits = payload.rate_limit ?? payload.rate_limits;
    const limits = normalizeProviderRateLimits(rateLimits);

    if (limits.length === 0) {
      throw new Error("Codex returned no usage limit windows.");
    }

    storeProviderUsageLimitSnapshot("openai", rateLimits, "codex");
    return makeUsageLimitsResult({
      limits,
      provider: "openai",
      source: "codex",
    });
  } catch (error) {
    const cached = providerUsageLimitSnapshots.get("openai");
    if (cached) {
      return {
        ...cached,
        error: error instanceof Error ? error.message : "Codex usage failed.",
      };
    }

    const localSnapshot = await readLatestRateLimitsFromFiles([
      path.join(os.homedir(), ".codex", "sessions"),
      path.join(os.homedir(), ".codex", "archived_sessions"),
    ]);
    if (localSnapshot) {
      return makeUsageLimitsResult({
        error: error instanceof Error ? error.message : "Codex usage failed.",
        limits: localSnapshot.limits,
        provider: "openai",
        source: "codex session",
      });
    }

    return makeUsageLimitsResult({
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Codex usage limits.",
      provider: "openai",
    });
  }
};

const getClaudeCredentialsPaths = () => [
  path.join(os.homedir(), ".claude", ".credentials.json"),
  path.join(os.homedir(), ".claude", "credentials.json"),
];

const parseClaudeCredentials = (raw, storage) => {
  const parsed = JSON.parse(raw);
  const oauth = parsed.claudeAiOauth;
  const accessToken = oauth?.accessToken?.trim();
  const refreshToken = oauth?.refreshToken?.trim();
  if (!accessToken || !refreshToken) {
    return null;
  }

  return {
    accessToken,
    parsed,
    refreshToken,
    storage,
  };
};

const readClaudeCredentialsFromKeychain = async () => {
  if (process.platform !== "darwin") {
    return null;
  }

  for (const service of CLAUDE_KEYCHAIN_SERVICES) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        service,
        "-w",
      ]));
    } catch {
      continue;
    }

    const raw = stdout.trim();
    if (!raw) {
      continue;
    }

    try {
      const credentials = parseClaudeCredentials(raw, {
        service,
        type: "keychain",
      });
      if (credentials) {
        return credentials;
      }
    } catch {
      // Try the next known keychain service.
    }
  }

  return null;
};

const readClaudeCredentials = async () => {
  const keychainCredentials = await readClaudeCredentialsFromKeychain();
  if (keychainCredentials) {
    return keychainCredentials;
  }

  for (const credentialsPath of getClaudeCredentialsPaths()) {
    let raw;
    try {
      raw = await fs.readFile(credentialsPath, "utf8");
    } catch {
      continue;
    }

    try {
      const credentials = parseClaudeCredentials(raw, {
        path: credentialsPath,
        type: "file",
      });
      if (credentials) {
        return credentials;
      }
    } catch {
      // Try the next known credential location.
    }
  }

  return null;
};

const writeClaudeCredentials = async (
  credentials,
  { accessToken, expiresIn, refreshToken },
) => {
  const expiresAt = Date.now() + expiresIn * 1000;
  const nextCredentials = {
    ...credentials.parsed,
    claudeAiOauth: {
      ...credentials.parsed.claudeAiOauth,
      accessToken,
      expiresAt,
      refreshToken,
    },
  };

  const serialized = JSON.stringify(nextCredentials);
  if (credentials.storage?.type === "keychain") {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-a",
      process.env.USER || "claude",
      "-s",
      credentials.storage.service,
      "-w",
      serialized,
    ]);
    return;
  }

  if (credentials.storage?.path) {
    await fs.writeFile(credentials.storage.path, serialized, "utf8");
  }
};

const refreshClaudeCredentials = async (credentials) => {
  const body = new URLSearchParams({
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  });
  const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    body,
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Claude token refresh failed (${response.status}).`);
  }

  const payload = await response.json();
  const accessToken = payload.access_token?.trim();
  const refreshToken = payload.refresh_token?.trim();
  const expiresIn = toFiniteNumber(payload.expires_in);
  if (!accessToken || !refreshToken || expiresIn === null) {
    throw new Error("Claude token refresh returned incomplete credentials.");
  }

  await writeClaudeCredentials(credentials, {
    accessToken,
    expiresIn,
    refreshToken,
  });

  return {
    ...credentials,
    accessToken,
    refreshToken,
  };
};

const fetchClaudeUsageWithToken = async (accessToken) => {
  const response = await fetch(CLAUDE_OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    method: "GET",
  });

  if (!response.ok) {
    const error = new Error(
      `Claude usage request failed (${response.status}).`,
    );
    error.status = response.status;
    throw error;
  }

  return response.json();
};

const normalizeUsageUtilizationPercent = (value) => {
  const number = toFiniteNumber(value);
  if (number === null) {
    return null;
  }

  return number > 0 && number <= 1 ? number * 100 : number;
};

const normalizeClaudeUsageWindow = (entry, label) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const usedPercent = normalizeUsageUtilizationPercent(
    entry.utilization ?? entry.used_percent ?? entry.used_percentage,
  );
  if (usedPercent === null) {
    return null;
  }

  return {
    label,
    resetAfterSeconds:
      toFiniteNumber(entry.reset_after_seconds) ??
      toFiniteNumber(entry.resetAfterSeconds),
    resetAt:
      normalizeResetAt(entry.resets_at) ??
      normalizeResetAt(entry.reset_at) ??
      normalizeResetAt(entry.resetAt),
    usedPercent,
  };
};

const normalizeClaudeUsageLimits = (payload) =>
  [
    normalizeClaudeUsageWindow(payload?.five_hour, "5h limit"),
    normalizeClaudeUsageWindow(payload?.seven_day, "Weekly limit"),
  ].filter(Boolean);

export const fetchAnthropicUsageLimits = async () => {
  const credentials = await readClaudeCredentials();
  if (credentials) {
    try {
      let payload;
      try {
        payload = await fetchClaudeUsageWithToken(credentials.accessToken);
      } catch (error) {
        if (error?.status !== 401 && error?.status !== 429) {
          throw error;
        }

        const refreshedCredentials =
          await refreshClaudeCredentials(credentials);
        payload = await fetchClaudeUsageWithToken(
          refreshedCredentials.accessToken,
        );
      }

      const limits = normalizeClaudeUsageLimits(payload);
      if (limits.length === 0) {
        throw new Error("Claude returned no usage limit windows.");
      }

      const result = makeUsageLimitsResult({
        limits,
        provider: "anthropic",
        source: "claude",
      });
      providerUsageLimitSnapshots.set("anthropic", result);
      return result;
    } catch (error) {
      const cached = providerUsageLimitSnapshots.get("anthropic");
      if (cached) {
        return {
          ...cached,
          error:
            error instanceof Error ? error.message : "Claude usage failed.",
        };
      }

      const localSnapshot = await readLatestRateLimitsFromFiles([
        path.join(os.homedir(), ".claude", "projects"),
      ]);
      if (localSnapshot) {
        return makeUsageLimitsResult({
          error:
            error instanceof Error ? error.message : "Claude usage failed.",
          limits: localSnapshot.limits,
          provider: "anthropic",
          source: "claude session",
        });
      }

      return makeUsageLimitsResult({
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch Claude usage limits.",
        provider: "anthropic",
      });
    }
  }

  const localSnapshot = await readLatestRateLimitsFromFiles([
    path.join(os.homedir(), ".claude", "projects"),
  ]);
  if (localSnapshot) {
    return makeUsageLimitsResult({
      limits: localSnapshot.limits,
      provider: "anthropic",
      source: "claude session",
    });
  }

  return makeUsageLimitsResult({
    error:
      "Claude usage limit windows are unavailable. Claude Code can still be connected and working normally when it does not expose local rate-limit data.",
    provider: "anthropic",
  });
};
