import { describe, expect, it } from "vitest";
import {
  getProviderSessionMetadata,
  shouldResumeProviderSession,
} from "./provider-session.js";

const matchingSession = {
  model: "model-a",
  modelSpeed: "standard",
  projectPath: "/workspace/project",
  remoteConversationId: "session-1",
  remoteConversationModel: "model-a",
  remoteConversationModelSpeed: "standard",
  remoteConversationProjectPath: "/workspace/project",
};

describe("shouldResumeProviderSession", () => {
  it("resumes only when the session belongs to the active model and project", () => {
    expect(shouldResumeProviderSession(matchingSession)).toBe(true);
    expect(
      shouldResumeProviderSession({
        ...matchingSession,
        remoteConversationModel: "model-b",
      }),
    ).toBe(false);
    expect(
      shouldResumeProviderSession({
        ...matchingSession,
        remoteConversationProjectPath: "/workspace/other",
      }),
    ).toBe(false);
  });

  it("treats legacy sessions without a speed as standard speed", () => {
    expect(
      shouldResumeProviderSession({
        ...matchingSession,
        remoteConversationModelSpeed: null,
      }),
    ).toBe(true);
    expect(
      shouldResumeProviderSession({
        ...matchingSession,
        modelSpeed: "fast",
        remoteConversationModelSpeed: null,
      }),
    ).toBe(false);
  });
});

describe("getProviderSessionMetadata", () => {
  it("adds the durable provider session identity to response metadata", () => {
    expect(
      getProviderSessionMetadata({
        model: "model-a",
        projectPath: "/workspace/project",
        responseMessageMetadata: { createdAt: "now" },
        sessionId: "session-1",
      }),
    ).toEqual({
      createdAt: "now",
      remoteConversationId: "session-1",
      remoteConversationModel: "model-a",
      remoteConversationModelSpeed: "standard",
      remoteConversationProjectPath: "/workspace/project",
    });
  });
});
