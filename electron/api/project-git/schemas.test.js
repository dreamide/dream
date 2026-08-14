import assert from "node:assert/strict";
import { test } from "vitest";
import { projectGitStatusRequestSchema } from "./schemas.js";

test("Git status requests default to full detail", () => {
  const parsed = projectGitStatusRequestSchema.parse({
    projectPath: "/tmp/project",
  });

  assert.equal(parsed.detail, "full");
});

test("Git status requests accept lightweight summary detail", () => {
  const parsed = projectGitStatusRequestSchema.parse({
    detail: "summary",
    projectPath: "/tmp/project",
  });

  assert.equal(parsed.detail, "summary");
});

test("Git status requests reject unknown detail levels", () => {
  assert.equal(
    projectGitStatusRequestSchema.safeParse({
      detail: "fastest",
      projectPath: "/tmp/project",
    }).success,
    false,
  );
});
