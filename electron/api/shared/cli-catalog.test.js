// The CLI catalog over fake readers and a clock the test moves: how often
// a CLI is looked up, which answers it keeps and for how long, and what
// makes it look again.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CLI_FOUND_TTL_MS,
  CLI_MISSING_TTL_MS,
  createCliCatalog,
  createTimedCache,
} from "./cli-catalog.js";

const setup = (installed = { claude: "/bin/claude" }) => {
  const lookups = [];
  const versionReads = [];
  let time = 0;
  const catalog = createCliCatalog({
    now: () => time,
    readVersion: async (command, commandPath) => {
      versionReads.push(commandPath);
      return `${command} 1.0.0`;
    },
    resolvePath: async (command) => {
      lookups.push(command);
      return installed[command] ?? null;
    },
  });
  return {
    catalog,
    installed,
    lookups,
    tick: (ms) => {
      time += ms;
    },
    versionReads,
  };
};

test("a turn's readiness check and launch look the CLI up once", async () => {
  const { catalog, lookups } = setup();

  // checkReady, then the stream resolving the executable, then a title.
  assert.equal(await catalog.isAvailable("claude"), true);
  assert.equal(await catalog.path("claude"), "/bin/claude");
  assert.equal(await catalog.path("claude"), "/bin/claude");

  assert.deepEqual(lookups, ["claude"]);
});

test("lookups asked for together share one", async () => {
  const { catalog, lookups } = setup();

  await Promise.all([
    catalog.path("claude"),
    catalog.isAvailable("claude"),
    catalog.version("claude"),
  ]);

  assert.deepEqual(lookups, ["claude"]);
});

test("a found CLI is kept for the found TTL", async () => {
  const { catalog, lookups, tick } = setup();
  await catalog.path("claude");

  tick(CLI_FOUND_TTL_MS - 1);
  await catalog.path("claude");
  assert.equal(lookups.length, 1);

  tick(1);
  await catalog.path("claude");
  assert.equal(lookups.length, 2);
});

test("a missing CLI is looked for again soon, so an install shows up", async () => {
  const { catalog, installed, tick } = setup({});
  assert.equal(await catalog.isAvailable("grok"), false);

  installed.grok = "/bin/grok";
  tick(CLI_MISSING_TTL_MS - 1);
  assert.equal(await catalog.isAvailable("grok"), false);
  tick(1);
  assert.equal(await catalog.isAvailable("grok"), true);
});

test("a version is read from the known path, once", async () => {
  const { catalog, lookups, versionReads } = setup();

  assert.equal(await catalog.version("claude"), "claude 1.0.0");
  assert.equal(await catalog.version("claude"), "claude 1.0.0");
  assert.equal(await catalog.version("codex"), null);

  assert.deepEqual(versionReads, ["/bin/claude"]);
  assert.deepEqual(lookups, ["claude", "codex"]);
});

test("force looks again; forget drops a command and what was derived", async () => {
  const { catalog, lookups, versionReads } = setup();
  await catalog.version("claude");
  let derivedReads = 0;
  const derive = () =>
    catalog.derived("cursor-command", async () => {
      derivedReads += 1;
      return "agent";
    });
  await derive();
  await derive();

  await catalog.version("claude", { force: true });
  assert.equal(lookups.length, 2);
  assert.equal(versionReads.length, 2);

  catalog.forget("claude");
  await catalog.path("claude");
  await derive();
  assert.equal(lookups.length, 3);
  assert.equal(derivedReads, 2);
});

test("a read that threw is not kept", async () => {
  let attempts = 0;
  const cache = createTimedCache({ ttlMs: 1000 });
  const read = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("spawn failed");
    return "ok";
  };

  await assert.rejects(cache.get("k", read), /spawn failed/);
  assert.equal(await cache.get("k", read), "ok");
  assert.equal(attempts, 2);
});

test("an answer that counts as found for its cache is kept the full TTL", async () => {
  let time = 0;
  let reads = 0;
  const cache = createTimedCache({
    isMiss: () => false,
    missTtlMs: 10,
    now: () => time,
    ttlMs: 30_000,
  });
  const read = async () => {
    reads += 1;
    return { status: "unavailable" };
  };

  await cache.get("usage", read);
  time = 29_999;
  await cache.get("usage", read);

  assert.equal(reads, 1);
});
