// The askpass round trip: ssh runs the helper, the helper asks the server,
// the server asks Dream.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { startAskpassServer } from "./askpass-server.js";

let server = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const start = async (onPrompt) => {
  server = await startAskpassServer({
    directory: mkdtempSync(path.join(os.tmpdir(), "dream-askpass-")),
    onPrompt,
  });
  return server;
};

// Asynchronous: the server answering lives in this same process.
const runHelper = (env, prompt) =>
  new Promise((resolve) => {
    const child = spawn(
      env.DREAM_ASKPASS_NODE,
      [env.DREAM_ASKPASS_SCRIPT, prompt],
      { env: { ...process.env, ...env } },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout }));
  });

test("answers a prompt with what Dream says", async () => {
  const prompts = [];
  const { env } = await start(async (prompt) => {
    prompts.push(prompt);
    return "hunter2";
  });

  const result = await runHelper(env, "me@box's password:");

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("hunter2\n");
  expect(prompts).toEqual([{ kind: "secret", message: "me@box's password:" }]);
  expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
});

test("a host-key question is a confirmation", async () => {
  let kind = null;
  const { env } = await start(async (prompt) => {
    kind = prompt.kind;
    return "yes";
  });

  await runHelper(
    env,
    "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
  );

  expect(kind).toBe("confirm");
});

test("a declined prompt makes the helper fail", async () => {
  const { env } = await start(async () => null);
  expect((await runHelper(env, "Password:")).status).toBe(1);
});

test("the helper cannot ask without the secret", async () => {
  let asked = false;
  const { env } = await start(async () => {
    asked = true;
    return "x";
  });

  const result = await runHelper(
    { ...env, DREAM_ASKPASS_SECRET: "wrong" },
    "P:",
  );

  expect(result.status).toBe(1);
  expect(asked).toBe(false);
});
