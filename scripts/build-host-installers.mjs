// Builds what installs the host runtime with one command, for this app's
// version. The release workflow publishes them with the runtimes:
//
//   release/npm/dream-host/        the npm package `dream-host`
//                                  (`npx dream-host <command>`): the
//                                  launcher of scripts/npm-launcher/
//   release/install-host.sh        `curl -fsSL …/install-host.sh | sh`
//   release/install-host.ps1       `irm …/install-host.ps1 | iex`
//
//   node scripts/build-host-installers.mjs [--out dir] [--version x.y.z]
//
// Both scripts install into ~/.dream/host/versions/<version>/, as an SSH
// install and the npm launcher do, verify the archive against the release's
// SHA256SUMS, and put a `dream-host` command on PATH. The shell script's
// install step is scripts/npm-launcher/install-host.js.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildInstallScript,
  RUNTIME_RELEASES_URL,
} from "./npm-launcher/install-host.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    version: { type: "string" },
  },
});
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = values.version ?? manifest.version;
if (!/^\d+\.\d+\.\d+([-.+][\w.-]+)?$/.test(version)) {
  throw new Error(`Not a release version: ${version}`);
}
const out = path.resolve(values.out ?? path.join(root, "release"));

// 1. The npm package.
const npm = path.join(out, "npm", "dream-host");
rmSync(npm, { force: true, recursive: true });
mkdirSync(path.join(npm, "bin"), { recursive: true });
mkdirSync(path.join(npm, "lib"), { recursive: true });
copyFileSync(
  path.join(root, "scripts", "npm-launcher", "dream-host.js"),
  path.join(npm, "lib", "launcher.js"),
);
writeFileSync(
  path.join(npm, "bin", "dream-host.js"),
  '#!/usr/bin/env node\nimport { main } from "../lib/launcher.js";\n\nawait main();\n',
);
writeFileSync(
  path.join(npm, "package.json"),
  `${JSON.stringify(
    {
      bin: { "dream-host": "bin/dream-host.js" },
      description:
        "Run the Dream host (agents, terminals and git for Dream clients) on this machine.",
      engines: { node: ">=20.11" },
      files: ["bin", "lib"],
      homepage: "https://github.com/dreamide/dream",
      license: manifest.license ?? "UNLICENSED",
      name: "dream-host",
      repository: {
        type: "git",
        url: "git+https://github.com/dreamide/dream.git",
      },
      type: "module",
      version,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  path.join(npm, "README.md"),
  `# dream-host

Runs the Dream host on this machine: the process that owns projects, chats,
agent CLIs, terminals and git for Dream's desktop and browser clients.

\`\`\`sh
npx dream-host@${version} serve --pair
\`\`\`

The first run downloads the host runtime of this version for your platform
from the Dream GitHub release, checks it against the release's SHA256SUMS and
installs it in \`~/.dream/host/versions/${version}/\`. Every command after that
runs it directly. To keep it running, run it under your service manager.
`,
);

// 2. The shell installer: the install script, then a command on PATH. Its version can be chosen with an argument or DREAM_HOST_VERSION.
const PLACEHOLDER = "0.0.0-dream-installer";
const body = buildInstallScript({ version: PLACEHOLDER })
  .replace(`version='${PLACEHOLDER}'`, 'version="$DREAM_HOST_INSTALL_VERSION"')
  .replace(
    `base_url='${RUNTIME_RELEASES_URL}/v${PLACEHOLDER}'`,
    `base_url="\${DREAM_HOST_RELEASES_URL:-${RUNTIME_RELEASES_URL}/v$version}"`,
  );
if (body.includes(PLACEHOLDER)) {
  throw new Error("The install script changed shape; update this build.");
}
writeFileSync(
  path.join(out, "install-host.sh"),
  `#!/bin/sh
# Installs the Dream host runtime (dream-host) for this machine.
#
#   curl -fsSL https://github.com/dreamide/dream/releases/download/v${version}/install-host.sh | sh
#   sh install-host.sh [version]
#
# It goes in ~/.dream/host/versions/<version>/ (checked against the
# release's SHA256SUMS), and dream-host is linked into ~/.local/bin, or
# DREAM_HOST_BIN_DIR.
set -eu
DREAM_HOST_INSTALL_VERSION="\${1:-\${DREAM_HOST_VERSION:-${version}}}"
export DREAM_HOST_INSTALL_VERSION
(
${body})
version="$DREAM_HOST_INSTALL_VERSION"
bin_dir="\${DREAM_HOST_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
ln -sf "$HOME/.dream/host/versions/$version/bin/dream-host" "$bin_dir/dream-host"
echo "dream-host $version is installed as $bin_dir/dream-host."
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to your PATH to run it by name." ;;
esac
`,
  { mode: 0o755 },
);

// 3. The PowerShell installer.
writeFileSync(
  path.join(out, "install-host.ps1"),
  readFileSync(
    path.join(root, "scripts", "npm-launcher", "install-host.ps1"),
    "utf8",
  ).replaceAll("__DREAM_HOST_VERSION__", version),
);

console.log(`Host installers ${version} in ${out}`);
