import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectConfig } from "@/types/ide";
import {
  areProjectListsEqualExceptLastUsedAt,
  areProjectsEqualExceptLastUsedAt,
} from "./ide-state";

const project = {
  id: "project-one",
  lastUsedAt: "2026-07-19T12:00:00.000Z",
  name: "Project One",
  path: "C:\\projects\\project-one",
  ui: {},
} as ProjectConfig;

test("project comparison ignores recency-only updates", () => {
  const touchedProject = {
    ...project,
    lastUsedAt: "2026-07-19T12:01:00.000Z",
  };

  assert.equal(areProjectsEqualExceptLastUsedAt(project, touchedProject), true);
  assert.equal(
    areProjectListsEqualExceptLastUsedAt([project], [touchedProject]),
    true,
  );
});

test("project comparison keeps meaningful workspace changes", () => {
  assert.equal(
    areProjectsEqualExceptLastUsedAt(project, {
      ...project,
      name: "Renamed Project",
    }),
    false,
  );
});
