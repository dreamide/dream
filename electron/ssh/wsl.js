// A WSL distribution as a host, on Windows. It is an SSH route whose target
// is `wsl:<distribution>`: the same saved connection, identity pinning,
// managed runtime install and reconnects as an SSH host, with `wsl.exe` in
// place of `ssh`:
//
//   scripts       wsl.exe -d <distribution> --exec sh -c <script>
//   ensure        the same, through the user's login shell (as over SSH)
//   the link      wsl.exe running `cat >/dev/null` with stdin piped from
//                 Dream: it keeps the distribution running (WSL stops one
//                 with no wsl.exe attached), and ends when Dream does.
//   ports         none forwarded: WSL forwards a distribution's loopback
//                 ports to Windows' own (localhostForwarding, on by default,
//                 or mirrored networking), so the host's port is the same
//                 number here.
//
// Pure apart from `listWslDistributions`, which runs wsl.exe.
import { spawn } from "node:child_process";
import { buildEnsureCommand } from "./ssh-args.js";

export const WSL_TARGET_PREFIX = "wsl:";
export const WSL_PROGRAM = "wsl.exe";

const DISTRIBUTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The distribution a `wsl:<name>` target names, or null. */
export const parseWslTarget = (target) => {
  if (typeof target !== "string" || !target.startsWith(WSL_TARGET_PREFIX)) {
    return null;
  }
  const name = target.slice(WSL_TARGET_PREFIX.length).trim();
  return DISTRIBUTION_NAME.test(name) ? name : null;
};

/** `linuxPath` in `distribution`, as Windows sees it. */
export const wslWindowsPath = (distribution, linuxPath) =>
  `\\\\wsl.localhost\\${distribution}${String(linuxPath).replaceAll("/", "\\")}`;

/** The target that names `distribution`. */
export const wslTarget = (distribution) =>
  `${WSL_TARGET_PREFIX}${distribution}`;

const inDistribution = (distribution, command) => [
  "-d",
  distribution,
  "--exec",
  "sh",
  "-c",
  command,
];

/** Runs the daemon command, through the user's login shell. */
export const buildWslEnsureArgs = ({ distribution, hostCommand }) =>
  // `sh -c <login shell script> sh <command>`, as over SSH.
  inDistribution(distribution, buildEnsureCommand(hostCommand));

/** Runs a POSIX shell script in the distribution. */
export const buildWslScriptArgs = ({ distribution, script }) =>
  inDistribution(distribution, script);

/** Writes stdin to `remotePath` (relative to the distribution's home). */
export const buildWslUploadArgs = ({ distribution, remotePath }) => {
  if (!/^[\w./-]+$/.test(remotePath) || remotePath.includes("..")) {
    throw new Error(`Unsafe upload path: ${remotePath}`);
  }
  const directory = remotePath.split("/").slice(0, -1).join("/");
  return inDistribution(
    distribution,
    `mkdir -p "$HOME/${directory}" && cat > "$HOME/${remotePath}"`,
  );
};

/** The link: holds the distribution running until Dream ends. */
export const buildWslHoldArgs = ({ distribution }) =>
  inDistribution(distribution, "cat >/dev/null");

/**
 * wsl.exe's own output (not a distribution's) is UTF-16 unless WSL_UTF8 is
 * set; read either.
 * @param {Buffer} buffer
 */
export const decodeWslOutput = (buffer) => {
  const utf16 =
    buffer.length >= 2 &&
    (buffer.includes(0) || (buffer[0] === 0xff && buffer[1] === 0xfe));
  return (utf16 ? buffer.toString("utf16le") : buffer.toString("utf8"))
    .replace(/^﻿/, "")
    .replaceAll("\0", "");
};

/** The distribution names in `wsl.exe --list --quiet` output. */
export const parseWslDistributions = (text) =>
  String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => DISTRIBUTION_NAME.test(name));

/**
 * The installed WSL distributions, or [] (not Windows, no WSL, or it did not
 * answer in time).
 */
export const listWslDistributions = ({
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = 5_000,
} = {}) =>
  platform !== "win32"
    ? Promise.resolve([])
    : new Promise((resolve) => {
        let child;
        try {
          child = spawnProcess(WSL_PROGRAM, ["--list", "--quiet"], {
            env: { ...process.env, WSL_UTF8: "1" },
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          });
        } catch {
          resolve([]);
          return;
        }
        const chunks = [];
        const timer = setTimeout(() => {
          child.kill();
          resolve([]);
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => chunks.push(chunk));
        child.once("error", () => {
          clearTimeout(timer);
          resolve([]);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(
            code === 0
              ? parseWslDistributions(decodeWslOutput(Buffer.concat(chunks)))
              : [],
          );
        });
      });
