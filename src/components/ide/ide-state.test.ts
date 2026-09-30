import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import type { ProjectConfig } from "@/types/ide";
import {
  areProjectListsEqualExceptLastUsedAt,
  areProjectsEqualExceptLastUsedAt,
  renderUserMessageText,
} from "./ide-state";

const project = {
  id: "project-one",
  lastUsedAt: "2026-07-19T12:00:00.000Z",
  name: "Project One",
  path: "C:\\projects\\project-one",
  ui: {},
} as ProjectConfig;

const createUserMessage = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: "message-one", parts, role: "user" }) as UIMessage;

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

test("renderUserMessageText joins text sections and labels attachments", () => {
  const message = createUserMessage([
    { text: "  First paragraph  ", type: "text" },
    { text: "   ", type: "text" },
    {
      filename: "screenshot.png",
      mediaType: "image/png",
      type: "file",
      url: "file:///tmp/screenshot.png",
    },
    { mediaType: "application/pdf", type: "file", url: "file:///tmp/doc.pdf" },
    { state: "done", text: "thinking", type: "reasoning" },
  ] as UIMessage["parts"]);

  assert.equal(
    renderUserMessageText(message),
    "First paragraph\n\n[Attached file: screenshot.png]\n\n[Attached file: application/pdf]",
  );
  assert.equal(renderUserMessageText(createUserMessage([])), "");
});
