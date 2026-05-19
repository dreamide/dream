import { spawn } from "node:child_process";
import { generateText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import {
  CLAUDE_REASONING_EFFORT_MAP,
  getModelReasoningEfforts,
  normalizeClaudeCodeModel,
} from "../providers/model-options.js";
import {
  fetchAnthropicLowCostModel,
  fetchOpenAiLowCostModel,
  fetchOpenCodeLowCostModel,
} from "../providers/provider-models.js";
import {
  getCodexCliSpawnErrorMessage,
  resolveCodexCliLaunch,
} from "./codex-cli-launch.js";
import { getCodexErrorDetail } from "./codex-prompt.js";

const CHAT_TITLE_MAX_LENGTH = 60;
const CHAT_TITLE_SYSTEM_PROMPT =
  "Generate concise chat titles. Return only the title, with no quotes or extra commentary.";

const buildChatTitlePrompt = (promptText) => [
  "Create a short title for a new coding chat from the user's first message.",
  "Rules:",
  "- Use 3 to 6 words when possible.",
  `- Stay under ${CHAT_TITLE_MAX_LENGTH} characters.`,
  "- Do not wrap the title in quotes.",
  "- Do not end with punctuation unless it is part of a proper name.",
  "",
  "User message:",
  promptText,
];

const stripWrappingQuotes = (value) =>
  value.replace(/^["'`]+/, "").replace(/["'`]+$/, "");

export const sanitizeGeneratedChatTitle = (value) => {
  const title = stripWrappingQuotes(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .replace(/[.!?]+$/, "")
    .trim();

  if (!title) {
    return "";
  }

  return title.slice(0, CHAT_TITLE_MAX_LENGTH).trim();
};

const parseCodexJsonLine = (line, onEvent) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  try {
    onEvent(JSON.parse(trimmed));
    return "";
  } catch {
    return `${trimmed}\n`;
  }
};

const generateCodexChatTitle = ({ model, projectPath, promptText }) =>
  new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let latestText = "";

    const handleEvent = (event) => {
      if (!event || typeof event !== "object") {
        return;
      }

      if (event.type === "error" || event.type === "turn.failed") {
        const detail = getCodexErrorDetail(event);
        if (detail) {
          stderrBuffer += `${detail}\n`;
        }
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
    };

    const handleStdoutChunk = (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        stderrBuffer += parseCodexJsonLine(line, handleEvent);
      }
    };

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
            "--model",
            model,
            "-c",
            'sandbox_mode="read-only"',
            "-c",
            'approval_policy="never"',
            "-c",
            'model_reasoning_effort="low"',
            "-",
          ],
          {
            env: process.env,
            shell: launch.shell ?? false,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );

        child.stdout.on("data", handleStdoutChunk);
        child.stderr.on("data", (chunk) => {
          stderrBuffer += chunk.toString();
        });
        child.on("error", (error) => {
          reject(new Error(getCodexCliSpawnErrorMessage(error)));
        });
        child.on("close", (code) => {
          stderrBuffer += parseCodexJsonLine(stdoutBuffer, handleEvent);

          if (code === 0) {
            resolve(sanitizeGeneratedChatTitle(latestText));
            return;
          }

          reject(
            new Error(
              stderrBuffer.trim() || `Codex CLI exited with code ${code}.`,
            ),
          );
        });

        child.stdin.end(
          [
            CHAT_TITLE_SYSTEM_PROMPT,
            "",
            buildChatTitlePrompt(promptText).join("\n"),
          ].join("\n"),
        );
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

const generateClaudeChatTitle = async ({ model, projectPath, promptText }) => {
  const usesReasoningModel =
    getModelReasoningEfforts("anthropic", model).length > 0;
  const result = await generateText({
    model: claudeCode(normalizeClaudeCodeModel(model), {
      continue: false,
      cwd: projectPath,
      persistSession: false,
      permissionMode: "plan",
      ...(usesReasoningModel
        ? { effort: CLAUDE_REASONING_EFFORT_MAP.low }
        : {}),
    }),
    prompt: buildChatTitlePrompt(promptText).join("\n"),
    system: CHAT_TITLE_SYSTEM_PROMPT,
    ...(usesReasoningModel ? {} : { temperature: 0.2 }),
  });

  return sanitizeGeneratedChatTitle(result.text);
};

const generateOpenCodeChatTitle = ({ model, projectPath, promptText }) =>
  new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const outputLines = [];

    const handleStdoutChunk = (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const event = JSON.parse(trimmed);
          const text =
            event.type === "text" &&
            event.part?.type === "text" &&
            typeof event.part.text === "string"
              ? event.part.text
              : "";
          if (text) {
            outputLines.push(text);
          }
        } catch {
          outputLines.push(trimmed);
        }
      }
    };

    const child = spawn(
      "opencode",
      [
        "run",
        "--format",
        "json",
        "--dir",
        projectPath,
        "--model",
        model,
        "--agent",
        "plan",
      ],
      {
        cwd: projectPath,
        env: process.env,
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    child.stdin.end(
      [
        CHAT_TITLE_SYSTEM_PROMPT,
        "",
        buildChatTitlePrompt(promptText).join("\n"),
      ].join("\n"),
    );
    child.stdout.on("data", handleStdoutChunk);
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });
    child.on("error", (error) => {
      reject(
        new Error(
          error instanceof Error
            ? error.message
            : "OpenCode CLI request failed.",
        ),
      );
    });
    child.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        outputLines.push(stdoutBuffer.trim());
      }

      if (code === 0) {
        resolve(sanitizeGeneratedChatTitle(outputLines.join(" ")));
        return;
      }

      reject(
        new Error(
          stderrBuffer.trim() || `OpenCode CLI exited with code ${code}.`,
        ),
      );
    });
  });

export const generateChatTitle = async ({
  fallbackModel,
  projectPath,
  promptText,
  provider,
}) => {
  const normalizedPrompt = String(promptText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedPrompt) {
    return "";
  }

  if (provider === "anthropic") {
    const model = (await fetchAnthropicLowCostModel()) || "haiku";
    return generateClaudeChatTitle({ model, projectPath, promptText });
  }

  if (provider === "opencode") {
    const model =
      (await fetchOpenCodeLowCostModel(fallbackModel)) || fallbackModel?.trim();
    if (!model) {
      throw new Error("No OpenCode title model is available.");
    }
    return generateOpenCodeChatTitle({ model, projectPath, promptText });
  }

  const model = (await fetchOpenAiLowCostModel()) || fallbackModel?.trim();
  if (!model) {
    throw new Error("No OpenAI title model is available.");
  }

  return generateCodexChatTitle({ model, projectPath, promptText });
};
