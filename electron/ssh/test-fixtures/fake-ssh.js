// A stand-in for OpenSSH in tests, for the direct (non-multiplexed) shape:
// the "remote" host is this machine.
//
//   ssh [opts] target <ensure command>   runs dream-host ensure locally
//                                        (FAKE_SSH_HOST_HOME is its --home)
//   ssh [opts] target sh -c '<script>'  runs it with sh, HOME set to
//                                        FAKE_SSH_SCRIPT_HOME
//   ssh [opts] -L l:127.0.0.1:r target cat >/dev/null
//                                        forwards l to r until stdin ends
//
// FAKE_SSH_FAIL=auth answers like a refused key. FAKE_SSH_PID_DIR, when set,
// receives a `forward-<pid>` file per forwarding process, so a test can kill
// one to simulate a dropped link.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DREAM_HOST = fileURLToPath(
  new URL("../../host/dream-host.js", import.meta.url),
);

const args = process.argv.slice(2);
let forward = null;
const rest = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "-o" || arg === "-S" || arg === "-O") i += 1;
  else if (arg === "-L") forward = args[++i];
  else if (arg.startsWith("-")) continue;
  else rest.push(arg);
}
const [target, ...commandWords] = rest;
const command = commandWords.join(" ");

if (process.env.FAKE_SSH_FAIL === "auth") {
  process.stderr.write(`${target}: Permission denied (publickey).\r\n`);
  process.exit(255);
}

if (forward) {
  const [, localPort, , remotePort] = forward.split(":");
  const server = net.createServer((socket) => {
    const upstream = net.connect(Number(remotePort), "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.once("error", (error) => {
    process.stderr.write(`bind: ${error.message}\r\n`);
    process.exit(255);
  });
  server.listen(Number(localPort), "127.0.0.1", () => {
    if (process.env.FAKE_SSH_PID_DIR) {
      writeFileSync(
        path.join(process.env.FAKE_SSH_PID_DIR, `forward-${process.pid}`),
        "",
      );
    }
  });
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (/ ensure'$/.test(command)) {
  const child = spawn(
    process.execPath,
    [DREAM_HOST, "ensure", "--home", process.env.FAKE_SSH_HOST_HOME],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (command.startsWith("sh -c ")) {
  // A script (installing the runtime, an upload): run by sh here, with the
  // fake host's home as HOME and stdin passed through.
  const child = spawn("sh", ["-c", command], {
    env: { ...process.env, HOME: process.env.FAKE_SSH_SCRIPT_HOME },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  process.stderr.write(`fake-ssh: unexpected command: ${command}\n`);
  process.exit(127);
}
