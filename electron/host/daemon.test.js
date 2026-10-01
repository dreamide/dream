// The daemon command line end to end: a real detached daemon in a temporary
// home, started, reused, inspected and stopped.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { API_SESSION_TOKEN_HEADER } from "../api/shared/session-token.js";
import { EXIT_NOT_RUNNING, runDaemonCli } from "./daemon.js";

const home = mkdtempSync(path.join(os.tmpdir(), "dream-host-daemon-"));

const run = async (...argv) => {
  let output = "";
  const sink = {
    write: (text) => {
      output += text;
    },
  };
  const code = await runDaemonCli([...argv, "--home", home], {
    stderr: sink,
    stdout: sink,
  });
  const lines = output.trim().split("\n").filter(Boolean);
  return { code, result: lines.length ? JSON.parse(lines.at(-1)) : null };
};

afterAll(async () => {
  await run("stop");
});

test("ensure starts a daemon once, then reuses it until stopped", {
  timeout: 60_000,
}, async () => {
  expect((await run("status")).code).toBe(EXIT_NOT_RUNNING);

  const first = await run("ensure", "--idle-timeout", "0");
  expect(first.code).toBe(0);
  expect(first.result).toMatchObject({ hostProtocolVersion: 1, reused: false });
  expect(first.result.token).toMatch(/^[0-9a-f]{64}$/);

  const second = await run("ensure");
  expect(second.result).toMatchObject({
    pid: first.result.pid,
    port: first.result.port,
    reused: true,
  });

  const info = await fetch(
    `http://127.0.0.1:${first.result.port}/api/host-info`,
    { headers: { [API_SESSION_TOKEN_HEADER]: first.result.token } },
  );
  expect(await info.json()).toMatchObject({
    capabilities: ["host-socket"],
    hostProtocolVersion: 1,
    pid: first.result.pid,
  });

  const status = await run("status");
  expect(status.result).toMatchObject({ running: true, pid: first.result.pid });
  expect(status.result.token).toBeUndefined();

  const stopped = await run("stop");
  expect(stopped.result).toMatchObject({ stopped: true });
  expect((await run("status")).code).toBe(EXIT_NOT_RUNNING);
});
