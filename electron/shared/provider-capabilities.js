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
 * @property {boolean} toolsFixedAtSessionStart Tools registered when a native
 *   session starts cannot change when it resumes (Codex's dynamic tools).
 * @property {BrowserToolsMechanism} browserTools How an Agent turn gets
 *   Dream's browser tools (browser-attach.js).
 */

/**
 * How an Agent turn gets Dream's browser tools.
 * - in-process: an MCP server object handed to the adapter (Claude's SDK).
 * - project-url: the browser MCP endpoint with the project in its URL, in the
 *   turn's MCP servers (a per-session MCP config).
 * - shared-url: the endpoint without a project, in the turn's MCP servers,
 *   for an agent process whose MCP config is fixed when it starts (Codex's
 *   app server); each call names its project by the session it carries.
 * - none: no browser tools.
 * @typedef {"in-process" | "project-url" | "shared-url" | "none"} BrowserToolsMechanism
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
    toolsFixedAtSessionStart: true,
    selectedModelsSetting: "openAiSelectedModels",
    modelAliases: null,
    mcp: true,
    skills: { dispatch: "native" },
    usageLimits: true,
    browserTools: "shared-url",
  },
  anthropic: {
    label: "Claude Code",
    modelSwitchInSession: true,
    nativeFork: true,
    toolsFixedAtSessionStart: false,
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
    browserTools: "in-process",
  },
  opencode: {
    label: "OpenCode",
    modelSwitchInSession: true,
    nativeFork: false,
    toolsFixedAtSessionStart: false,
    selectedModelsSetting: "openCodeSelectedModels",
    modelAliases: null,
    mcp: true,
    skills: {
      dispatch: "instruction",
      verb: "load",
      toolLabel: "the skill tool",
    },
    usageLimits: true,
    browserTools: "project-url",
  },
  cursor: {
    label: "Cursor Agent",
    modelSwitchInSession: false,
    nativeFork: false,
    toolsFixedAtSessionStart: false,
    selectedModelsSetting: "cursorSelectedModels",
    modelAliases: null,
    mcp: false,
    skills: { dispatch: "slash" },
    usageLimits: false,
    browserTools: "none",
  },
  grok: {
    label: "Grok Build",
    modelSwitchInSession: false,
    nativeFork: false,
    toolsFixedAtSessionStart: false,
    selectedModelsSetting: "grokSelectedModels",
    modelAliases: null,
    mcp: true,
    skills: null,
    usageLimits: true,
    browserTools: "project-url",
  },
  antigravity: {
    label: "Antigravity",
    modelSwitchInSession: true,
    nativeFork: false,
    toolsFixedAtSessionStart: false,
    selectedModelsSetting: "antigravitySelectedModels",
    modelAliases: null,
    mcp: false,
    skills: { dispatch: "slash" },
    usageLimits: true,
    browserTools: "none",
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
