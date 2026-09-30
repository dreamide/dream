// Every provider record has the whole interface, and the capabilities the
// renderer reads are the ones the server acts on.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getProviderCapabilities,
  isProviderId,
  PROVIDER_CAPABILITIES,
  PROVIDER_IDS,
} from "../../shared/provider-capabilities.js";
import { getProvider, listProviders } from "./registry.js";

test("every provider has a complete record", () => {
  for (const provider of listProviders()) {
    for (const key of [
      "checkReady",
      "stream",
      "generateText",
      "titleModel",
      "fetchModels",
      "fetchUsageLimits",
    ]) {
      assert.equal(typeof provider[key], "function", `${provider.id}.${key}`);
    }
    assert.equal(typeof provider.label, "string");
    assert.deepEqual(
      {
        browserMcpScope: provider.browserMcpScope,
        label: provider.label,
        mcp: provider.mcp,
        skills: provider.skills,
        usageLimits: provider.usageLimits,
      },
      PROVIDER_CAPABILITIES[provider.id],
    );
  }
  assert.deepEqual(
    listProviders().map((provider) => provider.id),
    PROVIDER_IDS,
  );
});

test("unknown providers are refused, not defaulted", () => {
  assert.throws(() => getProvider("gemini"), /Unknown agent provider: gemini/);
  assert.throws(() => getProviderCapabilities("gemini"));
  assert.equal(isProviderId("grok"), true);
  assert.equal(isProviderId("gemini"), false);
});

test("title models follow each provider's cheap-title policy", () => {
  assert.equal(getProvider("anthropic").titleModel(""), "haiku");
  assert.equal(getProvider("anthropic").titleModel(" opus "), "opus");
  assert.equal(getProvider("cursor").titleModel("composer"), null);
  assert.equal(getProvider("grok").titleModel(""), null);
  assert.equal(getProvider("grok").titleModel("grok-4"), "grok-4");
  assert.throws(
    () => getProvider("openai").titleModel(""),
    /No OpenAI title model/,
  );
  assert.throws(
    () => getProvider("opencode").titleModel(undefined),
    /No OpenCode title model/,
  );
});

test("cursor reports usage limits as unavailable", async () => {
  const result = await getProvider("cursor").fetchUsageLimits();
  assert.equal(result.status, "unavailable");
  assert.equal(result.provider, "cursor");
});
