import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeGrokUsageLimits,
  normalizeOpenCodeGoUsageLimits,
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
