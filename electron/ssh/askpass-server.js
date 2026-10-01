// Answers ssh's prompts (passwords, 2FA codes, "continue connecting to an
// unknown host?") from inside Dream. ssh runs the askpass helper
// (askpass.js) for each prompt; the helper asks this loopback server, which
// asks Dream's `onPrompt`. A per-server secret keeps other local processes
// from asking (or answering) in Dream's name.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Packaged, ssh's helper runs from the unpacked copy (package.json
// asarUnpack): a plain path outside the archive.
const ASKPASS_SCRIPT = fileURLToPath(
  new URL("./askpass.js", import.meta.url),
).replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
const MAX_PROMPT_BYTES = 16 * 1024;

/**
 * ssh wants SSH_ASKPASS to be one executable with no arguments, so a tiny
 * wrapper runs the helper with Node (or Electron as Node).
 */
function writeAskpassWrapper(directory) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (process.platform === "win32") {
    const wrapper = path.join(directory, "dream-askpass.cmd");
    writeFileSync(
      wrapper,
      '@"%DREAM_ASKPASS_NODE%" "%DREAM_ASKPASS_SCRIPT%" %*\r\n',
    );
    return wrapper;
  }
  const wrapper = path.join(directory, "dream-askpass.sh");
  writeFileSync(
    wrapper,
    '#!/bin/sh\nexec "$DREAM_ASKPASS_NODE" "$DREAM_ASKPASS_SCRIPT" "$@"\n',
  );
  chmodSync(wrapper, 0o700);
  return wrapper;
}

/**
 * @param {{
 *   directory: string,
 *   onPrompt: (prompt: { message: string, kind: "secret" | "confirm" }) =>
 *     Promise<string | null>,
 * }} options
 *   `directory`: private folder for the wrapper script.
 *   `onPrompt`: resolves with the answer, or null to cancel.
 */
export async function startAskpassServer({ directory, onPrompt }) {
  const secret = randomBytes(24).toString("hex");
  const wrapper = writeAskpassWrapper(directory);

  const server = http.createServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.headers["x-dream-askpass"] !== secret
    ) {
      response.writeHead(403).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_PROMPT_BYTES) request.destroy();
    });
    request.on("end", async () => {
      let message = "";
      try {
        message = String(JSON.parse(body).message ?? "");
      } catch {
        response.writeHead(400).end();
        return;
      }
      // ssh's confirmations (host keys) want yes/no; everything else is a
      // secret the user types.
      const kind = /\(yes\/no/i.test(message) ? "confirm" : "secret";
      let answer = null;
      try {
        answer = await onPrompt({ kind, message });
      } catch {
        answer = null;
      }
      if (typeof answer !== "string") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end(answer);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    /** The environment that makes an ssh process prompt through Dream. */
    env: {
      DISPLAY: process.env.DISPLAY || "dream:0",
      DREAM_ASKPASS_NODE: process.execPath,
      DREAM_ASKPASS_PORT: String(port),
      DREAM_ASKPASS_SCRIPT: ASKPASS_SCRIPT,
      DREAM_ASKPASS_SECRET: secret,
      ELECTRON_RUN_AS_NODE: "1",
      SSH_ASKPASS: wrapper,
      SSH_ASKPASS_REQUIRE: "force",
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections?.();
      }),
  };
}
