import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import {
  beginBrowserTurn,
  getActiveBrowserTurnProjectId,
  resetBrowserTurnsForTests,
} from "./active-browser-turns.js";

beforeEach(() => {
  resetBrowserTurnsForTests();
});

test("returns null when nothing has run", () => {
  assert.equal(getActiveBrowserTurnProjectId(), null);
});

test("resolves the most recently started active turn", () => {
  const endA = beginBrowserTurn({ projectId: "a", provider: "openai" });
  beginBrowserTurn({ projectId: "b", provider: "openai" });
  assert.equal(getActiveBrowserTurnProjectId(), "b");
  endA();
  assert.equal(getActiveBrowserTurnProjectId(), "b");
});

test("filters by provider and falls back to the last ended turn", () => {
  const endCodex = beginBrowserTurn({ projectId: "codex", provider: "openai" });
  beginBrowserTurn({ projectId: "other", provider: "grok" });
  assert.equal(getActiveBrowserTurnProjectId({ provider: "openai" }), "codex");
  endCodex();
  endCodex(); // idempotent
  assert.equal(getActiveBrowserTurnProjectId({ provider: "openai" }), "codex");
  assert.equal(getActiveBrowserTurnProjectId(), "other");
});

test("ignores turns without a project", () => {
  const end = beginBrowserTurn({ projectId: "", provider: "openai" });
  assert.equal(getActiveBrowserTurnProjectId(), null);
  end();
});
