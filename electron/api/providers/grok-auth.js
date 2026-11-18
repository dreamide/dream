/**
 * The Grok CLI's login, as the usage limits read uses it: which of the
 * credentials in `$GROK_HOME/auth.json` (by default `~/.grok/auth.json`)
 * to send.
 *
 * The file maps a scope to a credential. Each credential with a token is
 * scored, and the highest wins; on a tie, the one written first:
 *
 *   +8  not expired (one without an expiry never is)
 *   +4  a scope starting `https://auth.x.ai::`, or else
 *   +2  a scope containing `accounts.x.ai`
 *   +1  an `oidc` auth mode
 *
 * An expired credential is still chosen when it is the only one.
 *
 * The file system, the environment and the clock are passed in as ports:
 * the real ones in production, fakes in tests.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * An expiry as an ISO time: a date string, or seconds (milliseconds past
 * 1e12) since the epoch. The same reading as usage-limits.js's reset times.
 */
const normalizeExpiresAt = (value) => {
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

/**
 * @typedef {object} GrokCredentials
 * @property {string} accessToken
 * @property {string} scope the key it is stored under
 * @property {string} userId sent as `x-userid` when not empty
 * @property {number} score
 */

/**
 * @param {object} [ports]
 * @param {Record<string, string | undefined>} [ports.env] `GROK_HOME` moves the login's directory
 * @param {() => string} [ports.homedir]
 * @param {() => number} [ports.now]
 * @param {(filePath: string) => Promise<string>} [ports.readFile]
 */
export const createGrokAuth = ({
  env = process.env,
  homedir = os.homedir,
  now = Date.now,
  readFile = (filePath) => fs.readFile(filePath, "utf8"),
} = {}) => {
  const authPath = () =>
    path.join(
      env.GROK_HOME?.trim() || path.join(homedir(), ".grok"),
      "auth.json",
    );

  const isExpired = (entry) => {
    const expiresAt = normalizeExpiresAt(entry?.expires_at ?? entry?.expiresAt);
    if (!expiresAt) {
      return false;
    }

    return Date.parse(expiresAt) <= now();
  };

  const score = (scope, entry) => {
    let total = 0;
    if (typeof scope === "string" && scope.startsWith("https://auth.x.ai::")) {
      total += 4;
    } else if (typeof scope === "string" && scope.includes("accounts.x.ai")) {
      total += 2;
    }

    if (
      String(entry?.auth_mode ?? entry?.authMode ?? "").toLowerCase() === "oidc"
    ) {
      total += 1;
    }

    if (!isExpired(entry)) {
      total += 8;
    }

    return total;
  };

  /**
   * The credential to send, or null when the file is missing, is not JSON
   * or holds no token.
   * @returns {Promise<GrokCredentials | null>}
   */
  const read = async () => {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(authPath()));
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const candidates = Object.entries(parsed).flatMap(([scope, entry]) => {
      const accessToken = entry?.key?.trim?.() || entry?.access_token?.trim?.();
      if (!accessToken) {
        return [];
      }

      return [
        {
          accessToken,
          scope,
          userId: entry.user_id?.trim?.() || entry.userId?.trim?.() || "",
          score: score(scope, entry),
        },
      ];
    });

    if (candidates.length === 0) {
      return null;
    }

    // A stable sort: a tie keeps the file's order.
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0];
  };

  return { read };
};

/** The Grok CLI's login on this machine. */
export const grokAuth = createGrokAuth();
