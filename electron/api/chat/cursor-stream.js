import { spawn } from "node:child_process";
import { AcpConnection } from "../providers/acp-connection.js";
import {
  normalizeCursorCliModel,
  resolveCursorCliLaunch,
} from "../providers/cursor-cli.js";
import { streamAcpResponse } from "./acp-stream.js";
import { writeCodexApprovalRequest } from "./codex-common.js";

const spawnCursorAcp = async ({ cwd, permissionMode }) => {
  const launch = await resolveCursorCliLaunch();
  // Ask and Auto-accept edits must receive ACP permission requests. Never
  // silently fall back to the old headless --force transport.
  const args = [...launch.argsPrefix];
  if (permissionMode === "full-access") args.push("--force");
  args.push("acp");
  return new AcpConnection(
    spawn(launch.command, args, {
      cwd,
      env: process.env,
      shell: launch.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
    "Cursor",
  );
};

const handleCursorRequest = async ({
  method,
  params,
  writer,
  sessionId,
  signal,
}) => {
  if (method === "cursor/create_plan") {
    // Planning stays conversational in Dream; never accept a provider's
    // transition into implementation on the user's behalf.
    return {
      outcome: {
        outcome: "rejected",
        reason:
          "Present the plan in your response and wait for the user's next instruction. Dream does not use a separate plan mode.",
      },
    };
  }
  if (method !== "cursor/ask_question") {
    throw new Error(`Unsupported Cursor ACP request: ${method}`);
  }
  const questions = (params.questions ?? []).map((question) => ({
    id: question.id,
    header: params.title || "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: "",
    })),
  }));
  const toolCallId = params.toolCallId ?? `cursor-question-${Date.now()}`;
  const response = await writeCodexApprovalRequest({
    approvalId: `cursor:${sessionId}:${toolCallId}`,
    input: { questions },
    provider: "cursor",
    request: { method, params },
    signal,
    title: params.title || "Question",
    toolCallId,
    toolName: "ask-user-question",
    writer,
  });
  if (!response.approved || signal.aborted) {
    writer.write({
      dynamic: true,
      providerExecuted: true,
      toolCallId,
      type: "tool-output-error",
      errorText: "Question cancelled.",
    });
    return { outcome: { outcome: "cancelled" } };
  }
  let values = {};
  try {
    values = JSON.parse(response.reason || "{}").answers ?? {};
  } catch {
    /* No structured answer. */
  }
  const answers = (params.questions ?? []).map((question) => {
    const raw = values[question.id] ?? values[question.prompt];
    const selected = Array.isArray(raw) ? raw : [raw];
    return {
      questionId: question.id,
      selectedOptionIds: (question.options ?? [])
        .filter(
          (option) =>
            selected.includes(option.label) || selected.includes(option.id),
        )
        .map((option) => option.id),
    };
  });
  writer.write({
    dynamic: true,
    providerExecuted: true,
    toolCallId,
    type: "tool-output-available",
    output: { answers: values },
  });
  const hasFreeText = (params.questions ?? []).some((question) => {
    const raw = values[question.id] ?? values[question.prompt];
    const selected = Array.isArray(raw) ? raw : [raw];
    return selected.some(
      (value) =>
        value &&
        !(question.options ?? []).some(
          (option) => option.label === value || option.id === value,
        ),
    );
  });
  // ACP only accepts option IDs; preserve free-text input in the reason.
  if (hasFreeText)
    return {
      outcome: {
        outcome: "skipped",
        reason: `The user supplied these answers: ${JSON.stringify(values)}`,
      },
    };
  return { outcome: { outcome: "answered", answers } };
};

export const streamCursorResponse = (options) =>
  streamAcpResponse({
    ...options,
    adapter: {
      provider: "cursor",
      label: "Cursor Agent",
      spawn: spawnCursorAcp,
      authenticate: (connection) =>
        connection.request("authenticate", { methodId: "cursor_login" }),
      configureSession: async (
        connection,
        { sessionId, sessionState, model },
      ) => {
        // Reset a resumed native Plan/Ask session to ordinary tool-capable mode.
        const modes = sessionState?.modes?.availableModes ?? [];
        const agent = modes.find((mode) => mode.id === "agent");
        if (agent)
          await connection.request("session/set_mode", {
            sessionId,
            modeId: agent.id,
          });
        await connection.request("session/set_model", {
          sessionId,
          modelId: normalizeCursorCliModel(model),
        });
      },
      onRequest: handleCursorRequest,
    },
  });
