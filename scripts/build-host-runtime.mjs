// Builds the host runtime for this machine's platform: what an SSH host runs
// as Dream's host (electron/host/dream-host.js), needing nothing installed
// there. The release workflow runs it on each target platform's own runner.
//
//   out/
//     bin/dream-host            launcher (dream-host.cmd on Windows)
//     node/                     the Node that runs it (this build's own)
//     lib/dream-host.js         the host, bundled (ESM)
//     lib/persisted-state-worker.js   its state-writing worker thread
//     lib/drizzle/              the database migrations
//     node_modules/node-pty/    the one native addon, this platform's build
//     VERSION
//
//   node scripts/build-host-runtime.mjs [--out dir] [--archive]
//
// With --archive it also writes dream-host-<version>-<os>-<arch>.tar.gz next
// to the output folder. Agent CLIs (claude, codex, opencode) are not part of
// it: the host runs whichever ones are installed on its machine.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { values } = parseArgs({
  options: {
    archive: { type: "boolean" },
    out: { type: "string" },
  },
});

const version = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const platform = process.platform;
const arch = process.arch;
const out = path.resolve(values.out ?? path.join(root, "release", "host"));
const lib = path.join(out, "lib");

rmSync(out, { force: true, recursive: true });
mkdirSync(lib, { recursive: true });

// 1. The host and its worker, bundled. node-pty stays a real package: its
// native build is loaded from disk. An ESM bundle still contains CommonJS
// dependencies that call require(), so it gets one.
await build({
  banner: {
    js: 'import { createRequire as __dreamCreateRequire } from "node:module"; const require = __dreamCreateRequire(import.meta.url);',
  },
  bundle: true,
  define: { __DREAM_HOST_VERSION__: JSON.stringify(version) },
  entryPoints: {
    "dream-host": path.join(root, "electron/host/dream-host.js"),
    "persisted-state-worker": path.join(
      root,
      "electron/persisted-state-worker.js",
    ),
  },
  external: ["node-pty", "electron"],
  format: "esm",
  logLevel: "warning",
  outdir: lib,
  platform: "node",
  splitting: true,
  target: "node22",
});
writeFileSync(
  path.join(lib, "package.json"),
  `${JSON.stringify({ type: "module" })}\n`,
);

// 2. Migrations, where persisted-state.js looks for them (beside itself).
cpSync(path.join(root, "electron/drizzle"), path.join(lib, "drizzle"), {
  recursive: true,
});

// 3. node-pty: its JavaScript and this platform's native build only.
const ptyRoot = path.dirname(require.resolve("node-pty/package.json"));
const ptyOut = path.join(out, "node_modules", "node-pty");
mkdirSync(ptyOut, { recursive: true });
copyFileSync(
  path.join(ptyRoot, "package.json"),
  path.join(ptyOut, "package.json"),
);
cpSync(path.join(ptyRoot, "lib"), path.join(ptyOut, "lib"), {
  recursive: true,
});
const prebuild = path.join(ptyRoot, "prebuilds", `${platform}-${arch}`);
const compiled = path.join(ptyRoot, "build", "Release");
if (existsSync(prebuild)) {
  cpSync(prebuild, path.join(ptyOut, "prebuilds", `${platform}-${arch}`), {
    recursive: true,
  });
}
if (existsSync(compiled)) {
  cpSync(compiled, path.join(ptyOut, "build", "Release"), {
    filter: (source) => !source.endsWith(".pdb") && !source.includes(".deps"),
    recursive: true,
  });
}
if (!existsSync(prebuild) && !existsSync(compiled)) {
  throw new Error(`node-pty has no native build for ${platform}-${arch}.`);
}

// 4. The Node that runs it: this build's own.
const nodeOut = path.join(out, "node");
mkdirSync(nodeOut, { recursive: true });
const nodeBinary = path.join(
  nodeOut,
  platform === "win32" ? "node.exe" : "node",
);
copyFileSync(process.execPath, nodeBinary);
if (platform !== "win32") chmodSync(nodeBinary, 0o755);

// 5. The launcher.
const bin = path.join(out, "bin");
mkdirSync(bin, { recursive: true });
if (platform === "win32") {
  writeFileSync(
    path.join(bin, "dream-host.cmd"),
    '@"%~dp0..\\node\\node.exe" "%~dp0..\\lib\\dream-host.js" %*\r\n',
  );
} else {
  const launcher = path.join(bin, "dream-host");
  writeFileSync(
    launcher,
    '#!/bin/sh\nDIR=$(cd "$(dirname "$0")/.." && pwd)\nexec "$DIR/node/node" "$DIR/lib/dream-host.js" "$@"\n',
  );
  chmodSync(launcher, 0o755);
}
writeFileSync(path.join(out, "VERSION"), `${version}\n`);

console.log(`Host runtime ${version} for ${platform}-${arch} in ${out}`);

// 6. The archive the app installs on a host.
if (values.archive) {
  const os = platform === "win32" ? "windows" : platform;
  const archive = path.join(
    path.dirname(out),
    `dream-host-${version}-${os}-${arch}.tar.gz`,
  );
  execFileSync("tar", ["-czf", archive, "-C", out, "."], { stdio: "inherit" });
  console.log(archive);
}
