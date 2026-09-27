import { getCliVersion } from "../shared/cli.js";

/**
 * Looks up the newest published release of each supported agent CLI so the
 * settings UI can flag installed CLIs that are out of date. Comparison with
 * the installed version happens in the renderer, which already tracks it.
 */

const LATEST_VERSION_TTL_MS = 60 * 60 * 1000;
const LATEST_VERSION_FAILURE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

export const CLI_UPDATE_PROVIDERS = [
  "anthropic",
  "cursor",
  "grok",
  "openai",
  "opencode",
];

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
