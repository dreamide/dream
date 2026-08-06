import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type FileBuffersState,
  fileBuffersReducer,
  getFileBufferKey,
  normalizeFileContentForEditor,
  serializeEditorContent,
} from "./file-buffers";

const projectId = "project-1";
const fileA = getFileBufferKey(projectId, "src/a.ts");
const fileB = getFileBufferKey(projectId, "src/b.ts");

const reduce = (
  actions: Parameters<typeof fileBuffersReducer>[1][],
  initial: FileBuffersState = {},
) => actions.reduce(fileBuffersReducer, initial);

test("loading creates a clean buffer", () => {
  const state = reduce([{ type: "load", key: fileA, content: "one" }]);
  assert.deepEqual(state[fileA], {
    diskContent: "one",
    draftContent: "one",
    status: "clean",
    error: null,
  });
});

test("editor serialization round-trips CRLF content", () => {
  const diskContent = "one\r\ntwo\r\n";
  const editorContent = normalizeFileContentForEditor(diskContent, "crlf");
  assert.equal(editorContent, "one\ntwo\n");
  assert.equal(serializeEditorContent(editorContent, "crlf"), diskContent);
});

test("editing marks a buffer dirty and editing back to disk marks it clean", () => {
  const loaded = reduce([{ type: "load", key: fileA, content: "one" }]);
  const dirty = fileBuffersReducer(loaded, {
    type: "edit",
    key: fileA,
    content: "two",
  });
  assert.equal(dirty[fileA]?.status, "dirty");

  const clean = fileBuffersReducer(dirty, {
    type: "edit",
    key: fileA,
    content: "one",
  });
  assert.equal(clean[fileA]?.status, "clean");
});

test("loading and switching files preserves each draft", () => {
  const state = reduce([
    { type: "load", key: fileA, content: "a" },
    { type: "edit", key: fileA, content: "draft a" },
    { type: "load", key: fileB, content: "b" },
    { type: "edit", key: fileB, content: "draft b" },
  ]);

  assert.equal(state[fileA]?.draftContent, "draft a");
  assert.equal(state[fileB]?.draftContent, "draft b");
});

test("refresh removes clean buffers and preserves dirty, saving, and conflict buffers", () => {
  const otherProjectFile = getFileBufferKey("project-2", "other.ts");
  const savingFile = getFileBufferKey(projectId, "saving.ts");
  const conflictFile = getFileBufferKey(projectId, "conflict.ts");
  const state = reduce([
    { type: "load", key: fileA, content: "a" },
    { type: "load", key: fileB, content: "b" },
    { type: "edit", key: fileB, content: "draft b" },
    { type: "load", key: savingFile, content: "saving" },
    { type: "edit", key: savingFile, content: "saving draft" },
    { type: "save-start", key: savingFile },
    { type: "load", key: conflictFile, content: "conflict" },
    { type: "edit", key: conflictFile, content: "conflict draft" },
    { type: "save-conflict", key: conflictFile, error: "changed" },
    { type: "load", key: otherProjectFile, content: "other" },
  ]);

  const refreshed = fileBuffersReducer(state, {
    type: "refresh-project",
    projectId,
  });
  assert.equal(refreshed[fileA], undefined);
  assert.equal(refreshed[fileB]?.draftContent, "draft b");
  assert.equal(refreshed[savingFile]?.status, "saving");
  assert.equal(refreshed[conflictFile]?.status, "conflict");
  assert.equal(refreshed[otherProjectFile]?.status, "clean");
});

test("save success advances disk content and clears the error", () => {
  const state = reduce([
    { type: "load", key: fileA, content: "old" },
    { type: "edit", key: fileA, content: "new" },
    { type: "save-start", key: fileA },
    { type: "save-success", key: fileA, content: "new" },
  ]);

  assert.deepEqual(state[fileA], {
    diskContent: "new",
    draftContent: "new",
    status: "clean",
    error: null,
  });
});

test("save completion updates its target even after another file is used", () => {
  const state = reduce([
    { type: "load", key: fileA, content: "old a" },
    { type: "edit", key: fileA, content: "saved a" },
    { type: "save-start", key: fileA },
    { type: "load", key: fileB, content: "old b" },
    { type: "edit", key: fileB, content: "draft b" },
    { type: "save-success", key: fileA, content: "saved a" },
  ]);

  assert.equal(state[fileA]?.diskContent, "saved a");
  assert.equal(state[fileA]?.status, "clean");
  assert.equal(state[fileB]?.diskContent, "old b");
  assert.equal(state[fileB]?.draftContent, "draft b");
  assert.equal(state[fileB]?.status, "dirty");
});

test("save failure and conflict preserve the draft", () => {
  const saving = reduce([
    { type: "load", key: fileA, content: "old" },
    { type: "edit", key: fileA, content: "local draft" },
    { type: "save-start", key: fileA },
  ]);
  const failed = fileBuffersReducer(saving, {
    type: "save-failure",
    key: fileA,
    error: "failed",
  });
  assert.equal(failed[fileA]?.draftContent, "local draft");
  assert.equal(failed[fileA]?.status, "dirty");

  const conflicted = fileBuffersReducer(saving, {
    type: "save-conflict",
    key: fileA,
    error: "changed on disk",
  });
  assert.equal(conflicted[fileA]?.draftContent, "local draft");
  assert.equal(conflicted[fileA]?.status, "conflict");
});

test("discard restores disk content without changing it", () => {
  const state = reduce([
    { type: "load", key: fileA, content: "disk" },
    { type: "edit", key: fileA, content: "draft" },
    { type: "discard", key: fileA },
  ]);

  assert.equal(state[fileA]?.diskContent, "disk");
  assert.equal(state[fileA]?.draftContent, "disk");
  assert.equal(state[fileA]?.status, "clean");
});
