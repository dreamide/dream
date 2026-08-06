import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildCodexExecArgs,
  chooseCodexApprovalDecision,
  getCodexAppApprovalPolicy,
  getCodexAppSandboxMode,
  getCodexAppTurnSandboxPolicy,
  getCodexReasoningEffort,
  getCodexTokenCountInfo,
  getCodexTokenCountMetadata,
  writeCodexContextCompactionPart,
} from "./codex-common.js";

test("builds exec args for a new session with default permissions", () => {
  assert.deepEqual(
    buildCodexExecArgs({
      codexPermissionMode: "default",
      model: "gpt-5.4-codex",
      projectPath: "/proj",
    }),
    [
      "exec",
      "--json",
      "--cd",
      "/proj",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4-codex",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
      "-",
    ],
  );
});

test("builds resume exec args with full access, reasoning effort, and fast speed", () => {
  assert.deepEqual(
    buildCodexExecArgs({
      codexPermissionMode: "full-access",
      modelSpeed: "fast",
      projectPath: "/proj",
      reasoningEffort: "high",
      sessionId: "sess-1",
    }),
    [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'service_tier="fast"',
      "sess-1",
      "-",
    ],
  );
});

test("includes add-dir and image flags for new session exec args", () => {
  assert.deepEqual(
    buildCodexExecArgs({
      addDirs: ["/extra"],
      codexPermissionMode: "auto-accept-edits",
      imagePaths: ["/img.png"],
      projectPath: "/proj",
    }),
    [
      "exec",
      "--json",
      "--cd",
      "/proj",
      "--skip-git-repo-check",
      "--add-dir",
      "/extra",
      "--image",
      "/img.png",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "-",
    ],
  );
});

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
  assert.equal(getCodexAppApprovalPolicy("default"), "untrusted");
  assert.equal(getCodexAppApprovalPolicy("full-access"), "never");
  assert.equal(getCodexAppApprovalPolicy("auto-accept-edits"), "never");
  assert.equal(getCodexAppSandboxMode("full-access"), "danger-full-access");
  assert.equal(getCodexAppSandboxMode("default"), "workspace-write");
});

test("builds the turn sandbox policy for workspace and full access modes", () => {
  assert.deepEqual(
    getCodexAppTurnSandboxPolicy({
      codexPermissionMode: "full-access",
      projectPath: "/proj",
    }),
    { type: "dangerFullAccess" },
  );
  assert.deepEqual(
    getCodexAppTurnSandboxPolicy({
      codexPermissionMode: "default",
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
    getCodexTokenCountInfo({
      method: "token_count",
      params: { total_token_usage: {} },
    }),
    { total_token_usage: {} },
  );
  assert.equal(getCodexTokenCountInfo({ type: "other" }), null);
  assert.equal(getCodexTokenCountInfo(null), null);
});

test("builds token count metadata with cache and reasoning details", () => {
  assert.deepEqual(
    getCodexTokenCountMetadata({
      info: {
        last_token_usage: {
          cached_input_tokens: 20,
          input_tokens: 100,
          output_tokens: 50,
          reasoning_output_tokens: 10,
          total_tokens: 160,
        },
        model_context_window: 272000,
      },
      type: "token_count",
    }),
    {
      contextWindow: 272000,
      usage: {
        cachedInputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 20 },
        inputTokens: 100,
        outputTokenDetails: { reasoningTokens: 10 },
        outputTokens: 50,
        reasoningTokens: 10,
      },
    },
  );
});

test("falls back to total tokens when detailed usage numbers are missing", () => {
  assert.deepEqual(
    getCodexTokenCountMetadata({
      info: { total_token_usage: { total_tokens: 500 } },
      type: "token_count",
    }),
    { usage: { inputTokens: 500, outputTokens: 0 } },
  );
  assert.equal(
    getCodexTokenCountMetadata({ info: {}, type: "token_count" }),
    null,
  );
  assert.equal(getCodexTokenCountMetadata({ type: "other" }), null);
});

test("streams Codex context compaction lifecycle updates as one data part", () => {
  const events = [];
  const writeEvent = (event) => events.push(event);
  const item = { id: "compact-1", type: "contextCompaction" };

  assert.equal(
    writeCodexContextCompactionPart(writeEvent, item, "compacting"),
    true,
  );
  assert.equal(
    writeCodexContextCompactionPart(writeEvent, item, "compacted"),
    true,
  );
  assert.deepEqual(events, [
    {
      data: { state: "compacting" },
      id: "compact-1",
      type: "data-context-compaction",
    },
    {
      data: { state: "compacted" },
      id: "compact-1",
      type: "data-context-compaction",
    },
  ]);
});

test("ignores malformed or unrelated context compaction items", () => {
  const events = [];
  const writeEvent = (event) => events.push(event);

  assert.equal(
    writeCodexContextCompactionPart(
      writeEvent,
      { id: "reason-1", type: "reasoning" },
      "compacting",
    ),
    false,
  );
  assert.equal(
    writeCodexContextCompactionPart(
      writeEvent,
      { type: "contextCompaction" },
      "compacting",
    ),
    false,
  );
  assert.deepEqual(events, []);
});
