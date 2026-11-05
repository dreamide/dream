// Connects to an SSH host's Dream daemon the way the app does, from a
// terminal, and reports what answered. Prompts (passwords, 2FA, host keys)
// are asked here.
//
//   pnpm ssh-host-check <target> [--runtime <version>]
//
// Like the app, it runs the host runtime of a version installed in
// ~/.dream/host/versions/ (installing a released one if it is missing). The
// default is `dev`, a development build's, which `pnpm host:install-dev
// <target>` puts there.
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DEV_RUNTIME_VERSION } from "../electron/ssh/host-install.js";
import { createSshHostManager } from "../electron/ssh/ssh-hosts.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    runtime: { type: "string" },
    "ssh-path": { type: "string" },
  },
});
const [target] = positionals;
if (!target) {
  console.error("Usage: pnpm ssh-host-check <target> [--runtime <version>]");
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
  runtimeVersion: values.runtime ?? DEV_RUNTIME_VERSION,
  sshPath: values["ssh-path"],
  stateDirectory: path.join(os.homedir(), ".dream", "ssh"),
});

try {
  const endpoint = await hosts.connect({ target });
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
