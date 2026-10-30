// A stand-in for wsl.exe in tests: the "distribution" is this machine.
//
//   wsl.exe -d <name> --exec sh -c <ensure command>
//                                        runs dream-host ensure locally
//                                        (FAKE_WSL_HOST_HOME is its --home)
//   wsl.exe -d <name> --exec sh -c 'cat >/dev/null'
//                                        holds until stdin ends; writes
//                                        `hold-<pid>` to FAKE_WSL_PID_DIR
//
// FAKE_WSL_MISSING=1 answers like a distribution that does not exist.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DREAM_HOST = fileURLToPath(
  new URL("../../host/dream-host.js", import.meta.url),
);

const args = process.argv.slice(2);
const distribution = args[args.indexOf("-d") + 1];
const command = args.at(-1);

if (process.env.FAKE_WSL_MISSING === "1") {
  process.stdout.write(
    `There is no distribution with the supplied name: ${distribution}\n`,
  );
  process.exit(1);
}

if (command === "cat >/dev/null") {
  if (process.env.FAKE_WSL_PID_DIR) {
    writeFileSync(
      path.join(process.env.FAKE_WSL_PID_DIR, `hold-${process.pid}`),
      "",
    );
  }
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (/ ensure'$/.test(command)) {
  const child = spawn(
    process.execPath,
    [DREAM_HOST, "ensure", "--home", process.env.FAKE_WSL_HOST_HOME],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  process.stderr.write(`fake-wsl: unexpected command: ${command}\n`);
  process.exit(127);
}
