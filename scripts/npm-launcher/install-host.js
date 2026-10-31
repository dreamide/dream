// The shell install script of the host runtime, which install-host.sh
// (scripts/build-host-installers.mjs) is built from. It installs per version
// under ~/.dream/host/versions/<version>/, so a new version installs beside
// the one a running daemon uses: it downloads its platform's archive and
// SHA256SUMS (curl or wget), checks the checksum, unpacks into a staging
// folder, runs `dream-host version`, then moves it into place and marks it
// complete. A lock keeps two installs from racing. Old versions are removed,
// keeping this one and the two newest others, never one a running daemon
// reports. The npm launcher (dream-host.js) and install-host.ps1 install the
// same way.

/** Quotes one word for a POSIX shell. */
const quoteShellWord = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

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

/**
 * The install script, run with `sh -c`.
 * @param {{ version: string, baseUrl?: string }} options
 */
export const buildInstallScript = ({
  version,
  baseUrl = `${RUNTIME_RELEASES_URL}/v${version}`,
}) => `set -eu
version=${quoteShellWord(version)}
base_url=${quoteShellWord(baseUrl)}
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
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else return 1
  fi
}
if ! fetch "$base_url/$name" "$stage/$name" || ! fetch "$base_url/SHA256SUMS" "$stage/SHA256SUMS"; then
  echo "Could not download $base_url/$name" >&2
  exit ${INSTALL_EXIT.download}
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
