import assert from "node:assert/strict";
import { test } from "vitest";
import {
  chooseCodexApprovalDecision,
  getCodexAppApprovalPolicy,
  getCodexAppSandboxMode,
  getCodexAppTurnSandboxPolicy,
  getCodexReasoningEffort,
  getCodexTokenCountInfo,
  getCodexTokenCountUsage,
} from "./codex-common.js";

test("chooses approval decisions based on approval, scope, and availability", () => {
  assert.equal(chooseCodexApprovalDecision({ approved: false }), "decline");
  assert.equal(
    chooseCodexApprovalDecision({
      approved: false,
      availableDecisions: ["accept", "cancel"],
    }),
    "cancel",
  );
  assert.equal(
    chooseCodexApprovalDecision({ approved: true, scope: "session" }),
    "acceptForSession",
  );
  assert.equal(
    chooseCodexApprovalDecision({
      approved: true,
      availableDecisions: ["accept"],
      scope: "session",
    }),
    "accept",
  );
  assert.equal(
    chooseCodexApprovalDecision({ approved: true, scope: "once" }),
    "accept",
  );
});

test("maps permission modes to app approval policy and sandbox mode", () => {
  assert.equal(getCodexAppApprovalPolicy("ask"), "untrusted");
  assert.equal(getCodexAppApprovalPolicy("full-access"), "never");
  assert.equal(getCodexAppApprovalPolicy("auto-accept-edits"), "on-request");
  assert.equal(getCodexAppSandboxMode("full-access"), "danger-full-access");
  assert.equal(getCodexAppSandboxMode("ask"), "read-only");
  assert.equal(getCodexAppSandboxMode("auto-accept-edits"), "workspace-write");
});

test("builds the turn sandbox policy for workspace and full access modes", () => {
  assert.deepEqual(
    getCodexAppTurnSandboxPolicy({
      permissionMode: "full-access",
      projectPath: "/proj",
    }),
    { type: "dangerFullAccess" },
  );
  assert.deepEqual(
    getCodexAppTurnSandboxPolicy({
      permissionMode: "auto-accept-edits",
      projectPath: "/proj",
    }),
    {
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
      readOnlyAccess: { type: "fullAccess" },
      type: "workspaceWrite",
      writableRoots: ["/proj"],
    },
  );
});

test("normalizes reasoning effort with max mapped to xhigh and medium default", () => {
  assert.equal(getCodexReasoningEffort("max"), "xhigh");
  assert.equal(getCodexReasoningEffort("low"), "low");
  assert.equal(getCodexReasoningEffort(undefined), "medium");
  assert.equal(getCodexReasoningEffort(null), "medium");
});

test("extracts token count info from the supported event shapes", () => {
  assert.deepEqual(
    getCodexTokenCountInfo({ info: { a: 1 }, type: "token_count" }),
    { a: 1 },
  );
  assert.deepEqual(
    getCodexTokenCountInfo({
      payload: { info: { b: 2 }, type: "token_count" },
      type: "event_msg",
    }),
    { b: 2 },
  );
  assert.deepEqual(
    getCodexTokenCountInfo({
      method: "token_count",
      params: { info: { c: 3 } },
    }),
    { c: 3 },
  );
  assert.deepEqual(
    getCodexTokenCountInfo({ method: "token_count", params: { d: 4 } }),
    { d: 4 },
  );
  assert.equal(getCodexTokenCountInfo({ type: "other" }), null);
  assert.equal(getCodexTokenCountInfo(null), null);
});

test("reads usage numbers with cache and reasoning details for the turn writer", () => {
  assert.deepEqual(
    getCodexTokenCountUsage({
      info: {
        last_token_usage: {
          cached_input_tokens: 20,
          input_tokens: 100,
          output_tokens: 40,
          reasoning_output_tokens: 10,
        },
        model_context_window: 200_000,
      },
      type: "token_count",
    }),
    {
      contextWindow: 200_000,
      usage: {
        cacheReadTokens: 20,
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 10,
      },
    },
  );
});

test("falls back to total tokens when detailed usage numbers are missing", () => {
  assert.deepEqual(
    getCodexTokenCountUsage({
      info: { total_token_usage: { total_tokens: 55 } },
      type: "token_count",
    }),
    {
      usage: {
        cacheReadTokens: 0,
        inputTokens: 55,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    },
  );
  assert.equal(
    getCodexTokenCountUsage({ info: {}, type: "token_count" }),
    null,
  );
  assert.equal(getCodexTokenCountUsage({ type: "other" }), null);
});
