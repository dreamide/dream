import { WORKFLOW_RESULT_TAG } from "./node-result.js";

const MAX_STATE_CHARS = 12_000;
const MAX_HISTORY_ENTRIES = 3;
const MAX_HISTORY_SUMMARY_CHARS = 1_500;

const formatJson = (value, maxChars) => {
  let text;
  try {
    text = JSON.stringify(value ?? {}, null, 2);
  } catch {
    text = "{}";
  }
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… [truncated]`
    : text;
};

const truncate = (value, maxChars) => {
  const text = String(value ?? "").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
};

const formatExecution = (execution, label) => {
  const lines = [`${label} (${execution.status})`];
  const result = execution.result;
  if (result?.summary) {
    lines.push(
      `Summary: ${truncate(result.summary, MAX_HISTORY_SUMMARY_CHARS)}`,
    );
  }
  if (result?.data && Object.keys(result.data).length > 0) {
    lines.push(`Data: ${formatJson(result.data, 2_000)}`);
  }
  if (execution.error) {
    lines.push(`Error: ${truncate(execution.error, 500)}`);
  }
  return lines.join("\n");
};

/**
 * Builds the prompt for one node execution.
 *
 * Keeps context bounded: shared state + summaries of this node's previous
 * executions + the result of the execution that transitioned here.
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
    "",
    "## Step instructions",
    node.instructions?.trim() || "(no additional instructions)",
    "",
    "## Shared workflow state",
    formatJson(state, MAX_STATE_CHARS),
  ];

  if (incomingExecution) {
    sections.push(
      "",
      "## Result of the previous step",
      formatExecution(
        incomingExecution,
        `Step "${incomingNodeName ?? incomingExecution.nodeId}"`,
      ),
    );
  }

  const history = previousExecutions.slice(-MAX_HISTORY_ENTRIES);
  if (history.length > 0) {
    sections.push(
      "",
      `## Previous executions of this step (${previousExecutions.length} total)`,
      ...history.map((execution) =>
        formatExecution(execution, `Execution ${execution.iteration}`),
      ),
    );
  }

  sections.push(
    "",
    "## Required output",
    "Do the work described above. When finished, end your response with exactly one block in this form:",
    "",
    `<${WORKFLOW_RESULT_TAG}>`,
    "{",
    '  "summary": "one or two sentences describing what you did and the outcome",',
    '  "data": { "status": "..." },',
    '  "stateUpdates": { }',
    "}",
    `</${WORKFLOW_RESULT_TAG}>`,
    "",
    "Rules for the block:",
    "- `data` holds the structured metadata that decides which workflow edge is followed next. Populate every field named in the step instructions.",
    "- `stateUpdates` is optional; keys you include are merged into the shared workflow state for later steps.",
    "- The block must be valid JSON with no comments and must be the last thing in your response.",
  );

  return sections.filter((line) => line !== null).join("\n");
};

/**
 * Follow-up prompt used once when the agent's response had no valid result
 * block. Cheap to retry and by far the most common failure mode.
 */
export const buildRepairPrompt = (error) =>
  [
    `Your previous response could not be processed: ${error}`,
    `Respond again with only the <${WORKFLOW_RESULT_TAG}> block (valid JSON with "summary", "data" and optional "stateUpdates") describing the work you already completed. Do not redo the work.`,
  ].join("\n");
