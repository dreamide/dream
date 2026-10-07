import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";

export const devSessionDirectory = (root) =>
  path.join(
    os.tmpdir(),
    "dream-dev",
    createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16),
  );

export const publishDevSession = async (root, session) => {
  const directory = devSessionDirectory(root);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `session-${process.pid}.json`),
    `${JSON.stringify({ ...session, pid: process.pid, root: path.resolve(root) }, null, 2)}\n`,
    "utf8",
  );
};

// Diagnostics are bounded and asynchronous so logging cannot stall streaming.
export const createDevLogger = async (root) => {
  const directory = devSessionDirectory(root);
  await mkdir(directory, { recursive: true });
  const logPath = path.join(directory, `session-${process.pid}.log`);
  const stream = createWriteStream(logPath, { flags: "w" });
  let bytes = 0;
  let accepting = true;
  stream.on("error", () => {
    accepting = false;
  });
  stream.on("drain", () => {
    accepting = true;
  });
  const log = (source, message) => {
    if (!accepting || bytes >= 5 * 1024 * 1024) return;
    // Session credentials occasionally appear in error URLs or CLI diagnostics.
    const safe = String(message)
      .slice(0, 16_384)
      .replace(/(Bearer\s+)[\w.-]+/gi, "$1[redacted]")
      .replace(/((?:token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
    const line = `${new Date().toISOString()} [${source}] ${safe}\n`;
    const size = Buffer.byteLength(line);
    if (bytes + size > 5 * 1024 * 1024) return;
    bytes += size;
    accepting = stream.write(line);
  };
  for (const level of ["log", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      log(`main:${level}`, format(...args));
    };
  }
  return { log, logPath, close: () => stream.end() };
};
