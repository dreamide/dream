import assert from "node:assert/strict";
import { forkSession } from "ai-sdk-provider-claude-code";
import { beforeEach, test, vi } from "vitest";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import { forkClaudeSession, forkCodexThread } from "./native-fork.js";

vi.mock("ai-sdk-provider-claude-code", () => ({ forkSession: vi.fn() }));
vi.mock("./codex-app-server-client.js", () => ({
  getCodexAppServerClient: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
const options = {
  projectPath: "/work",
  model: "model",
  permissionMode: "ask",
  modelSpeed: "standard",
};

test("Claude forks at the recorded native assistant UUID", async () => {
  forkSession.mockResolvedValue({ sessionId: "child" });
  const result = await forkClaudeSession({
    ...options,
    source: {
      provider: "anthropic",
      remoteConversationProjectPath: "/work",
      remoteConversationId: "parent",
      nativeMessageId: "boundary",
    },
  });
  assert.equal(result, "child");
  assert.equal(
    await forkClaudeSession({
      ...options,
      source: { remoteConversationId: "parent", nativeMessageId: null },
    }),
    null,
    "no recorded boundary, no fork",
  );
  assert.deepEqual(forkSession.mock.calls[0], [
    "parent",
    { dir: "/work", upToMessageId: "boundary" },
  ]);
  forkSession.mockResolvedValue({ sessionId: "parent" });
  await assert.rejects(
    forkClaudeSession({
      ...options,
      source: {
        provider: "anthropic",
        remoteConversationProjectPath: "/work",
        remoteConversationId: "parent",
        nativeMessageId: "boundary",
      },
    }),
    /independent fork/,
  );
});

test("Codex forks through an exact completed native turn without touching its parent", async () => {
  const sendRequest = vi.fn().mockResolvedValue({
    thread: { id: "child", turns: [{ id: "boundary" }] },
  });
  getCodexAppServerClient.mockResolvedValue({ sendRequest });
  const source = {
    provider: "openai",
    remoteConversationProjectPath: "/work",
    remoteConversationId: "parent",
    nativeTurnId: "boundary",
  };
  assert.equal(await forkCodexThread({ ...options, source }), "child");
  assert.equal(sendRequest.mock.calls[0][0], "thread/fork");
  assert.equal(sendRequest.mock.calls[0][1].lastTurnId, "boundary");
  assert.equal(
    await forkCodexThread({
      ...options,
      source: { ...source, nativeTurnId: null },
    }),
    null,
  );
  assert.equal(sendRequest.mock.calls.length, 1);
  sendRequest.mockResolvedValue({
    thread: { id: "child", turns: [{ id: "later-turn" }] },
  });
  await assert.rejects(
    forkCodexThread({ ...options, source }),
    /fork boundary/,
  );
});
