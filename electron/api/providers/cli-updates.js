import { cliCatalog, execCliCommand, getCliVersion } from "../shared/cli.js";
import { execCursorCliCommand } from "./cursor-cli.js";
import { CLI_UPDATE_PROVIDERS } from "./schemas.js";

export { CLI_UPDATE_PROVIDERS };

/**
 * Looks up the newest published release of each supported agent CLI so the
 * settings UI can flag installed CLIs that are out of date. Comparison with
 * the installed version happens in the renderer, which already tracks it.
 */

const LATEST_VERSION_TTL_MS = 60 * 60 * 1000;
const LATEST_VERSION_FAILURE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

const NPM_PACKAGES = {
  anthropic: "@anthropic-ai/claude-code",
  openai: "@openai/codex",
  opencode: "opencode-ai",
};

const CURSOR_INSTALL_SCRIPT_URL = "https://cursor.com/install";
const GROK_CHANNEL_BASE_URLS = [
  "https://x.ai/cli",
  "https://storage.googleapis.com/grok-build-public-artifacts/cli",
];
const GROK_CHANNELS = new Set(["stable", "alpha", "enterprise"]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._]+)?$/;
const CURSOR_VERSION_PATTERN =
  /downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\//;

const latestVersionCache = new Map();

const fetchText = async (url, { headers } = {}) => {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Request to ${url} failed (${response.status}).`);
  }
  return response.text();
};

const fetchNpmLatestVersion = async (packageName) => {
  const text = await fetchText(
    `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`,
    // The abbreviated metadata document is a fraction of the full packument.
    { headers: { Accept: "application/vnd.npm.install-v1+json" } },
  );
  const version = JSON.parse(text)?.["dist-tags"]?.latest;
  return typeof version === "string" && SEMVER_PATTERN.test(version)
    ? version
    : null;
};

export const parseCursorInstallScriptVersion = (script) =>
  String(script ?? "").match(CURSOR_VERSION_PATTERN)?.[1] ?? null;

const fetchCursorLatestVersion = async () =>
  parseCursorInstallScriptVersion(await fetchText(CURSOR_INSTALL_SCRIPT_URL));

/** `grok --version` prints e.g. `grok 1.0.41 (4220f3b224a6) [stable]`. */
export const parseGrokChannel = (versionOutput) => {
  const channel = String(versionOutput ?? "")
    .match(/\[([a-z]+)\]/i)?.[1]
    ?.toLowerCase();
  return channel && GROK_CHANNELS.has(channel) ? channel : "stable";
};

const fetchGrokLatestVersion = async (channel) => {
  let lastError = null;
  for (const baseUrl of GROK_CHANNEL_BASE_URLS) {
    try {
      const version = (await fetchText(`${baseUrl}/${channel}`))
        .split(/\r?\n/, 1)[0]
        .trim();
      return SEMVER_PATTERN.test(version) ? version : null;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Unable to fetch the latest Grok version.");
};

const resolveLatestVersionLookup = async (provider) => {
  if (provider === "cursor") {
    return { cacheKey: provider, lookup: fetchCursorLatestVersion };
  }

  if (provider === "grok") {
    // Match the release channel the user installed from. The installed
    // version is almost always already cached by the provider models fetch.
    const channel = parseGrokChannel(await getCliVersion("grok"));
    return {
      cacheKey: `grok:${channel}`,
      lookup: () => fetchGrokLatestVersion(channel),
    };
  }

  const packageName = NPM_PACKAGES[provider];
  return {
    cacheKey: provider,
    lookup: () => fetchNpmLatestVersion(packageName),
  };
};

const getLatestCliVersion = async (provider, { force = false } = {}) => {
  const { cacheKey, lookup } = await resolveLatestVersionLookup(provider);
  const cached = latestVersionCache.get(cacheKey);
  if (cached?.promise) {
    return cached.promise;
  }

  if (!force && cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const promise = lookup()
    .then((value) => {
      latestVersionCache.set(cacheKey, {
        expiresAt: Date.now() + LATEST_VERSION_TTL_MS,
        value,
      });
      return value;
    })
    .catch(() => {
      // Offline or the source changed shape. Keep the last known answer and
      // retry sooner than a successful lookup would.
      const value = cached?.value ?? null;
      latestVersionCache.set(cacheKey, {
        expiresAt: Date.now() + LATEST_VERSION_FAILURE_TTL_MS,
        value,
      });
      return value;
    });

  latestVersionCache.set(cacheKey, { ...cached, promise });
  return promise;
};

export const fetchLatestCliVersions = async ({ force = false, providers }) => {
  const entries = await Promise.all(
    providers.map(async (provider) => [
      provider,
      await getLatestCliVersion(provider, { force }),
    ]),
  );
  return Object.fromEntries(entries);
};

// Each CLI ships its own updater, which knows how it was installed (npm,
// pnpm, Homebrew, native installer, ...), so Dream never has to guess.
const UPGRADE_COMMANDS = {
  anthropic: { command: "claude", args: ["update"] },
  cursor: { args: ["update"] },
  grok: { command: "grok", args: ["update"] },
  openai: { command: "codex", args: ["update"] },
  opencode: { command: "opencode", args: ["upgrade"] },
};

const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;
const UPGRADE_OUTPUT_LINES = 12;

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  "g",
);

/** The last few meaningful lines of an updater's output, for error toasts. */
export const summarizeUpgradeOutput = (...outputs) =>
  outputs
    .map((output) => String(output ?? "").replace(ANSI_ESCAPE_PATTERN, ""))
    .join("\n")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-UPGRADE_OUTPUT_LINES)
    .join("\n");

const runningUpgrades = new Map();

const runUpgrade = async (provider) => {
  const { args, command } = UPGRADE_COMMANDS[provider];
  const options = {
    closeStdin: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: UPGRADE_TIMEOUT_MS,
  };

  try {
    const result =
      provider === "cursor"
        ? await execCursorCliCommand(args, options)
        : await execCliCommand(command, args, options);
    return {
      ok: true,
      output: summarizeUpgradeOutput(result.stdout, result.stderr),
    };
  } catch (error) {
    const output = summarizeUpgradeOutput(error?.stdout, error?.stderr);
    const reason = error?.killed
      ? "The update timed out."
      : error instanceof Error
        ? error.message
        : "The update failed.";
    return { error: output || reason, ok: false };
  } finally {
    // Whatever happened, the next lookups should see the new state: the
    // installed version (and, for Cursor, which binary it is) included.
    latestVersionCache.clear();
    cliCatalog.forget(command);
  }
};

/**
 * Runs the CLI's own updater. Concurrent requests for the same provider share
 * one run, so a second click (or a reloaded window) joins it.
 */
export const upgradeCli = (provider) => {
  const running = runningUpgrades.get(provider);
  if (running) {
    return running;
  }

  const promise = runUpgrade(provider).finally(() => {
    runningUpgrades.delete(provider);
  });
  runningUpgrades.set(provider, promise);
  return promise;
};
