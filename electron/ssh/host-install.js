// Installing the host runtime on an SSH host (scripts/build-host-runtime.mjs
// builds it; the release workflow publishes it with SHA256SUMS). Installed
// per version under ~/.dream/host/versions/<version>/, so a new version
// installs beside the one a running daemon uses:
//
//   1. The host downloads its platform's archive and SHA256SUMS itself
//      (curl or wget), checks the checksum, unpacks into a staging folder,
//      runs `dream-host version`, then moves it into place and marks it
//      complete. A lock keeps two installs from racing.
//   2. If the host cannot download (no internet, no curl/wget), this
//      machine downloads and checks the same files, uploads them over the
//      SSH connection, and the host installs from the upload.
//
// Old versions are removed, keeping this one and the two newest others,
// never one a running daemon reports.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { quoteShellWord } from "./ssh-args.js";

export const RUNTIME_RELEASES_URL =
  "https://github.com/dreamide/dream/releases/download";

/** Exit codes of the install script. */
export const INSTALL_EXIT = Object.freeze({
  busy: 75,
  checksum: 77,
  download: 76,
  broken: 78,
  unsupported: 79,
});

/** The host command of a managed runtime of `version`. */
export const managedHostCommand = (version) =>
  `"$HOME/.dream/host/versions/${version}/bin/dream-host"`;

/** The archive name for a platform. */
export const runtimeArchiveName = (version, os, arch) =>
  `dream-host-${version}-${os}-${arch}.tar.gz`;

// Normalizes `uname` into the archive's os and arch (overridable for tests).
const PLATFORM_SCRIPT = `
os="\${DREAM_HOST_OS:-}"
arch="\${DREAM_HOST_ARCH:-}"
if [ -z "$os" ]; then
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "Unsupported system: $(uname -s)" >&2; exit ${INSTALL_EXIT.unsupported} ;;
  esac
fi
if [ -z "$arch" ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "Unsupported machine: $(uname -m)" >&2; exit ${INSTALL_EXIT.unsupported} ;;
  esac
fi
`;

/** Prints `<os> <arch>`, as the archive names them. */
export const buildPlatformScript = () =>
  `${PLATFORM_SCRIPT}\necho "$os $arch"\n`;

/** `{ os, arch }` from buildPlatformScript's output, or null. */
export const parsePlatform = (output) => {
  const [os, arch] = String(output).trim().split(/\s+/);
  return os && arch ? { arch, os } : null;
};

/**
 * The install script, run with `sh -c` on the host.
 * @param {{ version: string, baseUrl?: string, uploaded?: string | null }} options
 *   `uploaded`: a path on the host (relative to its home) where this
 *   machine uploaded the archive, its checksums beside it as `<path>.sums`;
 *   the host downloads them itself otherwise.
 */
export const buildInstallScript = ({
  version,
  baseUrl = `${RUNTIME_RELEASES_URL}/v${version}`,
  uploaded = null,
}) => `set -eu
version=${quoteShellWord(version)}
base_url=${quoteShellWord(baseUrl)}
uploaded=${quoteShellWord(uploaded ?? "")}
root="$HOME/.dream/host/versions"
dir="$root/$version"
if [ -f "$dir/.install-complete" ]; then echo installed; exit 0; fi
${PLATFORM_SCRIPT}
name="dream-host-$version-$os-$arch.tar.gz"
mkdir -p "$root"
lock="$root/.lock-$version"
if ! mkdir "$lock" 2>/dev/null; then
  i=0
  while [ "$i" -lt 120 ]; do
    if [ -f "$dir/.install-complete" ]; then echo installed; exit 0; fi
    [ -d "$lock" ] || break
    sleep 1
    i=$((i + 1))
  done
  mkdir "$lock" 2>/dev/null || { echo "Another install is running." >&2; exit ${INSTALL_EXIT.busy}; }
fi
stage="$(mktemp -d "$root/.stage-XXXXXX")"
trap 'rm -rf "$stage" "$lock"' EXIT
if [ -n "$uploaded" ]; then
  case "$uploaded" in /*) ;; *) uploaded="$HOME/$uploaded" ;; esac
  mv "$uploaded" "$stage/$name"
  mv "$uploaded.sums" "$stage/SHA256SUMS"
else
  fetch() {
    # DREAM_HOST_NO_DOWNLOAD: never download here (Dream uploads instead).
    if [ -n "\${DREAM_HOST_NO_DOWNLOAD:-}" ]; then return 1
    elif command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
    else return 1
    fi
  }
  if ! fetch "$base_url/$name" "$stage/$name" || ! fetch "$base_url/SHA256SUMS" "$stage/SHA256SUMS"; then
    echo "Could not download $base_url/$name" >&2
    exit ${INSTALL_EXIT.download}
  fi
fi
expected="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$stage/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$stage/$name" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$stage/$name" | awk '{ print $1 }')"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $name" >&2
  exit ${INSTALL_EXIT.checksum}
fi
mkdir "$stage/runtime"
tar -xzf "$stage/$name" -C "$stage/runtime"
if ! "$stage/runtime/bin/dream-host" version >/dev/null; then
  echo "The host runtime does not run on this machine." >&2
  exit ${INSTALL_EXIT.broken}
fi
rm -rf "$dir"
mv "$stage/runtime" "$dir"
touch "$dir/.install-complete"
running="$(cat "$HOME"/.dream/host/run/p*/host.json 2>/dev/null | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' || true)"
ls -1t "$root" | grep -v '^\\.' | tail -n +4 | while read -r old; do
  [ "$old" = "$version" ] && continue
  printf '%s\\n' "$running" | grep -qx "$old" && continue
  rm -rf "$root/$old"
done
echo installed
`;

/** `sha256` hex of a buffer. */
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * Downloads (or reuses from `cacheDirectory`) the archive and SHA256SUMS of
 * `version` for a platform, here, and checks the archive.
 * @returns {Promise<{ archivePath: string, sumsPath: string, name: string }>}
 */
export async function downloadRuntimeArchive({
  version,
  os,
  arch,
  cacheDirectory,
  baseUrl = `${RUNTIME_RELEASES_URL}/v${version}`,
  fetchImpl = (...args) => fetch(...args),
}) {
  const name = runtimeArchiveName(version, os, arch);
  const directory = path.join(cacheDirectory, version);
  mkdirSync(directory, { recursive: true });
  const archivePath = path.join(directory, name);
  const sumsPath = path.join(directory, `${name}.sums`);

  const download = async (url) => {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Could not download ${url} (${response.status}).`);
    }
    return Buffer.from(await response.arrayBuffer());
  };

  let sums;
  try {
    sums = readFileSync(sumsPath, "utf8");
  } catch {
    sums = (await download(`${baseUrl}/SHA256SUMS`)).toString("utf8");
    writeFileSync(sumsPath, sums);
  }
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name || file === `*${name}`)?.[0];
  if (!expected) {
    throw new Error(`The release lists no ${name}.`);
  }

  let archive;
  try {
    archive = readFileSync(archivePath);
    if (sha256(archive) !== expected) archive = null;
  } catch {
    archive = null;
  }
  if (!archive) {
    archive = await download(`${baseUrl}/${name}`);
    if (sha256(archive) !== expected) {
      throw new Error(`Checksum mismatch for ${name}.`);
    }
    writeFileSync(archivePath, archive);
  }
  return { archivePath, name, sumsPath };
}
