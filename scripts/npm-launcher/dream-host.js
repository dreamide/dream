// `npx dream-host <command>`: the npm package `dream-host`, a launcher with
// no dependencies. It installs the host runtime of its own version for this
// machine (scripts/build-host-runtime.mjs builds it; each GitHub release
// carries one per platform and their SHA256SUMS), then runs it with the
// arguments given:
//
//   npx dream-host serve --pair
//   npx dream-host service install
//
// The runtime goes where an SSH install puts it, ~/.dream/host/versions/
// <version>/, so a machine has one copy whichever way it got there. A
// download is checked against SHA256SUMS before anything is unpacked, and
// the unpacked runtime must run (`dream-host version`) before it is moved
// into place. A lock keeps two installs of one version from racing.
//
// Environment: DREAM_HOST_RELEASES_URL replaces the release's download URL
// (a mirror, or a test server); DREAM_HOST_RUNTIME_ROOT replaces
// ~/.dream/host/versions.
//
// scripts/build-npm-launcher.mjs packages this file as lib/launcher.js, with
// a bin/dream-host.js that calls `main` and a package.json of the version.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const RELEASES_URL =
  "https://github.com/dreamide/dream/releases/download";

/** The platforms a release has a runtime for, as its archives name them. */
export const SUPPORTED_TARGETS = Object.freeze([
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
]);

const COMPLETE_MARKER = ".install-complete";
const LOCK_WAIT_MS = 120_000;

export class LauncherError extends Error {}

/** This machine as a runtime archive names it, or null when none is built. */
export const runtimeTarget = (platform, arch) => {
  const system = platform === "win32" ? "windows" : platform;
  const target = `${system}-${arch}`;
  return SUPPORTED_TARGETS.includes(target) ? { arch, os: system } : null;
};

export const archiveName = (version, { os: system, arch }) =>
  `dream-host-${version}-${system}-${arch}.tar.gz`;

/** The checksum SHA256SUMS lists for `name`, or null. */
export const expectedChecksum = (sums, name) => {
  for (const line of String(sums).split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === name || file === `*${name}`) return hash.toLowerCase();
  }
  return null;
};

export const runtimeRoot = (env = process.env) =>
  env.DREAM_HOST_RUNTIME_ROOT?.trim() ||
  path.join(os.homedir(), ".dream", "host", "versions");

/** How to run the runtime in `directory`: its own Node on its entry point. */
export const runtimeCommand = (directory, platform = process.platform) => ({
  program: path.join(
    directory,
    "node",
    platform === "win32" ? "node.exe" : "node",
  ),
  script: path.join(directory, "lib", "dream-host.js"),
});

/**
 * The system's tar: on Windows its own bsdtar, never a GNU tar on PATH (Git
 * Bash's), which reads `C:\...` as a remote host.
 */
const tarProgram = (platform) =>
  platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const download = async (fetchImpl, url) => {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new LauncherError(`Could not download ${url}: ${error.message}`);
  }
  if (!response.ok) {
    throw new LauncherError(
      `Could not download ${url}: the server answered ${response.status}.`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
};

/**
 * Installs the runtime of `version` unless it is installed already;
 * resolves with its directory.
 * @param {{
 *   version: string,
 *   baseUrl?: string,
 *   root?: string,
 *   platform?: NodeJS.Platform,
 *   arch?: string,
 *   fetchImpl?: typeof fetch,
 *   log?: (line: string) => void,
 *   run?: typeof spawnSync,
 * }} options
 */
export async function installRuntime({
  version,
  baseUrl = `${RELEASES_URL}/v${version}`,
  root = runtimeRoot(),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = (url) => fetch(url),
  log = (line) => process.stderr.write(`${line}\n`),
  run = spawnSync,
}) {
  const directory = path.join(root, version);
  const complete = () => existsSync(path.join(directory, COMPLETE_MARKER));
  if (complete()) return directory;

  const target = runtimeTarget(platform, arch);
  if (!target) {
    throw new LauncherError(
      `No Dream host runtime is built for ${platform}-${arch}. Supported: ${SUPPORTED_TARGETS.join(", ")}.`,
    );
  }

  mkdirSync(root, { recursive: true });
  const lock = path.join(root, `.lock-${version}`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (complete()) return directory;
      if (Date.now() > deadline) {
        throw new LauncherError(
          `Another install of the Dream host ${version} is running (remove ${lock} if it is not).`,
        );
      }
      await sleep(500);
    }
  }

  const stage = mkdtempSync(path.join(root, ".stage-"));
  try {
    if (complete()) return directory;
    const name = archiveName(version, target);
    log(
      `Downloading the Dream host ${version} for ${target.os}-${target.arch}…`,
    );
    const [archive, sums] = await Promise.all([
      download(fetchImpl, `${baseUrl}/${name}`),
      download(fetchImpl, `${baseUrl}/SHA256SUMS`),
    ]);
    const expected = expectedChecksum(sums.toString("utf8"), name);
    const actual = createHash("sha256").update(archive).digest("hex");
    if (!expected || expected !== actual) {
      throw new LauncherError(
        `The download of ${name} does not match its checksum; nothing was installed.`,
      );
    }
    const archivePath = path.join(stage, name);
    writeFileSync(archivePath, archive);
    const unpacked = path.join(stage, "runtime");
    mkdirSync(unpacked);
    const extracted = run(
      tarProgram(platform),
      ["-xzf", archivePath, "-C", unpacked],
      { encoding: "utf8", windowsHide: true },
    );
    if (extracted.status !== 0) {
      throw new LauncherError(
        `Could not unpack ${name}: ${(extracted.stderr || extracted.error?.message || "").trim()}`,
      );
    }
    const { program, script } = runtimeCommand(unpacked, platform);
    const smoke = run(program, [script, "version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (smoke.status !== 0) {
      throw new LauncherError(
        `The Dream host ${version} does not run on this machine: ${(smoke.stderr || smoke.error?.message || "").trim()}`,
      );
    }
    rmSync(directory, { force: true, recursive: true });
    renameSync(unpacked, directory);
    writeFileSync(path.join(directory, COMPLETE_MARKER), "");
    log(`Installed the Dream host ${version} in ${directory}.`);
    return directory;
  } finally {
    rmSync(stage, { force: true, recursive: true });
    try {
      rmdirSync(lock);
    } catch {
      // Already gone.
    }
  }
}

/** Runs the installed runtime with `args`; resolves with its exit code. */
export const runRuntime = (
  directory,
  args,
  { platform = process.platform } = {},
) =>
  new Promise((resolve) => {
    const { program, script } = runtimeCommand(directory, platform);
    const child = spawn(program, [script, ...args], { stdio: "inherit" });
    // The terminal's Ctrl+C reaches the child too; a signal sent to the
    // launcher alone is passed on.
    const forward = (signal) => () => child.kill(signal);
    const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
      const handler = forward(signal);
      process.on(signal, handler);
      return [signal, handler];
    });
    const done = (code) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.once("error", (error) => {
      process.stderr.write(`Could not run the Dream host: ${error.message}\n`);
      done(1);
    });
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });

const readOwnVersion = () =>
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    .version;

/** The launcher: installs this package's version if needed, then runs it. */
export async function main() {
  const version = readOwnVersion();
  try {
    const directory = await installRuntime({
      baseUrl: process.env.DREAM_HOST_RELEASES_URL?.trim() || undefined,
      version,
    });
    process.exitCode = await runRuntime(directory, process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof LauncherError ? error.message : error.stack}\n`,
    );
    process.exitCode = 1;
  }
}
