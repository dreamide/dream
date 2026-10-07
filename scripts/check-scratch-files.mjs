import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0");
const rootFiles = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
const scratch = (name) =>
  /^(?:\.tmp(?:-|\.)|\.twcheck\.|(?:fix|css)\d*\.(?:cjs|mjs|py)$)/.test(name);
const failures = [...new Set([...tracked, ...rootFiles])].filter(
  (name) =>
    !name.includes("/") &&
    scratch(path.basename(name)) &&
    existsSync(path.join(root, name)),
);
if (failures.length) {
  console.error(
    `Scratch files belong outside the checkout:\n${failures.join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log("Scratch-file check passed.");
}
