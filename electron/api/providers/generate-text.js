// One-shot text generation through each agent CLI: a single prompt in, the
// agent's final text out, no tools and no session kept. Used for chat
// titles, commit messages and pull request text through the provider
// registry. Every runner takes the same options; a CLI with no system
// prompt slot gets `system` inlined ahead of the prompt. Every runner stops
// after `timeoutMs` (two minutes by default) or when `signal` aborts; the
// spawned CLIs run through agent-cli-run.js.
import { generateText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import {
  CLAUDE_REASONING_EFFORT_MAP,
  getModelReasoningEfforts,
  normalizeClaudeCodeModel,
} from "../../shared/model-options.js";
import {
  getCodexCliSpawnErrorMessage,
  resolveCodexCliLaunch,
} from "../chat/codex-cli-launch.js";
import { getCodexReasoningEffort } from "../chat/codex-common.js";
import { getCodexErrorDetail } from "../chat/codex-prompt.js";
import { resolveCliCommandPath } from "../shared/cli.js";
import {
  createAgentCliStopError,
  createAgentCliTimeoutError,
  runAgentCli,
} from "./agent-cli-run.js";
import {
  assertSafeAntigravityArg,
  getAntigravityCliSpawnErrorMessage,
  getAntigravityErrorText,
  getAntigravityPromptInput,
  getAntigravityResultError,
  resolveAntigravityCliLaunch,
  resolveAntigravityEffort,
} from "./antigravity-cli.js";
import {
  getCursorCliSpawnErrorMessage,
  normalizeCursorCliModel,
  resolveCursorCliLaunch,
} from "./cursor-cli.js";
import { runGrokPrompt } from "./grok-acp.js";
import {
  createOpenCodeSession,
  withOpenCodeServer,
} from "./opencode-server.js";

const DEFAULT_TEXT_TIMEOUT_MS = 120_000;
// A one-shot prompt's server may take longer to start than a turn's.
const OPENCODE_TEXT_SERVER_TIMEOUT_MS = 15_000;

const inlineSystemPrompt = (system, prompt) =>
  system ? `${system}\n\n${prompt}` : prompt;

/**
 * Runs `request(requestSignal)` for a runner that talks to its CLI through a
 * library rather than agent-cli-run.js: the signal aborts after `timeoutMs`
 * or with `signal`, and the rejection says which.
 */
const withRequestSignal = async (label, { signal, timeoutMs }, request) => {
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const requestSignal = AbortSignal.any(
    [signal, timeoutSignal].filter(Boolean),
  );
  try {
    return await request(requestSignal);
  } catch (error) {
    if (signal?.aborted) {
      throw createAgentCliStopError(label);
    }
    if (timeoutSignal?.aborted) {
      throw createAgentCliTimeoutError(label, timeoutMs);
    }
    throw error;
  }
};

export const runClaudePrompt = async ({
  model,
  prompt,
  projectPath,
  reasoningEffort,
  signal,
  system,
  timeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
}) => {
  const claudeExecutablePath = await resolveCliCommandPath("claude");
  const claudeModel = normalizeClaudeCodeModel(model || "haiku");
  // `undefined` effort (callers that predate the setting) keeps the model's
  // own default; `null` is the explicit "medium" default.
  const usesReasoningModel =
    reasoningEffort !== undefined &&
    getModelReasoningEfforts("anthropic", claudeModel).length > 0;
  // The provider stops the Claude Code process when the signal aborts.
  const result = await withRequestSignal(
    "Claude",
    { signal, timeoutMs },
    (abortSignal) =>
      generateText({
        abortSignal,
        model: claudeCode(claudeModel, {
          ...(claudeExecutablePath
            ? { pathToClaudeCodeExecutable: claudeExecutablePath }
            : {}),
          continue: false,
          cwd: projectPath,
          persistSession: false,
          permissionMode: "plan",
          mcpServers: {},
          strictMcpConfig: true,
          ...(usesReasoningModel
            ? {
                effort:
                  CLAUDE_REASONING_EFFORT_MAP[reasoningEffort ?? "medium"],
              }
            : {}),
        }),
        prompt,
        ...(system ? { instructions: system } : {}),
      }),
  );

  return result.text;
};

export const runCodexPrompt = async ({
  model,
  modelSpeed = "standard",
  prompt,
  projectPath,
  reasoningEffort,
  signal,
  system,
  timeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
}) => {
  const launch = await resolveCodexCliLaunch();
  let latestText = "";
  await runAgentCli({
    args: [
      "exec",
      "--json",
      "--cd",
      projectPath,
      "--skip-git-repo-check",
      ...(model ? ["--model", model] : []),
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      "-c",
      // Callers that predate the text generation effort setting keep the
      // original low effort.
      `model_reasoning_effort=${JSON.stringify(
        reasoningEffort === undefined
          ? "low"
          : getCodexReasoningEffort(reasoningEffort),
      )}`,
      ...(modelSpeed === "fast" ? ["-c", 'service_tier="fast"'] : []),
      "-",
    ],
    cwd: projectPath,
    label: "Codex",
    launch,
    // Codex reports retries as error events and may still succeed, so an
    // error event only words a failed exit.
    onEvent: (event, run) => {
      if (!event || typeof event !== "object") {
        return;
      }

      if (event.type === "error" || event.type === "turn.failed") {
        run.reportError(getCodexErrorDetail(event));
        return;
      }

      const item = event.item;
      if (
        event.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        latestText = item.text;
      }
    },
    signal,
    spawnErrorMessage: getCodexCliSpawnErrorMessage,
    stdin: inlineSystemPrompt(system, prompt),
    timeoutMs,
  });
  return latestText;
};

export const parseOpenCodeModel = (model) => {
  const [providerID, ...modelParts] = String(model ?? "").split("/");
  const modelID = modelParts.join("/");

  if (!providerID || !modelID) {
    throw new Error(
      "OpenCode model must use provider/model format, for example opencode-go/kimi-k2.6.",
    );
  }

  return { modelID, providerID };
};

const getOpenCodePartText = (part) =>
  part?.type === "text" && typeof part.text === "string" ? part.text : "";

export const runOpenCodePrompt = async ({
  model,
  prompt,
  projectPath,
  signal,
  system,
  timeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
}) => {
  const requestedModel = typeof model === "string" ? model.trim() : "";
  if (!requestedModel) {
    throw new Error("No OpenCode model is available.");
  }

  const openCodeModel = parseOpenCodeModel(requestedModel);
  return withRequestSignal("OpenCode", { signal, timeoutMs }, (requestSignal) =>
    withOpenCodeServer(
      {
        signal: requestSignal,
        timeoutMs: OPENCODE_TEXT_SERVER_TIMEOUT_MS,
      },
      async (client) => {
        const sessionId = await createOpenCodeSession(client, {
          agent: "plan",
          directory: projectPath,
          model: openCodeModel,
          signal: requestSignal,
        });
        const promptResult = await client.session.prompt({
          body: {
            agent: "plan",
            model: openCodeModel,
            parts: [{ text: inlineSystemPrompt(system, prompt), type: "text" }],
          },
          path: { id: sessionId },
          query: { directory: projectPath },
          signal: requestSignal,
        });
        return (promptResult.data?.parts ?? [])
          .map(getOpenCodePartText)
          .join(" ");
      },
    ),
  );
};

const getCursorEventText = (event) => {
  if (!event || typeof event !== "object") {
    return "";
  }

  if (event.type === "result" && typeof event.result === "string") {
    return event.result;
  }

  if (event.type !== "assistant" || !event.message) {
    return "";
  }

  const content = event.message.content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part?.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  }

  return typeof event.message.text === "string" ? event.message.text : "";
};

export const runCursorPrompt = async ({
  model,
  prompt,
  projectPath,
  signal,
  system,
  timeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
}) => {
  const launch = await resolveCursorCliLaunch();
  let latestText = "";
  await runAgentCli({
    args: [
      "-p",
      "--trust",
      "--output-format",
      "stream-json",
      "--mode",
      "ask",
      "--model",
      normalizeCursorCliModel(model),
      inlineSystemPrompt(system, prompt),
    ],
    cwd: projectPath,
    label: "Cursor",
    launch,
    onEvent: (event, run) => {
      const text = getCursorEventText(event);
      if (text) {
        latestText += text;
        if (event.type === "result") {
          latestText = text;
        }
      }

      if (event?.type === "error") {
        run.reportError(
          typeof event.message === "string"
            ? event.message
            : typeof event.error === "string"
              ? event.error
              : "",
        );
      }
    },
    signal,
    spawnErrorMessage: getCursorCliSpawnErrorMessage,
    timeoutMs,
  });
  return latestText;
};

export const runGrokTextPrompt = ({
  model,
  prompt,
  projectPath,
  signal,
  system,
  timeoutMs,
}) =>
  runGrokPrompt({
    cwd: projectPath,
    model,
    prompt: inlineSystemPrompt(system, prompt),
    signal,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

export const runAntigravityPrompt = async ({
  model,
  prompt,
  projectPath,
  reasoningEffort,
  signal,
  system,
  timeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
}) => {
  const launch = await resolveAntigravityCliLaunch();
  assertSafeAntigravityArg(launch, model, "model");
  const effectiveEffort = resolveAntigravityEffort(model, reasoningEffort);
  const promptInput = getAntigravityPromptInput(
    launch,
    inlineSystemPrompt(system, prompt),
  );
  // The CLI's own print timeout ends a quiet run before ours kills it.
  const timeoutArgs =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? ["--print-timeout", `${Math.ceil(timeoutMs / 1000)}s`]
      : [];

  let latestText = "";
  let errorDetails = "";
  await runAgentCli({
    args: [
      "--output-format",
      "stream-json",
      "--mode",
      "plan",
      "--disable-slash-commands",
      ...timeoutArgs,
      ...(model ? ["--model", model] : []),
      ...(effectiveEffort ? ["--effort", effectiveEffort] : []),
      ...promptInput.args,
    ],
    cwd: projectPath,
    label: "Antigravity",
    launch,
    onEvent: (event, run) => {
      if (!event || typeof event !== "object") return;
      if (event.event === "step_update") {
        const update = event.step_update;
        if (
          update?.step_type === "agent_response" &&
          typeof update.text_delta === "string"
        ) {
          latestText += update.text_delta;
        }
      }
      if (event.event === "result") {
        if (typeof event.result?.response === "string") {
          latestText = event.result.response;
        }
        const resultError = getAntigravityResultError(event.result);
        if (resultError) {
          errorDetails = resultError;
          run.reportError(errorDetails);
        }
      }
      if (typeof event.response === "string") {
        latestText = event.response;
      }
      if (event.status === "ERROR" || event.error) {
        errorDetails =
          getAntigravityErrorText(event.error) ||
          "Antigravity generation failed.";
        run.reportError(errorDetails);
      }
    },
    signal,
    spawnErrorMessage: getAntigravityCliSpawnErrorMessage,
    stdin: promptInput.stdin,
    timeoutMs,
  });
  // The CLI can report a failed request and still exit with code 0.
  if (errorDetails) {
    throw new Error(errorDetails);
  }
  return latestText;
};
