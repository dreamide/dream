import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve("electron-updater"));
const updaterSemver = updaterRequire("semver");

const HELLO_URL = "https://dreamide.app/hello";

function getVersionChannel(version) {
  const parsed = updaterSemver.parse(version);
  const prerelease = parsed ? updaterSemver.prerelease(parsed) : null;
  if (!prerelease?.length) {
    return "stable";
  }

  return String(prerelease[0] ?? "prerelease");
}

export function getHelloUrl({
  arch = process.arch,
  currentVersion,
  installId,
  platform = process.platform,
}) {
  const version = String(currentVersion || "unknown");
  const payload = {
    arch,
    channel: getVersionChannel(version),
    check: "automatic",
    platform,
    version,
  };
  const normalizedInstallId =
    typeof installId === "string" ? installId.trim() : "";
  const url = new URL(HELLO_URL);

  for (const [key, value] of Object.entries(payload)) {
    url.searchParams.set(key, value);
  }
  if (normalizedInstallId) {
    url.searchParams.set("installId", normalizedInstallId);
  }

  return url.toString();
}
