// Connects to an SSH host's Dream daemon the way the app does, from a
// terminal, and reports what answered. Prompts (passwords, 2FA, host keys)
// are asked here.
//
//   pnpm ssh-host-check <target> [--host-command "<how to run dream-host>"]
//
// The host needs dream-host runnable, e.g. a checkout of this repo with
// `--host-command "node ~/dream/electron/host/dream-host.js"`.
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createSshHostManager } from "../electron/ssh/ssh-hosts.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "host-command": { type: "string" },
    "ssh-path": { type: "string" },
  },
});
const [target] = positionals;
if (!target) {
  console.error(
    'Usage: pnpm ssh-host-check <target> [--host-command "dream-host"]',
  );
  process.exit(2);
}

const readline = createInterface({
  input: process.stdin,
  output: process.stderr,
});
const hosts = createSshHostManager({
  onPrompt: async ({ message }) =>
    (await readline.question(`${message} `)) || null,
  onStatus: (status) =>
    console.error(`[${status.state}]${status.error ? ` ${status.error}` : ""}`),
  sshPath: values["ssh-path"],
  stateDirectory: path.join(os.homedir(), ".dream", "ssh"),
});

try {
  const endpoint = await hosts.connect({
    hostCommand: values["host-command"],
    target,
  });
  const info = await (
    await fetch(`${endpoint.baseUrl}/api/host-info`, {
      headers: { "x-dream-api-token": endpoint.token },
    })
  ).json();
  console.log(JSON.stringify({ baseUrl: endpoint.baseUrl, info }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  readline.close();
  await hosts.disconnectAll();
}
