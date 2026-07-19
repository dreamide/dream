import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POSIX_TERMINATION_GRACE_MS = 500;
const POSIX_TERMINATION_POLL_MS = 25;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5000;

const normalizeProcessId = (value) => {
  const processId = Math.floor(Number(value));
  return Number.isSafeInteger(processId) && processId > 0 ? processId : null;
};

export const parsePosixProcessTable = (value) => {
  if (typeof value !== "string") {
    return [];
  }

  return value.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) {
      return [];
    }

    const processId = normalizeProcessId(match[1]);
    const parentProcessId = normalizeProcessId(match[2]);
    return processId && parentProcessId ? [{ parentProcessId, processId }] : [];
  });
};

export const collectDescendantProcessIds = (rootProcessId, processTable) => {
  const normalizedRootProcessId = normalizeProcessId(rootProcessId);
  if (!normalizedRootProcessId || !Array.isArray(processTable)) {
    return [];
  }

  const childProcessIdsByParent = new Map();
  for (const entry of processTable) {
    const processId = normalizeProcessId(entry?.processId);
    const parentProcessId = normalizeProcessId(entry?.parentProcessId);
    if (
      !processId ||
      !parentProcessId ||
      processId === normalizedRootProcessId
    ) {
      continue;
    }

    const childProcessIds = childProcessIdsByParent.get(parentProcessId) ?? [];
    childProcessIds.push(processId);
    childProcessIdsByParent.set(parentProcessId, childProcessIds);
  }

  const descendantProcessIds = [];
  const visited = new Set([normalizedRootProcessId]);
  const visitChildren = (parentProcessId) => {
    for (const childProcessId of childProcessIdsByParent.get(parentProcessId) ??
      []) {
      if (visited.has(childProcessId)) {
        continue;
      }

      visited.add(childProcessId);
      visitChildren(childProcessId);
      descendantProcessIds.push(childProcessId);
    }
  };

  visitChildren(normalizedRootProcessId);
  return descendantProcessIds;
};

const signalProcess = (processId, signal) => {
  try {
    process.kill(processId, signal);
    return true;
  } catch {
    return false;
  }
};

const processIsRunning = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const waitForProcessesToExit = async (processIds) => {
  const deadline = Date.now() + POSIX_TERMINATION_GRACE_MS;
  while (
    Date.now() < deadline &&
    processIds.some((processId) => processIsRunning(processId))
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, POSIX_TERMINATION_POLL_MS),
    );
  }
};

const readPosixProcessTable = async () => {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return parsePosixProcessTable(stdout);
  } catch {
    return [];
  }
};

const stopPosixProcessTree = async (rootProcessId) => {
  const processTable = await readPosixProcessTable();
  const descendantProcessIds = collectDescendantProcessIds(
    rootProcessId,
    processTable,
  );
  const processIds = [...descendantProcessIds, rootProcessId];

  for (const processId of processIds) {
    signalProcess(processId, "SIGTERM");
  }
  // PTY shells and detached pipe fallbacks are normally process-group leaders.
  // Signaling the group also catches children created after the process snapshot.
  signalProcess(-rootProcessId, "SIGTERM");

  await waitForProcessesToExit(processIds);

  for (const processId of processIds) {
    if (processIsRunning(processId)) {
      signalProcess(processId, "SIGKILL");
    }
  }
  signalProcess(-rootProcessId, "SIGKILL");
};

const stopWindowsProcessTree = (rootProcessId) =>
  new Promise((resolve) => {
    const taskkill = spawn(
      "taskkill",
      ["/pid", String(rootProcessId), "/f", "/t"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      try {
        taskkill.kill();
      } catch {
        // ignore taskkill cleanup failures
      }
      finish();
    }, WINDOWS_TASKKILL_TIMEOUT_MS);

    taskkill.once("error", finish);
    taskkill.once("close", finish);
  });

export const stopProcessTree = async (processId) => {
  const normalizedProcessId = normalizeProcessId(processId);
  if (
    !normalizedProcessId ||
    normalizedProcessId === process.pid ||
    !processIsRunning(normalizedProcessId)
  ) {
    return;
  }

  if (process.platform === "win32") {
    await stopWindowsProcessTree(normalizedProcessId);
    return;
  }

  await stopPosixProcessTree(normalizedProcessId);
};

export const stopChildProcess = async (child) => {
  const processId = normalizeProcessId(child?.pid);
  if (!processId || child.exitCode !== null || child.signalCode) {
    return;
  }

  await stopProcessTree(processId);
};
