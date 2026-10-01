// The host runs outside Electron (as a daemon on an SSH host), so nothing it
// imports, however indirectly, may import "electron". Walks the relative
// import graph from the host's entry point.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const hostDirectory = path.dirname(fileURLToPath(import.meta.url));
// The host, and the daemon command line that runs it on its own.
const entries = ["index.js", "dream-host.js"].map((file) =>
  path.join(hostDirectory, file),
);

const SPECIFIER =
  /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;

const importsOf = (file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(SPECIFIER)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? match[4],
  );
};

test("nothing the host imports depends on Electron", () => {
  const visited = new Set();
  const offenders = [];
  const pending = [...entries];

  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of importsOf(file)) {
      if (specifier === "electron" || specifier.startsWith("electron/")) {
        offenders.push(path.relative(hostDirectory, file));
      } else if (specifier.startsWith(".")) {
        // JSDoc type imports name renderer .ts files without an extension;
        // they are not loaded at runtime, so only JavaScript is followed.
        const resolved = path.resolve(path.dirname(file), specifier);
        if (/\.(c|m)?js$/.test(resolved) && existsSync(resolved)) {
          pending.push(resolved);
        }
      }
    }
  }

  expect(visited.size).toBeGreaterThan(20);
  expect(offenders).toEqual([]);
});
