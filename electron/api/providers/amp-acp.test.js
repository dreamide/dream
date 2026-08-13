import { describe, expect, it, vi } from "vitest";
import {
  applyAmpSessionOptions,
  getAmpModelOptions,
  getAmpReasoningEfforts,
  initializeAmpAcp,
  isAmpAcpVersionSupported,
} from "./amp-acp.js";

const session = {
  sessionId: "session-1",
  configOptions: [
    {
      category: "model",
      id: "amp-mode",
      options: [
        { value: "smart", name: "Smart" },
        { value: "deep", name: "Deep" },
      ],
    },
    {
      category: "mode",
      id: "permission",
      options: [{ value: "default" }, { value: "bypass" }],
    },
    {
      category: "thought_level",
      id: "effort",
      options: [{ value: "high" }, { value: "max" }],
    },
  ],
};

describe("Amp ACP configuration", () => {
  it("requires an adapter compatible with current Amp CLI releases", () => {
    expect(isAmpAcpVersionSupported("0.8.1")).toBe(false);
    expect(isAmpAcpVersionSupported("0.8.99")).toBe(false);
    expect(isAmpAcpVersionSupported("0.9.0")).toBe(true);
    expect(isAmpAcpVersionSupported("0.9.1")).toBe(true);
    expect(isAmpAcpVersionSupported("1.0.0")).toBe(true);
    expect(isAmpAcpVersionSupported(null)).toBe(false);
    expect(isAmpAcpVersionSupported("v0.9.0")).toBe(false);
    expect(isAmpAcpVersionSupported("0.9.0-beta.1")).toBe(false);
  });

  it("validates the adapter identity and version during initialization", async () => {
    const request = vi.fn().mockResolvedValue({
      agentInfo: { name: "amp-acp", version: "0.9.0" },
    });
    await expect(initializeAmpAcp({ request })).resolves.toMatchObject({
      agentInfo: { name: "amp-acp", version: "0.9.0" },
    });

    request.mockResolvedValueOnce({
      agentInfo: { name: "amp-acp", version: "0.8.99" },
    });
    await expect(initializeAmpAcp({ request })).rejects.toThrow(
      "Install amp-acp 0.9.0 or newer",
    );

    request.mockResolvedValueOnce({
      agentInfo: { name: "acp-amp", version: "1.0.0" },
    });
    await expect(initializeAmpAcp({ request })).rejects.toThrow(
      "expected amp-acp",
    );
  });

  it("uses the caller timeout while initializing", async () => {
    const request = vi.fn().mockResolvedValue({
      agentInfo: { name: "amp-acp", version: "0.9.0" },
    });

    await initializeAmpAcp({ request }, 120_000);

    expect(request).toHaveBeenCalledWith(
      "initialize",
      { clientCapabilities: {}, protocolVersion: 1 },
      120_000,
    );
  });

  it("extracts model-category options", () => {
    expect(getAmpModelOptions(session)).toEqual([
      { value: "smart", name: "Smart" },
      { value: "deep", name: "Deep" },
    ]);
  });

  it("extracts the currently advertised effort options", () => {
    expect(getAmpReasoningEfforts(session)).toEqual(["high", "max"]);
    expect(
      getAmpReasoningEfforts({
        ...session,
        configOptions: session.configOptions.filter(
          (option) => option.id !== "effort",
        ),
      }),
    ).toEqual([]);
  });

  it("applies supported mode, full-access permission, and effort", async () => {
    const request = vi.fn().mockResolvedValue({});
    await applyAmpSessionOptions({ request }, session, {
      model: "deep",
      codexPermissionMode: "full-access",
      reasoningEffort: "max",
    });
    expect(request.mock.calls).toEqual([
      [
        "session/set_config_option",
        { sessionId: "session-1", configId: "amp-mode", value: "deep" },
      ],
      [
        "session/set_config_option",
        { sessionId: "session-1", configId: "permission", value: "bypass" },
      ],
      [
        "session/set_config_option",
        { sessionId: "session-1", configId: "effort", value: "max" },
      ],
    ]);
  });

  it("does not send an effort unsupported after changing mode", async () => {
    const request = vi.fn().mockImplementation(async (_method, params) => {
      if (params.configId !== "amp-mode") return {};
      return {
        configOptions: session.configOptions.map((option) =>
          option.id === "effort"
            ? { ...option, options: [{ value: "low" }] }
            : option,
        ),
      };
    });

    await applyAmpSessionOptions({ request }, session, {
      model: "deep",
      codexPermissionMode: "default",
      reasoningEffort: "max",
    });

    expect(request.mock.calls).toEqual([
      [
        "session/set_config_option",
        { sessionId: "session-1", configId: "amp-mode", value: "deep" },
      ],
      [
        "session/set_config_option",
        { sessionId: "session-1", configId: "permission", value: "default" },
      ],
    ]);
  });

  it("uses the caller timeout for every configuration request", async () => {
    const request = vi.fn().mockResolvedValue({});

    await applyAmpSessionOptions(
      { request },
      session,
      {
        model: "deep",
        codexPermissionMode: "full-access",
        reasoningEffort: "max",
      },
      120_000,
    );

    expect(request).toHaveBeenCalledTimes(3);
    for (const call of request.mock.calls) {
      expect(call[2]).toBe(120_000);
    }
  });

  it("reports a missing model selection separately", async () => {
    const request = vi.fn().mockResolvedValue({});

    await expect(
      applyAmpSessionOptions({ request }, session, {
        codexPermissionMode: "default",
      }),
    ).rejects.toThrow("requires a model selection");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects unsupported models and missing full-access bypass", async () => {
    const request = vi.fn().mockResolvedValue({});
    await expect(
      applyAmpSessionOptions({ request }, session, {
        model: "unknown",
        codexPermissionMode: "default",
      }),
    ).rejects.toThrow('requested model "unknown"');
    expect(request).not.toHaveBeenCalled();

    await expect(
      applyAmpSessionOptions(
        { request },
        {
          ...session,
          configOptions: session.configOptions.map((option) =>
            option.id === "permission"
              ? { ...option, options: [{ value: "default" }] }
              : option,
          ),
        },
        { model: "deep", codexPermissionMode: "full-access" },
      ),
    ).rejects.toThrow('requested permission mode "bypass"');
  });
});
