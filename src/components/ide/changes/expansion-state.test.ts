import assert from "node:assert/strict";
import { test } from "vitest";
import { toggleExpandedPathForProject } from "./expansion-state";

test("row clicks toggle expansion exactly once per click", () => {
  const projectId = "project-one";
  const filePath = "src/example.ts";

  const afterFirstClick = toggleExpandedPathForProject({}, projectId, filePath);
  assert.deepEqual(afterFirstClick[projectId], [filePath]);

  const afterSecondClick = toggleExpandedPathForProject(
    afterFirstClick,
    projectId,
    filePath,
  );
  assert.deepEqual(afterSecondClick[projectId], []);

  const afterThirdClick = toggleExpandedPathForProject(
    afterSecondClick,
    projectId,
    filePath,
  );
  assert.deepEqual(afterThirdClick[projectId], [filePath]);
});

test("row clicks preserve expansion state for other projects and files", () => {
  const current = {
    "project-one": ["src/one.ts"],
    "project-two": ["src/two.ts"],
  };

  const next = toggleExpandedPathForProject(
    current,
    "project-one",
    "src/three.ts",
  );

  assert.deepEqual(next, {
    "project-one": ["src/one.ts", "src/three.ts"],
    "project-two": ["src/two.ts"],
  });
});
