import { describe, expect, it } from "vitest";
import {
  CURSOR_ACP_AUTO_MODEL_ID,
  resolveCursorAcpModelId,
  toDreamCursorModelId,
} from "./cursor-acp.js";

// A slice of what `session/new` lists on Cursor Agent 2026.09.26.
const availableModels = [
  { modelId: "default[]", name: "Auto" },
  { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
  {
    modelId: "claude-opus-5-5[context=300k,effort=medium,fast=false]",
    name: "claude-opus-5-5",
  },
  {
    modelId: "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]",
    name: "claude-opus-5",
  },
  {
    modelId: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
    name: "gpt-5.6-sol",
  },
];

describe("resolveCursorAcpModelId", () => {
  it("maps Dream's Auto aliases to Cursor's Auto", () => {
    for (const model of [
      "auto",
      "Auto",
      "cursor-auto",
      "",
      null,
      "default[]",
    ]) {
      expect(resolveCursorAcpModelId(model, availableModels)).toBe(
        CURSOR_ACP_AUTO_MODEL_ID,
      );
    }
  });

  it("passes through ids the session lists", () => {
    expect(
      resolveCursorAcpModelId("composer-2.5[fast=true]", availableModels),
    ).toBe("composer-2.5[fast=true]");
  });

  it("maps flat ids saved by older chats to the matching model", () => {
    expect(
      resolveCursorAcpModelId("gpt-5.6-sol-medium-fast", availableModels),
    ).toBe("gpt-5.6-sol[context=272k,reasoning=medium,fast=false]");
    expect(resolveCursorAcpModelId("composer-2.5", availableModels)).toBe(
      "composer-2.5[fast=true]",
    );
  });

  it("prefers the longest matching base name", () => {
    expect(
      resolveCursorAcpModelId("claude-opus-5-5-thinking-high", availableModels),
    ).toBe("claude-opus-5-5[context=300k,effort=medium,fast=false]");
    expect(
      resolveCursorAcpModelId("claude-opus-5-thinking-high", availableModels),
    ).toBe("claude-opus-5[thinking=true,context=300k,effort=high,fast=false]");
  });

  it("returns null for models the session does not offer", () => {
    expect(resolveCursorAcpModelId("gpt-4o", availableModels)).toBeNull();
    expect(resolveCursorAcpModelId("gpt-5.6", availableModels)).toBeNull();
    expect(resolveCursorAcpModelId("gpt-5.6-sol", [])).toBeNull();
  });
});

describe("toDreamCursorModelId", () => {
  it("keeps `auto` as Dream's id for Cursor Auto", () => {
    expect(toDreamCursorModelId("default[]")).toBe("auto");
    expect(toDreamCursorModelId("composer-2.5[fast=true]")).toBe(
      "composer-2.5[fast=true]",
    );
  });
});
