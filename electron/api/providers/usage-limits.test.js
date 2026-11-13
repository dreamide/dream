import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeAntigravityUsageLimits,
  normalizeClaudeUsageLimits,
  normalizeGrokUsageLimits,
  normalizeOpenCodeGoUsageLimits,
  readUsageLimits,
  storeProviderUsageLimitSnapshot,
} from "./usage-limits.js";

test("normalizes Grok weekly credits config into a usage window", () => {
  const result = normalizeGrokUsageLimits(
    {
      config: {
        billingPeriodEnd: "2026-09-09T06:43:38.799705+00:00",
        billingPeriodStart: "2026-09-02T06:43:38.799705+00:00",
        creditUsagePercent: 1,
        currentPeriod: {
          end: "2026-09-09T06:43:38.799705+00:00",
          start: "2026-09-02T06:43:38.799705+00:00",
          type: "USAGE_PERIOD_TYPE_WEEKLY",
        },
        isUnifiedBillingUser: true,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        prepaidBalance: { val: 0 },
        productUsage: [{ product: "GrokBuild", usagePercent: 1 }],
      },
    },
    { subscription_tier_display: "SuperGrok" },
  );

  assert.deepEqual(result, {
    limits: [
      {
        label: "Weekly limit",
        resetAfterSeconds: null,
        resetAt: "2026-09-09T06:43:38.799Z",
        usedPercent: 1,
      },
    ],
    note: "SuperGrok",
    stats: [],
  });
});

test("treats omitted Grok credit usage as zero when a period is present", () => {
  const result = normalizeGrokUsageLimits({
    config: {
      currentPeriod: {
        end: "2026-07-15T00:00:00Z",
        start: "2026-07-08T00:00:00Z",
        type: "USAGE_PERIOD_TYPE_WEEKLY",
      },
    },
  });

  assert.equal(result.limits[0]?.usedPercent, 0);
  assert.equal(result.limits[0]?.label, "Weekly limit");
  assert.equal(result.limits[0]?.resetAt, "2026-07-15T00:00:00.000Z");
});

test("falls back to Grok monthly used/limit fields", () => {
  const result = normalizeGrokUsageLimits({
    config: {
      billingPeriodEnd: "2025-05-01T00:00:00Z",
      billingPeriodStart: "2025-04-01T00:00:00Z",
      monthlyLimit: { val: 2000 },
      used: { val: 500 },
    },
  });

  assert.deepEqual(result.limits, [
    {
      label: "Monthly limit",
      resetAfterSeconds: null,
      resetAt: "2025-05-01T00:00:00.000Z",
      usedPercent: 25,
    },
  ]);
});

test("adds a distinct Grok Build product window and prepaid stats", () => {
  const result = normalizeGrokUsageLimits({
    config: {
      creditUsagePercent: 40,
      currentPeriod: {
        end: "2026-06-08T00:00:00Z",
        start: "2026-06-01T00:00:00Z",
        type: "USAGE_PERIOD_TYPE_WEEKLY",
      },
      onDemandCap: { val: 5000 },
      onDemandUsed: { val: 300 },
      prepaidBalance: { val: 1250 },
      productUsage: [{ product: "PRODUCT_GROK_BUILD", usagePercent: 61.2 }],
    },
  });

  assert.deepEqual(result.limits, [
    {
      label: "Weekly limit",
      resetAfterSeconds: null,
      resetAt: "2026-06-08T00:00:00.000Z",
      usedPercent: 40,
    },
    {
      label: "Build limit",
      resetAfterSeconds: null,
      resetAt: "2026-06-08T00:00:00.000Z",
      usedPercent: 61.2,
    },
  ]);
  assert.deepEqual(result.stats, [
    { label: "Prepaid credits", value: "$12.50" },
    { label: "Extra usage", value: "$3.00 / $50.00" },
  ]);
});

test("returns empty Grok limits when billing config is missing", () => {
  assert.deepEqual(normalizeGrokUsageLimits({ config: null }), {
    limits: [],
    note: null,
    stats: [],
  });
});

test("normalizes OpenCode Go usage payload into limit windows", () => {
  const limits = normalizeOpenCodeGoUsageLimits({
    usage: {
      monthly: {
        percent: 31,
        resetsAt: "2026-09-19T21:19:33.311Z",
        status: "ok",
      },
      rolling: {
        percent: 12,
        resetsAt: "2026-09-04T08:07:24.311Z",
        status: "ok",
      },
      weekly: {
        percent: 5,
        resetsAt: "2026-09-07T00:00:00.311Z",
        status: "ok",
      },
    },
  });

  assert.deepEqual(limits, [
    {
      label: "Go 5h limit",
      resetAfterSeconds: null,
      resetAt: "2026-09-04T08:07:24.311Z",
      usedPercent: 12,
    },
    {
      label: "Go weekly limit",
      resetAfterSeconds: null,
      resetAt: "2026-09-07T00:00:00.311Z",
      usedPercent: 5,
    },
    {
      label: "Go monthly limit",
      resetAfterSeconds: null,
      resetAt: "2026-09-19T21:19:33.311Z",
      usedPercent: 31,
    },
  ]);
});

test("returns no OpenCode Go limit windows for an empty payload", () => {
  assert.deepEqual(normalizeOpenCodeGoUsageLimits(null), []);
  assert.deepEqual(normalizeOpenCodeGoUsageLimits({ usage: {} }), []);
});

test("includes Claude model-scoped weekly limits such as Fable", () => {
  const result = normalizeClaudeUsageLimits({
    five_hour: {
      resets_at: "2026-09-29T00:20:00.493021+00:00",
      utilization: 8,
    },
    limits: [
      {
        group: "session",
        kind: "session",
        percent: 8,
        resets_at: "2026-09-29T00:20:00.493021+00:00",
        scope: null,
      },
      {
        group: "weekly",
        kind: "weekly_all",
        percent: 31,
        resets_at: "2026-10-01T14:00:00.493051+00:00",
        scope: null,
      },
      {
        group: "weekly",
        kind: "weekly_scoped",
        percent: 34,
        resets_at: "2026-10-01T14:00:00.493271+00:00",
        scope: { model: { display_name: "Fable", id: null }, surface: null },
      },
    ],
    seven_day: {
      resets_at: "2026-10-01T14:00:00.493051+00:00",
      utilization: 31,
    },
  });

  assert.deepEqual(result, [
    {
      label: "5h limit",
      resetAfterSeconds: null,
      resetAt: "2026-09-29T00:20:00.493Z",
      usedPercent: 8,
    },
    {
      label: "Weekly limit",
      resetAfterSeconds: null,
      resetAt: "2026-10-01T14:00:00.493Z",
      usedPercent: 31,
    },
    {
      label: "Fable weekly limit",
      resetAfterSeconds: null,
      resetAt: "2026-10-01T14:00:00.493Z",
      usedPercent: 34,
    },
  ]);
});

test("normalizes Antigravity usage limits from agy usage output", () => {
  const result = normalizeAntigravityUsageLimits({
    command: {
      data: {
        description: "Antigravity Pro Tier",
        groups: [
          {
            name: "Gemini 3.8",
            buckets: [
              {
                name: "5h",
                window: "5h",
                remaining_fraction: 0.85,
                reset_time: "2026-10-22T18:00:00Z",
              },
              {
                name: "Weekly",
                window: "weekly",
                remaining_fraction: 0.4,
                reset_time: "2026-10-29T00:00:00Z",
              },
            ],
          },
        ],
      },
    },
  });

  assert.deepEqual(result, {
    limits: [
      {
        label: "Gemini 3.8 · 5h limit",
        resetAfterSeconds: null,
        resetAt: "2026-10-22T18:00:00.000Z",
        usedPercent: 15,
      },
      {
        label: "Gemini 3.8 · Weekly limit",
        resetAfterSeconds: null,
        resetAt: "2026-10-29T00:00:00.000Z",
        usedPercent: 60,
      },
    ],
    note: "Antigravity Pro Tier",
    stats: [],
  });
});

// The read ladder every provider's usage limits follow. Each test uses its
// own provider name: the last good answers are remembered per provider.
const window = { label: "5h", usedPercent: 40 };

test("a live answer is the result, and is remembered for when reads fail", async () => {
  const ok = await readUsageLimits({
    label: "Test",
    provider: "ladder-live",
    readLive: async () => ({ limits: [window], source: "test" }),
  });
  assert.equal(ok.status, "ok");
  assert.equal(ok.error, null);
  assert.equal(ok.provider, "ladder-live");

  const failed = await readUsageLimits({
    fallback: async () => ({ limits: [], source: "disk" }),
    label: "Test",
    provider: "ladder-live",
    readLive: async () => {
      throw new Error("Test usage request failed (503).");
    },
  });
  assert.deepEqual(failed.limits, ok.limits);
  assert.equal(failed.source, "test");
  assert.equal(failed.fetchedAt, ok.fetchedAt, "as of the good answer");
  assert.equal(failed.error, "Test usage request failed (503).");
});

test("with nothing remembered, a failed read falls back to the disk, then to nothing", async () => {
  const fromDisk = await readUsageLimits({
    fallback: async () => ({ limits: [window], source: "test session" }),
    label: "Test",
    provider: "ladder-disk",
    readLive: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(fromDisk.source, "test session");
  assert.equal(fromDisk.error, "offline");
  assert.equal(fromDisk.status, "ok");

  const none = await readUsageLimits({
    label: "Test",
    provider: "ladder-none",
    readLive: async () => {
      throw "not an Error";
    },
  });
  assert.equal(none.status, "unavailable");
  assert.equal(none.error, "Unable to fetch Test usage limits.");
});

test("a provider can word its own failure, as Grok does for a lapsed login", async () => {
  const lapsed = Object.assign(new Error("Grok request failed (401)."), {
    status: 401,
  });
  const result = await readUsageLimits({
    failureMessage: (error) =>
      error.status === 401 ? "Run `grok login`." : undefined,
    label: "Grok",
    provider: "ladder-grok",
    readLive: async () => {
      throw lapsed;
    },
  });
  assert.equal(result.error, "Run `grok login`.");
});

test("a turn's rate limits are remembered as a full result, as a live read is", async () => {
  storeProviderUsageLimitSnapshot(
    "ladder-turn",
    { primary: { used_percent: 12, window_minutes: 300 } },
    "codex",
  );
  const result = await readUsageLimits({
    label: "Codex",
    provider: "ladder-turn",
    readLive: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(result.source, "codex");
  assert.equal(result.limits.length, 1);
  for (const field of ["modelStats", "stats", "toolStats", "note"])
    assert.ok(field in result, field);
});
