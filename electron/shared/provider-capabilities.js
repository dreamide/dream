// @ts-check
// What each agent provider can do, as data, shared by the renderer (which
// hides features a provider lacks) and the main process (whose provider
// registry is built on it). Adding a provider means adding a row here and
// a record in electron/api/providers/registry.js.

/** @typedef {import("../../src/types/ide").AiProvider} AiProvider */

/**
 * How a `$skill` mention in the user's message reaches the agent.
 * - native: the CLI parses `$name` itself; the message is sent unchanged.
 * - instruction: an instruction to load the skill through the agent's own
 *   skill tool (`verb` it with `toolLabel`) is appended to the message.
 *   `readUserInvocationOnly`: skills the model may not invoke are pointed
 *   at their SKILL.md to read instead.
 * - slash: the prompt is prefixed with `/name`, the agent's slash command.
 * @typedef {{ dispatch: "native" }
 *   | { dispatch: "instruction", verb: string, toolLabel: string, readUserInvocationOnly?: boolean }
 *   | { dispatch: "slash" }} SkillDispatchStyle
 */

/** @typedef {import("../../src/types/ide").AppSettings} AppSettings */
/**
 * A setting holding a provider's picked models.
 * @typedef {Extract<keyof AppSettings, `${string}SelectedModels`>} SelectedModelsSetting
 */

/**
 * @typedef {object} ProviderCapabilities
 * @property {string} label
 * @property {SelectedModelsSetting} selectedModelsSetting The setting that
 *   holds the models the user picked for this provider.
 * @property {"claude-code" | null} modelAliases How a picked model id is
 *   normalized: Claude Code's aliases (`opus`, `sonnet[1m]`...) or as is.
 * @property {boolean} mcp Dream-managed MCP servers are passed to the agent.
 * @property {SkillDispatchStyle | null} skills `null` when the CLI loads no skills.
 * @property {boolean} usageLimits The provider reports usage limits.
 * @property {boolean} modelSwitchInSession The adapter sets the model on each resumed turn.
 * @property {boolean} nativeFork The adapter can fork from an exact recorded native boundary.
 * @property {"shared" | "project" | null} browserMcpScope How Dream's browser
 *   tools are exposed over MCP: one shared endpoint (a single long-lived
 *   agent process), a per-project endpoint, or not over MCP at all (Claude
 *   gets an in-process server; Cursor gets none).
 */

/** @type {AiProvider[]} */
export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "opencode",
  "cursor",
  "grok",
  "antigravity",
];

/** @type {Record<AiProvider, ProviderCapabilities>} */
export const PROVIDER_CAPABILITIES = {
  openai: {
    label: "Codex",
    modelSwitchInSession: true,
    nativeFork: true,
    selectedModelsSetting: "openAiSelectedModels",
    modelAliases: null,
    mcp: true,
    skills: { dispatch: "native" },
    usageLimits: true,
    browserMcpScope: "shared",
  },
  anthropic: {
    label: "Claude Code",
    modelSwitchInSession: true,
    nativeFork: true,
    selectedModelsSetting: "anthropicSelectedModels",
    modelAliases: "claude-code",
    mcp: true,
    skills: {
      dispatch: "instruction",
      verb: "invoke",
      toolLabel: "the Skill tool",
      readUserInvocationOnly: true,
    },
    usageLimits: true,
    browserMcpScope: null,
  },
  opencode: {
    label: "OpenCode",
    modelSwitchInSession: true,
    nativeFork: false,
    selectedModelsSetting: "openCodeSelectedModels",
    modelAliases: null,
    mcp: true,
    skills: {
      dispatch: "instruction",
      verb: "load",
      toolLabel: "the skill tool",
    },
    usageLimits: true,
    browserMcpScope: "project",
  },
  cursor: {
    label: "Cursor Agent",
    modelSwitchInSession: false,
    nativeFork: false,
    selectedModelsSetting: "cursorSelectedModels",
    modelAliases: null,
    mcp: false,
    skills: { dispatch: "slash" },
    usageLimits: false,
    browserMcpScope: null,
  },
  grok: {
    label: "Grok Build",
    modelSwitchInSession: false,
    nativeFork: false,
    selectedModelsSetting: "grokSelectedModels",
    modelAliases: null,
    mcp: true,
    skills: null,
    usageLimits: true,
    browserMcpScope: "project",
  },
  antigravity: {
    label: "Antigravity",
    modelSwitchInSession: true,
    nativeFork: false,
    selectedModelsSetting: "antigravitySelectedModels",
    modelAliases: null,
    mcp: false,
    skills: { dispatch: "slash" },
    usageLimits: true,
    browserMcpScope: null,
  },
};

/**
 * @param {unknown} value
 * @returns {value is AiProvider}
 */
export const isProviderId = (value) =>
  typeof value === "string" &&
  /** @type {readonly string[]} */ (PROVIDER_IDS).includes(value);

/**
 * @param {AiProvider} provider
 * @returns {ProviderCapabilities}
 */
export const getProviderCapabilities = (provider) => {
  const capabilities = PROVIDER_CAPABILITIES[provider];
  if (!capabilities) {
    throw new Error(`Unknown agent provider: ${String(provider)}`);
  }
  return capabilities;
};
