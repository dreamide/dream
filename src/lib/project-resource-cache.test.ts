// The project resource cache over a fake loader and a version the test
// moves: what it shares, what it serves from what, and who is read again
// when a project's refresh key moves.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createProjectResourceCache,
  type ResourceKey,
  type ResourceSpec,
} from "./project-resource-cache";

const SCOPE = { hostId: "local", projectPath: "/work/app" };

const setup = ({ minAgeMs }: { minAgeMs?: number } = {}) => {
  const versions = { files: 0, git: 0 };
  const loads: string[] = [];
  const gates: Array<() => void> = [];
  let time = 0;
  let hold = false;
  const answer = <T>(label: string, value: T) => {
    loads.push(label);
    return hold
      ? new Promise<T>((resolve) => gates.push(() => resolve(value)))
      : Promise.resolve(value);
  };
  const status: ResourceSpec<{ detail: string; version: number }> = {
    group: "git",
    load: (key) =>
      answer(`status:${key.params?.detail}`, {
        detail: String(key.params?.detail),
        version: versions.git,
      }),
    serve: (data) => ({ ...data, detail: "summary" }),
    serves: (have, want) => have.detail === "full" && want.detail === "summary",
  };
  const context: ResourceSpec<number> = {
    group: "git",
    load: () => answer("context", versions.git),
    minAgeMs,
  };
  const files: ResourceSpec<string[]> = {
    group: "files",
    load: (key) =>
      answer(
        `files:${key.params?.max}`,
        ["a", "b", "c", "d"].slice(0, Number(key.params?.max)),
      ),
    serve: (list, want) => list.slice(0, Number(want.max)),
    serves: (have, want) => Number(have.max) >= Number(want.max),
  };
  const cache = createProjectResourceCache({
    getVersion: (_scope, group) => versions[group],
    now: () => time,
    specs: { context, files, status },
  });
  const key = (
    kind: "context" | "files" | "status",
    params?: ResourceKey["params"],
  ): ResourceKey => ({ ...SCOPE, kind, params });
  return {
    bump: (group: "files" | "git") => {
      versions[group] += 1;
      cache.invalidate(SCOPE, group);
    },
    cache,
    hold: () => {
      hold = true;
    },
    key,
    loads,
    release: () => {
      for (const gate of gates.splice(0)) gate();
    },
    tick: (ms: number) => {
      time += ms;
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("reads at one version share one load and are then cached", async () => {
  const { cache, key, loads } = setup();
  const full = key("status", { detail: "full" });

  const [first, second] = await Promise.all([
    cache.read(full),
    cache.read(full),
  ]);
  const third = await cache.read(full);

  assert.deepEqual(loads, ["status:full"]);
  assert.equal(first, second);
  assert.equal(third, first);
});

test("a summary is served from a full status read at the same version", async () => {
  const { cache, hold, key, loads, release } = setup();
  hold();

  const full = cache.read(key("status", { detail: "full" }));
  const summary = cache.read(key("status", { detail: "summary" }));
  release();

  assert.deepEqual(await summary, { detail: "summary", version: 0 });
  await full;
  assert.deepEqual(loads, ["status:full"]);
});

test("a short file list is served from a longer one, not the reverse", async () => {
  const { cache, key, loads } = setup();

  await cache.read(key("files", { max: 3 }));
  assert.deepEqual(await cache.read(key("files", { max: 2 })), ["a", "b"]);
  assert.deepEqual(await cache.read(key("files", { max: 4 })), [
    "a",
    "b",
    "c",
    "d",
  ]);

  assert.deepEqual(loads, ["files:3", "files:4"]);
});

test("a bumped version reloads only what is being shown", async () => {
  const { bump, cache, key, loads } = setup();
  const shown = key("status", { detail: "full" });
  const hidden = key("status", { detail: "summary" });
  const shownSub = cache.subscribe(shown, () => {}, true);
  const hiddenSub = cache.subscribe(hidden, () => {}, false);
  await settle();
  assert.deepEqual(loads, ["status:full"]);

  bump("git");
  await settle();
  assert.deepEqual(loads, ["status:full", "status:full"]);
  assert.equal(cache.snapshot(hidden).fresh, false);

  // Shown later: read then, served from the full read already made.
  hiddenSub.setActive(true);
  await settle();
  assert.deepEqual(loads, ["status:full", "status:full"]);
  assert.equal(cache.snapshot(hidden).fresh, true);
  shownSub.unsubscribe();
  hiddenSub.unsubscribe();
});

test("a bump of one group leaves the other fresh", async () => {
  const { bump, cache, key, loads } = setup();
  const files = key("files", { max: 2 });
  const sub = cache.subscribe(files, () => {}, true);
  await settle();

  bump("git");
  await settle();

  assert.equal(cache.snapshot(files).fresh, true);
  assert.deepEqual(loads, ["files:2"]);
  sub.unsubscribe();
});

test("an answer younger than its minimum age outlives a bump", async () => {
  const { bump, cache, key, loads, tick } = setup({ minAgeMs: 15_000 });
  const context = key("context");
  const sub = cache.subscribe(context, () => {}, true);
  await settle();

  bump("git");
  await settle();
  assert.deepEqual(loads, ["context"]);

  tick(15_000);
  bump("git");
  await settle();
  assert.deepEqual(loads, ["context", "context"]);

  await cache.read(context, { force: true });
  assert.equal(loads.length, 3);
  sub.unsubscribe();
});

test("listeners hear loads, and the snapshot holds between changes", async () => {
  const { cache, key } = setup();
  const full = key("status", { detail: "full" });
  let heard = 0;
  const sub = cache.subscribe(full, () => {
    heard += 1;
  });

  assert.equal(cache.snapshot(full).loading, true);
  await settle();
  const snapshot = cache.snapshot(full);

  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.fresh, true);
  assert.equal(snapshot.version, 0);
  assert.equal(cache.snapshot(full), snapshot);
  assert.ok(heard >= 1);
  sub.unsubscribe();
});

test("a failed load is kept as an error and read again after a bump", async () => {
  const versions = { files: 0, git: 0 };
  let fail = true;
  const cache = createProjectResourceCache({
    getVersion: (_scope, group) => versions[group],
    specs: {
      branches: {
        group: "git",
        load: () =>
          fail
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(["main"]),
      } satisfies ResourceSpec<string[]>,
    },
  });
  const key = { ...SCOPE, kind: "branches" };

  await assert.rejects(cache.read(key), /offline/);
  await assert.rejects(cache.read(key), /offline/);
  fail = false;
  versions.git += 1;

  assert.deepEqual(await cache.read(key), ["main"]);
});
