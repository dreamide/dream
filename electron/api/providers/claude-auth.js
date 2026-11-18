/**
 * Claude Code's login, as the usage limits read uses it: where its OAuth
 * credentials are read from, and the token refresh that writes them back.
 *
 * Credentials are read from the macOS keychain first (the two services
 * Claude Code has used), then from `~/.claude/.credentials.json` and
 * `~/.claude/credentials.json`. Each needs both an access token and a
 * refresh token. A request the access token is refused for (401 or 429)
 * refreshes the token once, writes the new tokens back where they were read
 * from, and is tried again.
 *
 * The file system, the `security` command, the clock and `fetch` are passed
 * in as ports: the real ones in production, fakes in tests.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** The keychain services Claude Code keeps its credentials under, in order. */
const CLAUDE_KEYCHAIN_SERVICES = ["Claude Code-credentials", "Claude Code"];
/** How long the token refresh may take, as long as a usage request. */
const CLAUDE_TOKEN_REQUEST_TIMEOUT_MS = 15_000;

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** The credentials in `raw`, or null without both tokens; throws on bad JSON. */
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

/**
 * @typedef {object} ClaudeCredentials
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {any} parsed the whole stored document, written back on refresh
 * @property {{ type: "keychain", service: string } | { type: "file", path: string }} storage
 *   where it was read from, and where a refresh writes it
 */

/**
 * @param {object} [ports]
 * @param {Record<string, string | undefined>} [ports.env] `USER` names the keychain account written
 * @param {(command: string, args: string[]) => Promise<{ stdout: string }>} [ports.execFile]
 *   runs `security`, the keychain's command
 * @param {typeof fetch} [ports.fetch]
 * @param {() => string} [ports.homedir]
 * @param {() => number} [ports.now]
 * @param {string} [ports.platform] the keychain is read on `darwin` only
 * @param {(filePath: string) => Promise<string>} [ports.readFile]
 * @param {(filePath: string, contents: string) => Promise<void>} [ports.writeFile]
 */
export const createClaudeAuth = ({
  env = process.env,
  execFile = promisify(execFileCallback),
  fetch = (input, init) => globalThis.fetch(input, init),
  homedir = os.homedir,
  now = Date.now,
  platform = process.platform,
  readFile = (filePath) => fs.readFile(filePath, "utf8"),
  writeFile = (filePath, contents) => fs.writeFile(filePath, contents, "utf8"),
} = {}) => {
  const credentialsPaths = () => [
    path.join(homedir(), ".claude", ".credentials.json"),
    path.join(homedir(), ".claude", "credentials.json"),
  ];

  const readFromKeychain = async () => {
    if (platform !== "darwin") {
      return null;
    }

    for (const service of CLAUDE_KEYCHAIN_SERVICES) {
      let stdout;
      try {
        ({ stdout } = await execFile("security", [
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

  /**
   * The first usable credentials: the keychain's, then each file's. Null
   * when none has both tokens.
   * @returns {Promise<ClaudeCredentials | null>}
   */
  const read = async () => {
    const keychainCredentials = await readFromKeychain();
    if (keychainCredentials) {
      return keychainCredentials;
    }

    for (const credentialsPath of credentialsPaths()) {
      let raw;
      try {
        raw = await readFile(credentialsPath);
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

  const write = async (
    credentials,
    { accessToken, expiresIn, refreshToken },
  ) => {
    const expiresAt = now() + expiresIn * 1000;
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
      await execFile("security", [
        "add-generic-password",
        "-U",
        "-a",
        env.USER || "claude",
        "-s",
        credentials.storage.service,
        "-w",
        serialized,
      ]);
      return;
    }

    if (credentials.storage?.path) {
      await writeFile(credentials.storage.path, serialized);
    }
  };

  const refresh = async (credentials) => {
    const body = new URLSearchParams({
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    });
    const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      body,
      method: "POST",
      signal: AbortSignal.timeout(CLAUDE_TOKEN_REQUEST_TIMEOUT_MS),
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

    await write(credentials, {
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

  /**
   * `request` with the credentials' access token. When it throws an error
   * whose `status` is 401 or 429, the token is refreshed and written back,
   * and `request` is tried once more with the new one. A failed refresh or
   * write throws, as does any other failure of `request`.
   * @template T
   * @param {ClaudeCredentials} credentials
   * @param {(accessToken: string) => Promise<T>} request
   * @returns {Promise<T>}
   */
  const withAccessToken = async (credentials, request) => {
    try {
      return await request(credentials.accessToken);
    } catch (error) {
      if (error?.status !== 401 && error?.status !== 429) {
        throw error;
      }

      const refreshedCredentials = await refresh(credentials);
      return request(refreshedCredentials.accessToken);
    }
  };

  return { read, withAccessToken };
};

/** Claude Code's login on this machine. */
export const claudeAuth = createClaudeAuth();
