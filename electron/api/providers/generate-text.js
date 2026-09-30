// One-shot text generation through each agent CLI: a single prompt in, the
// agent's final text out, no tools and no session kept. Used for chat
// titles, commit messages and pull request text through the provider
// registry. Every runner takes the same options; a CLI with no system
// prompt slot gets `system` inlined ahead of the prompt.
import { spawn } from "node:child_process";
import { createOpencode } from "@opencode-ai/sdk";
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
  getCursorCliSpawnErrorMessage,
  normalizeCursorCliModel,
  resolveCursorCliLaunch,
} from "./cursor-cli.js";
import { runGrokPrompt } from "./grok-acp.js";

const OPENCODE_SERVER_TIMEOUT_MS = 15_000;
const OPENCODE_DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

const inlineSystemPrompt = (system, prompt) =>
  system ? `${system}\n\n${prompt}` : prompt;

/**
 * Reads newline-delimited JSON from a child process, handing each parsed
 * line to `onEvent` and collecting anything else as stderr text.
 */
const createJsonLineReader = (onEvent) => {
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      onEvent(JSON.parse(trimmed));
    } catch {
      stderrBuffer += `${trimmed}\n`;
    }
  };

  return {
    appendStderr: (chunk) => {
      stderrBuffer += chunk.toString();
    },
    appendStdout: (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
    },
    flush: () => {
      consumeLine(stdoutBuffer);
      stdoutBuffer = "";
    },
    get stderr() {
      return stderrBuffer;
    },
    pushStderr: (detail) => {
      if (detail) {
        stderrBuffer += `${detail}\n`;
      }
    },
  };
};

export const runClaudePrompt = async ({
  model,
  prompt,
  projectPath,
  reasoningEffort,
  system,
}) => {
  const claudeExecutablePath = await resolveCliCommandPath("claude");
  const claudeModel = normalizeClaudeCodeModel(model || "haiku");
  // `undefined` effort (callers that predate the setting) keeps the model's
  // own default; `null` is the explicit "medium" default.
  const usesReasoningModel =
    reasoningEffort !== undefined &&
    getModelReasoningEfforts("anthropic", claudeModel).length > 0;
  const result = await generateText({
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
        ? { effort: CLAUDE_REASONING_EFFORT_MAP[reasoningEffort ?? "medium"] }
        : {}),
    }),
    prompt,
    ...(system ? { instructions: system } : {}),
  });

  return result.text;
};

export const runCodexPrompt = ({
  model,
  modelSpeed = "standard",
  prompt,
  projectPath,
  reasoningEffort,
  system,
}) =>
  new Promise((resolve, reject) => {
    let latestText = "";
    const reader = createJsonLineReader((event) => {
      if (!event || typeof event !== "object") {
        return;
      }

      if (event.type === "error" || event.type === "turn.failed") {
        reader.pushStderr(getCodexErrorDetail(event));
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
    });

    void resolveCodexCliLaunch()
      .then((launch) => {
        const child = spawn(
          launch.command,
          [
            ...launch.argsPrefix,
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
            // Callers that predate the text generation effort setting keep
            // the original low effort.
            `model_reasoning_effort=${JSON.stringify(
              reasoningEffort === undefined
                ? "low"
                : getCodexReasoningEffort(reasoningEffort),
            )}`,
            ...(modelSpeed === "fast" ? ["-c", 'service_tier="fast"'] : []),
            "-",
          ],
          {
            cwd: projectPath,
            env: process.env,
            shell: launch.shell ?? false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );

        child.stdout.on("data", reader.appendStdout);
        child.stderr.on("data", reader.appendStderr);
        child.on("error", (error) => {
          reject(new Error(getCodexCliSpawnErrorMessage(error)));
        });
        child.on("close", (code) => {
          reader.flush();
          if (code === 0) {
            resolve(latestText);
            return;
          }
          reject(
            new Error(
              reader.stderr.trim() || `Codex CLI exited with code ${code}.`,
            ),
          );
        });

        child.stdin.end(inlineSystemPrompt(system, prompt));
      })
      .catch((error) => {
        reject(
          new Error(
            error instanceof Error
              ? error.message
              : "Codex CLI request failed.",
          ),
        );
      });
  });

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
  system,
  timeoutMs = OPENCODE_DEFAULT_REQUEST_TIMEOUT_MS,
}) => {
  const requestedModel = typeof model === "string" ? model.trim() : "";
  if (!requestedModel) {
    throw new Error("No OpenCode model is available.");
  }

  const { modelID, providerID } = parseOpenCodeModel(requestedModel);
  const requestAbortController = new AbortController();
  const requestTimeout = setTimeout(() => {
    requestAbortController.abort();
  }, timeoutMs);
  let opencode = null;

  try {
    opencode = await createOpencode({
      hostname: "127.0.0.1",
      port: 0,
      signal: requestAbortController.signal,
      timeout: OPENCODE_SERVER_TIMEOUT_MS,
    });

    const sessionResult = await opencode.client.session.create(
      {
        body: { agent: "plan", model: { id: modelID, providerID } },
        query: { directory: projectPath },
      },
      { signal: requestAbortController.signal },
    );
    const sessionId = sessionResult.data?.id;
    if (!sessionId) {
      throw new Error("OpenCode did not return a session id.");
    }

    const promptResult = await opencode.client.session.prompt(
      {
        body: {
          agent: "plan",
          model: { modelID, providerID },
          parts: [{ text: inlineSystemPrompt(system, prompt), type: "text" }],
        },
        path: { id: sessionId },
        query: { directory: projectPath },
      },
      { signal: requestAbortController.signal },
    );

    return (promptResult.data?.parts ?? []).map(getOpenCodePartText).join(" ");
  } catch (error) {
    if (requestAbortController.signal.aborted) {
      throw new Error("OpenCode request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(requestTimeout);
    opencode?.server.close();
  }
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

export const runCursorPrompt = ({ model, prompt, projectPath, system }) =>
  new Promise((resolve, reject) => {
    let latestText = "";
    const reader = createJsonLineReader((event) => {
      const text = getCursorEventText(event);
      if (text) {
        latestText += text;
        if (event.type === "result") {
          latestText = text;
        }
      }

      if (event?.type === "error") {
        reader.pushStderr(
          typeof event.message === "string"
            ? event.message
            : typeof event.error === "string"
              ? event.error
              : "",
        );
      }
    });

    void resolveCursorCliLaunch()
      .then((launch) => {
        const child = spawn(
          launch.command,
          [
            ...launch.argsPrefix,
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
          {
            cwd: projectPath,
            env: process.env,
            shell: launch.shell ?? false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );

        child.stdout.on("data", reader.appendStdout);
        child.stderr.on("data", reader.appendStderr);
        child.on("error", (error) => {
          reject(new Error(getCursorCliSpawnErrorMessage(error)));
        });
        child.on("close", (code) => {
          reader.flush();
          if (code === 0) {
            resolve(latestText);
            return;
          }
          reject(
            new Error(
              reader.stderr.trim() || `Cursor CLI exited with code ${code}.`,
            ),
          );
        });
      })
      .catch((error) => {
        reject(
          new Error(
            error instanceof Error
              ? error.message
              : "Cursor CLI request failed.",
          ),
        );
      });
  });

export const runGrokTextPrompt = ({
  model,
  prompt,
  projectPath,
  system,
  timeoutMs,
}) =>
  runGrokPrompt({
    cwd: projectPath,
    model,
    prompt: inlineSystemPrompt(system, prompt),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
