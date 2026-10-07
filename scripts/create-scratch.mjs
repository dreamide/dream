import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const label = process.argv[2] ?? "task";
if (!/^[a-zA-Z0-9_-]+$/.test(label)) {
  throw new Error(
    "Use letters, numbers, underscores, or hyphens for the task name.",
  );
}
const directory = await mkdtemp(path.join(os.tmpdir(), `dream-${label}-`));
await writeFile(
  path.join(directory, "run-python.ps1"),
  '$env:PYTHONUTF8 = "1"\n$env:PYTHONIOENCODING = "utf-8"\npython @args\nexit $LASTEXITCODE\n',
  "utf8",
);
console.log(directory);
