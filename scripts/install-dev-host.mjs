// Installs a development build of Dream's host runtime on an SSH host, from
// this working tree. A development build of Dream has no published runtime
// to download, so its managed SSH hosts use the version "dev"
// (~/.dream/host/versions/dev/), which this puts there:
//
//   pnpm host:install-dev <ssh target>      e.g. root@203.0.113.10, devbox
//
// The tree (tracked and untracked files git does not ignore) is copied over
// ssh and built on the host, because node-pty has to be compiled for it.
// The host needs Node.js 22 or newer, pnpm (or corepack), and a C++
// toolchain (make, python3, g++ 10+). A running host daemon is stopped so the
// next connection starts the new build. One ssh connection, so one
// password prompt.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_RUNTIME_VERSION } from "../electron/ssh/host-install.js";
import { quoteShellWord } from "../electron/ssh/ssh-args.js";

const target = process.argv[2];
if (!target || target.startsWith("-")) {
  console.error("Usage: pnpm host:install-dev <ssh target>");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REMOTE_SCRIPT = `set -eu
src="$HOME/.dream/host/dev-src"
root="$HOME/.dream/host/versions"
dir="$root/${DEV_RUNTIME_VERSION}"
mkdir -p "$src" "$root"
tar -xzf - -C "$src"
cd "$src"

# A command over ssh gets neither an interactive nor a login shell, so Node
# from a version manager (nvm, fnm, volta, asdf: set up in ~/.bashrc or
# ~/.zshrc) is not on PATH here. Take PATH from an interactive login shell,
# as Dream's host does for agent CLIs (electron/api/shared/cli.js).
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}
if ! node_ok; then
  run_shell="\${SHELL:-/bin/sh}"
  if command -v timeout >/dev/null 2>&1; then run_shell="timeout 10 $run_shell"; fi
  marked="$($run_shell -ilc 'printf "__DREAM_PATH__%s__DREAM_PATH__" "$PATH"' </dev/null 2>/dev/null || true)"
  case "$marked" in
    *__DREAM_PATH__*__DREAM_PATH__*)
      login_path="\${marked#*__DREAM_PATH__}"
      login_path="\${login_path%%__DREAM_PATH__*}"
      if [ -n "$login_path" ]; then PATH="$login_path:$PATH"; fi
      ;;
  esac
fi
# nvm without a shell that loads it: source it here.
if ! node_ok && [ -s "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  set +eu
  . "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1
  nvm use default >/dev/null 2>&1
  set -eu
fi
export PATH
if ! node_ok; then
  echo "Dream's host needs Node.js 22 or newer on this machine (found: $(node -v 2>/dev/null || echo none))." >&2
  exit 1
fi
echo "Using Node.js $(node -v) at $(command -v node)"
if command -v pnpm >/dev/null 2>&1; then pnpm="pnpm"
elif command -v corepack >/dev/null 2>&1; then pnpm="corepack pnpm"
else
  echo "pnpm is needed on this machine (npm install -g pnpm)." >&2
  exit 1
fi

# node-pty has no prebuilt binary for Linux: it is compiled here, against
# Node's headers, which need a C++20 compiler (g++ 10 or newer; Ubuntu
# 20.04's default g++ is 9).
for tool in make python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is needed to build node-pty (Debian/Ubuntu: apt install build-essential python3 g++-10)." >&2
    exit 1
  fi
done
if [ -z "\${CXX:-}" ]; then
  cxx=""
  for candidate in g++ g++-14 g++-13 g++-12 g++-11 g++-10; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    major="$("$candidate" -dumpversion 2>/dev/null | cut -d. -f1)"
    case "$major" in ''|*[!0-9]*) continue ;; esac
    if [ "$major" -ge 10 ]; then cxx="$candidate"; break; fi
  done
  if [ -z "$cxx" ]; then
    found="none"
    if command -v g++ >/dev/null 2>&1; then found="g++ $(g++ -dumpversion)"; fi
    echo "node-pty needs g++ 10 or newer to build (found: $found). Debian/Ubuntu: apt install build-essential python3 g++-10" >&2
    exit 1
  fi
  export CXX="$cxx"
  case "$cxx" in
    g++-*)
      if command -v "gcc-\${cxx#g++-}" >/dev/null 2>&1; then export CC="gcc-\${cxx#g++-}"; fi
      ;;
  esac
  echo "Building node-pty with $cxx"
fi

echo "Installing dependencies on the host..."
ELECTRON_SKIP_BINARY_DOWNLOAD=1 $pnpm install --frozen-lockfile
stage="$root/.stage-${DEV_RUNTIME_VERSION}"
node scripts/build-host-runtime.mjs --out "$stage"
"$stage/bin/dream-host" version >/dev/null

# The running daemon (whichever build) stops; the next connection starts
# this one.
if [ -x "$dir/bin/dream-host" ]; then "$dir/bin/dream-host" stop >/dev/null 2>&1 || true; fi
rm -rf "$dir"
mv "$stage" "$dir"
touch "$dir/.install-complete"
echo "Installed Dream's development host runtime in $dir"
`;

// What to copy: the files git knows, less what it ignores (node_modules,
// build output), listed for tar.
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter(Boolean);
const listDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-dev-host-"));
const list = path.join(listDirectory, "files.txt");
writeFileSync(list, `${files.join("\n")}\n`);

console.log(`Copying ${files.length} files to ${target} and building there...`);

const tar = spawn("tar", ["-czf", "-", "-T", list], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
const ssh = spawn("ssh", [target, `sh -c ${quoteShellWord(REMOTE_SCRIPT)}`], {
  stdio: [tar.stdout, "inherit", "inherit"],
});

const exitCode = await new Promise((resolve) => {
  ssh.on("error", (error) => {
    console.error(`Could not run ssh: ${error.message}`);
    resolve(1);
  });
  ssh.on("exit", (code) => resolve(code ?? 1));
});
tar.kill();
rmSync(listDirectory, { force: true, recursive: true });

if (exitCode === 0) {
  console.log(
    `\nDone. In Dream (a development build), leave this host's Host command empty and connect.`,
  );
}
process.exit(exitCode);
