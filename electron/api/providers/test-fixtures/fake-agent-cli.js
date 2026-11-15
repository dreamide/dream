// A stand-in agent CLI for agent-cli-run tests, run with process.execPath.
// The first argument picks what it does; any further arguments are ignored.
//
//   echo    writes stdin back as {"text": ...} on stdout, with a non-JSON
//           line before it, and exits 0
//   fail    writes "model quota exceeded" to stderr and exits 3
//   silent  exits 4 with no output
//   flood   writes 100,000 characters to stderr, ending in "END", and exits 1
//   hang    starts a grandchild that never exits, reports both pids as
//           {"pids": [...]}, and never exits itself
import { spawn } from "node:child_process";

const mode = process.argv[2];

const readStdin = () =>
  new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
  });

if (mode === "echo") {
  const text = await readStdin();
  process.stdout.write("not json\n");
  process.stdout.write(`${JSON.stringify({ text })}\n`);
  process.exit(0);
} else if (mode === "fail") {
  process.stderr.write("model quota exceeded\n");
  process.exit(3);
} else if (mode === "silent") {
  process.exit(4);
} else if (mode === "flood") {
  process.stderr.write(`${"x".repeat(99_997)}END`, () => process.exit(1));
} else if (mode === "hang") {
  const grandchild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  process.stdout.write(
    `${JSON.stringify({ pids: [process.pid, grandchild.pid] })}\n`,
  );
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`fake-agent-cli: unknown mode ${mode}\n`);
  process.exit(2);
}
