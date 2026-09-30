import {
  authenticateCursorAcp,
  resolveCursorAcpModelId,
  spawnCursorAcp,
} from "../providers/cursor-acp.js";
import { streamAcpResponse } from "./acp-stream.js";

const handleCursorRequest = async ({
  method,
  params,
  sessionId,
  signal,
  turn,
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
  const toolCallId =
    params.toolCallId ?? `cursor-question-${sessionId}-${Date.now()}`;
  const response = await turn.approval({
    input: { questions },
    request: { method, params },
    signal,
    title: params.title || "Question",
    toolCallId,
    toolName: "ask-user-question",
  });
  if (!response.approved || signal.aborted) {
    turn.toolError(toolCallId, "Question cancelled.");
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
  turn.toolOutput(toolCallId, { answers: values });
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

export const cursorAcpAdapter = {
  provider: "cursor",
  label: "Cursor Agent",
  spawn: spawnCursorAcp,
  authenticate: authenticateCursorAcp,
  configureSession: async (connection, { sessionId, sessionState, model }) => {
    // Reset a resumed native Plan/Ask session to ordinary tool-capable mode.
    const modes = sessionState?.modes?.availableModes ?? [];
    const agent = modes.find((mode) => mode.id === "agent");
    if (agent)
      await connection.request("session/set_mode", {
        sessionId,
        modeId: agent.id,
      });
    const availableModels = sessionState?.models?.availableModels;
    const modelId =
      resolveCursorAcpModelId(model, availableModels) ??
      // A session that lists no models (older Cursor, or some resumed
      // sessions) gets the id as-is rather than a guess.
      (Array.isArray(availableModels) ? null : String(model ?? "").trim());
    if (!modelId) {
      throw new Error(
        `Cursor Agent does not offer the model "${model}". Choose another Cursor model.`,
      );
    }
    await connection.request("session/set_model", { sessionId, modelId });
  },
  onRequest: handleCursorRequest,
};

export const streamCursorResponse = (options) =>
  streamAcpResponse({ ...options, adapter: cursorAcpAdapter });
