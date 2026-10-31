// The host runtime's shell install script, run by sh against a local
// "release" (a fake runtime archive and its SHA256SUMS).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import getPort from "get-port";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildInstallScript, INSTALL_EXIT } from "./install-host.js";

const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const VERSION = "9.9.9";
const NAME = `dream-host-${VERSION}-linux-x64.tar.gz`;

// sh on Windows (Git Bash) wants /c/... paths: its tar reads "C:" as a host.
const shPath = (value) =>
  process.platform === "win32"
    ? value
        .replace(/^([A-Za-z]):/, (_m, drive) => `/${drive.toLowerCase()}`)
        .replaceAll("\\", "/")
    : value;

let server = null;
let baseUrl = null;
let serveBadSums = false;

beforeAll(async () => {
  if (!hasSh) return;
  // A runtime whose dream-host only answers `version`. tar works on paths
  // relative to one folder (Windows' Git tar reads "C:" as a host).
  const base = mkdtempSync(path.join(os.tmpdir(), "dream-release-"));
  const runtime = path.join(base, "runtime");
  const release = path.join(base, "release");
  mkdirSync(path.join(runtime, "bin"), { recursive: true });
  mkdirSync(release);
  const launcher = path.join(runtime, "bin", "dream-host");
  writeFileSync(
    launcher,
    `#!/bin/sh
echo '{"hostProtocolVersion":1,"version":"${VERSION}"}'
`,
  );
  chmodSync(launcher, 0o755);
  spawnSync("tar", ["-czf", `release/${NAME}`, "-C", "runtime", "."], {
    cwd: base,
  });
  const archive = readFileSync(path.join(release, NAME));
  const sums = `${createHash("sha256").update(archive).digest("hex")}  ${NAME}\n`;

  server = http.createServer((request, response) => {
    if (request.url === `/v${VERSION}/${NAME}`) {
      response.end(archive);
    } else if (request.url === `/v${VERSION}/SHA256SUMS`) {
      response.end(serveBadSums ? `${"0".repeat(64)}  ${NAME}\n` : sums);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  const port = await getPort({ host: "127.0.0.1" });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${port}/v${VERSION}`;
});

afterAll(() => server?.close());

const runScript = (home, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn(
      "sh",
      ["-c", buildInstallScript({ baseUrl, version: VERSION })],
      {
        env: {
          ...process.env,
          DREAM_HOST_ARCH: "x64",
          DREAM_HOST_OS: "linux",
          HOME: shPath(home),
          ...extraEnv,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });

const installed = (home) =>
  existsSync(
    path.join(home, ".dream", "host", "versions", VERSION, ".install-complete"),
  );

test.skipIf(!hasSh)(
  "the host downloads, checks and installs the runtime once",
  { timeout: 60_000 },
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "dream-install-home-"));

    const first = await runScript(home);
    expect(first.stderr).toBe("");
    expect(first.stdout.trim()).toBe("installed");
    expect(installed(home)).toBe(true);

    // Again: already there, nothing downloaded.
    serveBadSums = true;
    try {
      expect((await runScript(home)).code).toBe(0);
    } finally {
      serveBadSums = false;
    }
  },
);

test.skipIf(!hasSh)(
  "a runtime that does not match its checksum is not installed",
  { timeout: 60_000 },
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "dream-install-home-"));
    serveBadSums = true;
    try {
      const result = await runScript(home);
      expect(result.code).toBe(INSTALL_EXIT.checksum);
      expect(installed(home)).toBe(false);
    } finally {
      serveBadSums = false;
    }
  },
);
