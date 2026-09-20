import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  readCachedProviderModels,
  writeCachedProviderModels,
} from "./provider-model-cache";
import { DEFAULT_PROVIDER_MODELS } from "./provider-model-state";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("returns the defaults when nothing is cached", () => {
  assert.deepEqual(readCachedProviderModels(), DEFAULT_PROVIDER_MODELS);
});

test("restores cached models without transient state or freshness", () => {
  writeCachedProviderModels({
    ...DEFAULT_PROVIDER_MODELS,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    openai: {
      error: "boom",
      installed: true,
      loading: true,
      models: [
        {
          id: "gpt-6-astra",
          label: "GPT-6 Astra",
          reasoningEfforts: ["low", "medium", "high"],
          speedTiers: ["standard", "fast"],
        },
      ],
      source: "unavailable",
      version: "1.2.3",
    },
  });

  const restored = readCachedProviderModels();
  assert.deepEqual(restored.openai.models[0]?.speedTiers, ["standard", "fast"]);
  assert.equal(restored.openai.installed, true);
  assert.equal(restored.openai.version, "1.2.3");
  assert.equal(restored.openai.loading, false);
  assert.equal(restored.openai.error, null);
  // Still stale, so startup refreshes the lists in the background.
  assert.equal(restored.fetchedAt, null);
});

test("ignores a corrupt cache", () => {
  store.set("dream-provider-models-v1", "{not json");
  assert.deepEqual(readCachedProviderModels(), DEFAULT_PROVIDER_MODELS);

  store.set(
    "dream-provider-models-v1",
    JSON.stringify({
      openai: { models: [{ id: 1 }, { id: "a", label: "A" }] },
    }),
  );
  assert.deepEqual(readCachedProviderModels().openai.models, [
    { id: "a", label: "A" },
  ]);
});
