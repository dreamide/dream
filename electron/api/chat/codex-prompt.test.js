import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getCodexErrorDetail,
  getCodexSessionId,
  isCodexResumeFailure,
} from "./codex-prompt.js";

test("extracts a trimmed Codex session id or null", () => {
  assert.equal(getCodexSessionId("  session-1  "), "session-1");
  assert.equal(getCodexSessionId("   "), null);
  assert.equal(getCodexSessionId(42), null);
  assert.equal(getCodexSessionId(undefined), null);
});

test("recognizes Codex resume failures case-insensitively", () => {
  assert.equal(isCodexResumeFailure("Thread/Resume Failed: boom"), true);
  assert.equal(
    isCodexResumeFailure("error: No rollout found for thread id abc"),
    true,
  );
  assert.equal(isCodexResumeFailure("some other error"), false);
  assert.equal(isCodexResumeFailure(null), false);
});

test("extracts Codex error detail from direct, JSON-encoded, and nested messages", () => {
  assert.equal(
    getCodexErrorDetail({ message: "plain failure" }),
    "plain failure",
  );
  assert.equal(
    getCodexErrorDetail({ message: '{"error":{"message":"inner boom"}}' }),
    "inner boom",
  );
  assert.equal(
    getCodexErrorDetail({ error: { message: "nested failure" } }),
    "nested failure",
  );
  assert.equal(getCodexErrorDetail({}), null);
  assert.equal(getCodexErrorDetail("not an object"), null);
});
