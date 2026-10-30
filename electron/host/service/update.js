// A durable service handoff. No data is restored or migrated by this module.
// A pending journal is retained until the new or previous host is healthy;
// `service recover` can complete it after the updater or machine stops.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { API_SESSION_TOKEN_HEADER } from "../../api/shared/session-token.js";
import { HOST_IDENTITY_FILE, loadHostIdentity } from "../identity.js";
import { isProcessAlive } from "../run-directory.js";
import { isStateLockHeld, readStateLockRecord } from "../state-lock.js";
import { writeServiceJson } from "./operation.js";
import { inspectRuntime, retainRuntime, stageRuntime } from "./runtime.js";
import { readServiceRecord } from "./service.js";

const journalPath = (home) => path.join(home, "service-update.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readServiceUpdate(home) {
  try {
    const journal = JSON.parse(readFileSync(journalPath(home), "utf8"));
    if (
      journal.format !== 1 ||
      !journal.previous?.info?.runtime ||
      !journal.previous?.launch?.program ||
      !journal.next?.info?.runtime ||
      !journal.next?.launch?.program ||
      !journal.identity?.hostId ||
      !["prepared", "starting", "recovering"].includes(journal.phase)
    )
      throw new Error("Invalid journal");
    return journal;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(
      "The service update journal is unreadable. Restore service-update.json before changing the service.",
    );
  }
}

export const updateSummary = (journal) =>
  journal
    ? {
        from: journal.previous.info.version,
        to: journal.next.info.version,
        phase: journal.phase,
      }
    : null;

export function lastServiceUpdate(home) {
  try {
    return JSON.parse(
      readFileSync(path.join(home, "service-update-result.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function dataPaths(launch) {
  const index = launch.args.indexOf("--data-dir");
  const dataDirectory = index >= 0 ? launch.args[index + 1] : null;
  if (!dataDirectory || !path.isAbsolute(dataDirectory))
    throw new Error(
      "The service has no absolute data directory. Reinstall it with --data-dir before updating.",
    );
  const database =
    launch.environment.DREAM_DB_PATH || path.join(dataDirectory, "dream.db");
  if (!path.isAbsolute(database))
    throw new Error(
      "The service's DREAM_DB_PATH must be absolute before updating.",
    );
  return { dataDirectory, database };
}

function assertDatabase(launch, info) {
  const { database } = dataPaths(launch);
  const reader = new DatabaseSync(database, { readOnly: true });
  try {
    const migrations = reader
      .prepare(
        "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at",
      )
      .all()
      .map((row) => ({ hash: row.hash, when: Number(row.created_at) }));
    if (
      JSON.stringify(migrations) !== JSON.stringify(info.runtime.migrations)
    ) {
      throw new Error(
        "The database's migrations differ from this runtime. Replacement is stopped; use a compatible runtime without reversing database migrations.",
      );
    }
  } finally {
    reader.close();
  }
}

function identityFor(launch) {
  const { dataDirectory } = dataPaths(launch);
  if (!existsSync(path.join(dataDirectory, HOST_IDENTITY_FILE)))
    throw new Error(
      "The service's existing host identity is missing; no replacement was started.",
    );
  const { hostId, fingerprint, publicKey } = loadHostIdentity(dataDirectory);
  return { hostId, fingerprint, publicKey };
}

// The live owner of the launch's database: its record, while its lock is
// held (state-lock.js); null once the host that wrote it has gone.
const holderOf = (launch) => {
  const { database } = dataPaths(launch);
  if (!isStateLockHeld(database)) return null;
  const holder = readStateLockRecord(database);
  if (!holder)
    throw new Error(
      "The database owner cannot be checked. Restore its host-lock record before replacing the service.",
    );
  return holder;
};

export async function changeServiceRuntime({
  home,
  manager,
  probe,
  stopDaemon,
  version,
  archive,
  sha256,
  recover = false,
  print,
  waitMs = 20_000,
}) {
  // Caller owns the service-operation lock for the entire transaction.
  if (!manager.isInstalled() || !manager.servesHome(home))
    throw new Error(
      "Install the service for this host home before updating it.",
    );
  let journal = readServiceUpdate(home);
  if (journal && !recover)
    throw new Error(
      "An interrupted update needs recovery. Run `dream-host service recover` first.",
    );
  if (!journal && recover) {
    print("No interrupted service update to recover.");
    return { recovered: false };
  }

  const save = (phase) => {
    journal.phase = phase;
    writeServiceJson(journalPath(home), journal);
  };

  const stop = async () => {
    const before = await probe();
    await manager.suspend();
    await stopDaemon();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (
        (!before || !isProcessAlive(before.pid)) &&
        !holderOf(journal.previous.launch)
      )
        return;
      await sleep(100);
    }
    throw new Error(
      "The previous host has not exited. The service was not replaced; stop it before running `service recover`.",
    );
  };

  const health = async (target) => {
    const running = await probe();
    if (!running || running.version !== target.info.version) return null;
    const holder = holderOf(target.launch);
    if (holder?.pid !== running.pid) return null;
    const endpoint = `http://127.0.0.1:${running.port}`;
    const headers = {
      [API_SESSION_TOKEN_HEADER]: running.token,
      "content-type": "application/json",
    };
    try {
      const response = await fetch(`${endpoint}/api/host-info`, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const info = await response.json();
      if (
        info.version !== target.info.version ||
        info.pid !== running.pid ||
        Object.entries(journal.identity).some(
          ([key, value]) => info[key] !== value,
        )
      )
        return null;
      // Readiness includes the writer and catalog, not just an open HTTP port.
      const catalog = await fetch(`${endpoint}/api/catalog`, {
        method: "POST",
        headers,
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (!catalog.ok) return null;
      await catalog.arrayBuffer();
      assertDatabase(target.launch, target.info);
      return running;
    } catch {
      return null;
    }
  };

  const waitHealthy = async (target) => {
    const deadline = Date.now() + waitMs;
    let seen = null;
    while (Date.now() < deadline) {
      const running = await health(target);
      if (running && seen?.pid === running.pid && Date.now() - seen.at >= 1_000)
        return running;
      if (!running) seen = null;
      else if (seen?.pid !== running.pid)
        seen = { pid: running.pid, at: Date.now() };
      await sleep(200);
    }
    throw new Error(
      `Host ${target.info.version} did not become ready with the original identity and database.`,
    );
  };

  const finish = (outcome) => {
    writeServiceJson(path.join(home, "service-update-result.json"), {
      ...updateSummary(journal),
      outcome,
      finishedAt: new Date().toISOString(),
    });
    unlinkSync(journalPath(home));
  };

  const restore = async () => {
    save("recovering");
    await stop();
    const previous = journal.previous;
    const inspected = await inspectRuntime(previous.launch);
    if (JSON.stringify(inspected) !== JSON.stringify(previous.info))
      throw new Error(
        "The retained previous runtime changed; recovery stopped.",
      );
    assertDatabase(previous.launch, previous.info);
    if (
      JSON.stringify(identityFor(previous.launch)) !==
      JSON.stringify(journal.identity)
    )
      throw new Error("The host identity changed; recovery stopped.");
    await manager.install(previous.launch);
    const running = await waitHealthy(previous);
    finish("rolled-back");
    return running;
  };

  if (recover) {
    // Only accept a candidate the updater had begun starting. A reboot before
    // replacement otherwise restores the previous definition deterministically.
    if (journal.phase === "starting" && (await health(journal.next))) {
      finish("updated");
      print(`Recovered the completed update to ${journal.next.info.version}.`);
      return { recovered: true, version: journal.next.info.version };
    }
    const running = await restore();
    print(
      `Recovered host ${journal.previous.info.version}. Interrupted turns require an explicit retry.`,
    );
    return { recovered: true, rolledBack: true, version: running.version };
  }

  const launch = readServiceRecord(home)?.launch;
  if (!launch)
    throw new Error(
      "This service predates saved launch settings. Reinstall it with its existing data directory and --env options before updating.",
    );
  const previousInfo = await inspectRuntime(launch);
  assertDatabase(launch, previousInfo);
  const identity = identityFor(launch);
  const retained = await retainRuntime(home, launch, previousInfo);
  print(
    `Staging host ${version}; the current host stays running during verification.`,
  );
  const next = await stageRuntime({
    home,
    version,
    archive,
    sha256,
    previous: launch,
    expectedRuntime: previousInfo.runtime,
  });
  journal = {
    format: 1,
    identity,
    next,
    phase: "prepared",
    previous: { info: previousInfo, launch: retained },
  };
  save("prepared");
  print(
    "Replacing the service interrupts running turns and terminals. Queued work remains paused until explicitly resumed.",
  );
  try {
    await stop();
    assertDatabase(next.launch, next.info);
    save("starting");
    await manager.install(next.launch);
    const running = await waitHealthy(next);
    finish("updated");
    print(
      `Updated to ${next.info.version} (pid ${running.pid}, port ${running.port}).`,
    );
    return { updated: true, version: next.info.version };
  } catch (error) {
    try {
      await restore();
    } catch (recoveryError) {
      throw new Error(
        `Update failed: ${error.message} Recovery is pending: ${recoveryError.message} Run 'dream-host service recover' after resolving it; data and both runtimes are kept.`,
      );
    }
    throw new Error(
      `Update failed: ${error.message} Restored host ${previousInfo.version}; data was not reversed.`,
    );
  }
}
