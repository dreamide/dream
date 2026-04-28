import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const prebuildsDir = join(
  process.cwd(),
  "node_modules",
  "node-pty",
  "prebuilds",
);

if (!existsSync(prebuildsDir)) {
  process.exit(0);
}

let fixedCount = 0;

for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) {
    continue;
  }

  const helperPath = join(prebuildsDir, entry.name, "spawn-helper");

  if (!existsSync(helperPath)) {
    continue;
  }

  const mode = statSync(helperPath).mode;

  if ((mode & 0o111) === 0o111) {
    continue;
  }

  chmodSync(helperPath, mode | 0o755);
  fixedCount += 1;
}

if (fixedCount > 0) {
  console.log(
    `fixed executable permissions for ${fixedCount} node-pty helper(s)`,
  );
}
