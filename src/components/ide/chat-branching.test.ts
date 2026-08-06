import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import {
  createBranchedChatConfig,
  getMessagesThroughBranchPoint,
} from "./chat-branching";

const messages = [
  {
    id: "user-one",
    role: "user",
    parts: [
      { text: "Inspect this", type: "text" },
      {
        filename: "screenshot.png",
        mediaType: "image/png",
        type: "file",
        url: "data:image/png;base64,AAAA",
      },
    ],
  },
  {
    id: "assistant-one",
    role: "assistant",
    parts: [
      {
        input: { path: "README.md" },
        output: { text: "hello" },
        state: "output-available",
        toolCallId: "tool-one",
        type: "tool-read_file",
      },
      { text: "Done", type: "text" },
    ],
  },
  {
    id: "user-two",
    role: "user",
    parts: [{ text: "Later", type: "text" }],
  },
] as UIMessage[];

const sourceChat = {
  agentMode: "plan",
  branchedFrom: null,
  createdAt: "2026-08-05T12:00:00.000Z",
  deletedAt: null,
  id: "source-chat",
  model: "gpt-5.6",
  modelSpeed: "fast",
  permissionMode: "standard",
  projectId: "source-project",
  provider: "openai",
  reasoningEffort: "high",
  remoteConversationId: "remote-one",
  remoteConversationModel: "gpt-5.6",
  remoteConversationModelSpeed: "fast",
  remoteConversationProjectPath: "/source",
  sparklesPalette: "violet",
  title: "Investigate persistence",
  updatedAt: "2026-08-05T12:01:00.000Z",
} as ChatConfig;

const targetProject = {
  id: "target-project",
  model: "other-model",
  modelSpeed: "standard",
  provider: "anthropic",
  reasoningEffort: null,
} as ProjectConfig;

test("selects and deep-clones the inclusive transcript prefix", () => {
  const prefix = getMessagesThroughBranchPoint(messages, "assistant-one");

  assert.deepEqual(prefix, messages.slice(0, 2));
  assert.notEqual(prefix, messages);
  assert.notEqual(prefix[0], messages[0]);
  assert.notEqual(prefix[0].parts, messages[0].parts);
  assert.equal(prefix[0].parts[1]?.type, "file");
  assert.equal(prefix[1].parts[0]?.type, "tool-read_file");

  (prefix[0].parts[0] as { text: string }).text = "Changed";
  assert.equal((messages[0].parts[0] as { text: string }).text, "Inspect this");
});

test("rejects a missing branch message", () => {
  assert.throws(
    () => getMessagesThroughBranchPoint(messages, "missing"),
    /Unable to find branch message/,
  );
});

test("inherits chat settings while clearing provider session metadata", () => {
  const branch = createBranchedChatConfig(
    sourceChat,
    targetProject,
    "assistant-one",
  );

  assert.equal(branch.projectId, targetProject.id);
  assert.equal(branch.title, "Investigate persistence (branch)");
  assert.equal(branch.agentMode, sourceChat.agentMode);
  assert.equal(branch.permissionMode, sourceChat.permissionMode);
  assert.equal(branch.provider, sourceChat.provider);
  assert.equal(branch.model, sourceChat.model);
  assert.equal(branch.modelSpeed, sourceChat.modelSpeed);
  assert.equal(branch.reasoningEffort, sourceChat.reasoningEffort);
  assert.equal(branch.sparklesPalette, sourceChat.sparklesPalette);
  assert.deepEqual(branch.branchedFrom, {
    chatId: sourceChat.id,
    messageId: "assistant-one",
  });
  assert.equal(branch.remoteConversationId, null);
  assert.equal(branch.remoteConversationModel, null);
  assert.equal(branch.remoteConversationModelSpeed, null);
  assert.equal(branch.remoteConversationProjectPath, null);
});
