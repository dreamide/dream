import { WORKFLOW_RESULT_TAG } from "./node-result.js";
import { nodeType } from "./outcomes.js";

const MAX_TASK_CHARS = 12_000;
const MAX_INCOMING_MESSAGE_CHARS = 8_000;
const MAX_STEP_MESSAGE_CHARS = 1_500;
const MAX_HISTORY_ENTRIES = 3;

/** Shared-state key holding each step's latest `{ status, message }`. */
export const STEPS_STATE_KEY = "steps";

const truncate = (value, maxChars) => {
  const text = String(value ?? "").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
};

const formatExecution = (execution, label, maxChars) => {
  const status = execution.result?.status ?? execution.status;
  const lines = [`${label}: ${status}`];
  const message = execution.result?.message ?? execution.result?.summary;
  if (message) {
    lines.push(truncate(message, maxChars));
  }
  if (execution.error) {
    lines.push(`Error: ${truncate(execution.error, 500)}`);
  }
  return lines.join("\n");
};

/**
 * Builds the prompt for one step. The user only writes the step's
 * instructions; the task, what earlier steps reported and the (fixed) result
 * format are added here, identically for every step.
 */
export const buildNodePrompt = ({
  graph,
  node,
  state,
  previousExecutions = [],
  incomingExecution = null,
  incomingNodeName = null,
}) => {
  const sections = [
    "You are executing one step in an automated agent workflow.",
    "",
    `Workflow: ${graph.name}`,
    graph.description ? `Workflow description: ${graph.description}` : null,
    `Current step: ${node.name}`,
  ];

  if (typeof state?.task === "string" && state.task.trim()) {
    sections.push(
      "",
      "## Task for this workflow run",
      truncate(state.task, MAX_TASK_CHARS),
    );
  }

  sections.push(
    "",
    "## Step instructions",
    node.instructions?.trim() || "(no additional instructions)",
  );

  const steps = Object.entries(state?.[STEPS_STATE_KEY] ?? {}).filter(
    ([name]) => name !== incomingNodeName,
  );
  if (steps.length > 0) {
    sections.push(
      "",
      "## What happened so far",
      "Latest result of each earlier step:",
      ...steps.map(
        ([name, entry]) =>
          `- ${name} (${entry?.status ?? "unknown"}): ${truncate(entry?.message, MAX_STEP_MESSAGE_CHARS)}`,
      ),
    );
  }

  if (incomingExecution) {
    sections.push(
      "",
      "## Result of the previous step",
      formatExecution(
        incomingExecution,
        `Step "${incomingNodeName ?? incomingExecution.nodeId}"`,
        MAX_INCOMING_MESSAGE_CHARS,
      ),
    );
  }

  const history = previousExecutions.slice(-MAX_HISTORY_ENTRIES);
  if (history.length > 0) {
    sections.push(
      "",
      `## Your previous attempts at this step (${previousExecutions.length} total)`,
      ...history.map((execution) =>
        formatExecution(
          execution,
          `Attempt ${execution.iteration}`,
          MAX_STEP_MESSAGE_CHARS,
        ),
      ),
    );
  }

  if (nodeType(node) === "task") {
    sections.push(
      "",
      "## Required output",
      "Do the work described above. When finished, end your response with exactly one block in this form:",
      "",
      `<${WORKFLOW_RESULT_TAG}>`,
      '{ "message": "..." }',
      `</${WORKFLOW_RESULT_TAG}>`,
      "",
      "- `message`: everything the next step needs to know about what you did or produced (for a plan: the full plan). Later steps only see this message, not the rest of your response.",
      "- The block must be valid JSON and the last thing in your response.",
    );
    return sections.filter((line) => line !== null).join("\n");
  }

  sections.push(
    "",
    "## Required output",
    "Do the work described above. When finished, end your response with exactly one block in this form:",
    "",
    `<${WORKFLOW_RESULT_TAG}>`,
    '{ "status": "success" | "failure", "message": "..." }',
    `</${WORKFLOW_RESULT_TAG}>`,
    "",
    '- `status`: "success" when this step achieved its goal (checks passed, work approved, the answer to a yes/no question is yes). "failure" when it did not (checks failed, changes are required, the answer is no).',
    "- `message`: everything the next step needs to know — what you did, or exactly what is wrong and should be fixed. Later steps only see this message, not the rest of your response.",
    "- The block must be valid JSON and the last thing in your response.",
  );

  return sections.filter((line) => line !== null).join("\n");
};

/** Follow-up prompt used when the response had no usable result block. */
export const buildRepairPrompt = (error) =>
  [
    `Your previous response could not be processed: ${error}`,
    `Respond again with only the <${WORKFLOW_RESULT_TAG}> block — { "status": "success" | "failure", "message": "..." } — describing the work you already completed. Do not redo the work.`,
  ].join("\n");
