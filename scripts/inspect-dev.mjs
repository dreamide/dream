import { execFileSync } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devSessionDirectory } from "../electron/dev-inspection.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--json", "--logs"].includes(flag))) {
  throw new Error("Usage: pnpm inspect:dev [--json] [--logs]");
}
const directory = devSessionDirectory(root);
const names = await readdir(directory).catch(() => []);
const sessions = [];
for (const name of names.filter((name) => /^session-\d+\.json$/.test(name))) {
  try {
    const session = JSON.parse(
      await readFile(path.join(directory, name), "utf8"),
    );
    if (path.resolve(session.root) !== path.resolve(root)) continue;
    process.kill(session.pid, 0);
    sessions.push(session);
  } catch {
    // Stale records and records still being written are ignored.
  }
}
// Older, already-running builds have no manifest. Discover just the renderer
// process and port; never print complete process arguments (they contain keys).
if (!sessions.length) {
  let processes;
  if (process.platform === "win32") {
    processes = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          '$items = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(node|electron)\\.exe$" -and $_.CommandLine -like "*$env:DREAM_INSPECT_ROOT*" -and $_.CommandLine -match "vite[\\\\/]bin[\\\\/]vite\\.js" } | ForEach-Object { if ($_.CommandLine -match "--port\\s+(\\d+)") { @{ pid = $_.ProcessId; port = [int]$Matches[1] } } }); ConvertTo-Json -InputObject $items -Compress',
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DREAM_INSPECT_ROOT: root.replace(/[\\/]$/, ""),
          },
        },
      ),
    );
  } else {
    processes = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .filter(
        (line) =>
          line.includes(root.replace(/\/$/, "")) &&
          /vite\/bin\/vite\.js/.test(line),
      )
      .flatMap((line) => {
        const pid = Number(line.trim().split(/\s+/)[0]);
        const port = line.match(/--port\s+(\d+)/)?.[1];
        return port ? [{ pid, port: Number(port) }] : [];
      });
  }
  for (const { pid, port } of processes) {
    sessions.push({
      pid,
      rendererUrl: `http://127.0.0.1:${port}`,
      source: "legacy process discovery",
    });
  }
}
const reachable = new Map();
await Promise.all(
  sessions.map(async (session) => {
    try {
      const response = await fetch(session.rendererUrl, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return;
      const existing = reachable.get(session.rendererUrl);
      if (!existing || session.kind === "electron")
        reachable.set(session.rendererUrl, session);
    } catch {
      // A crashed or starting renderer is not reported as ready.
    }
  }),
);
const found = [...reachable.values()].map((session) => ({
  ...session,
  fixtureUrl: new URL("/__dev/fixtures", session.rendererUrl).href,
}));
if (!found.length) {
  console.error(
    "No running renderer found for this checkout. No server was started.",
  );
  process.exitCode = 1;
} else if (flags.has("--json")) {
  console.log(JSON.stringify(found, null, 2));
} else {
  for (const session of found) {
    console.log(
      `Renderer: ${session.rendererUrl}\nFixtures: ${session.fixtureUrl}\nProcess: ${session.pid}\nAPI: ${session.apiUrl ?? "unavailable in this older build"}\nDebugger: ${session.debugUrl ?? "disabled (opt in with DREAM_DEVTOOLS_PORT on next launch)"}\nLog: ${session.logPath ?? "unavailable in this older build"}`,
    );
    if (flags.has("--logs") && session.logPath) {
      const handle = await open(session.logPath, "r");
      try {
        const { size } = await handle.stat();
        const buffer = Buffer.alloc(Math.min(size, 16_384));
        await handle.read(buffer, 0, buffer.length, size - buffer.length);
        console.log(buffer.toString("utf8").split("\n").slice(-40).join("\n"));
      } finally {
        await handle.close();
      }
    }
  }
}
