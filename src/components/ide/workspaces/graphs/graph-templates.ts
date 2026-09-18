import { nanoid } from "nanoid";
import type {
  GraphEdge,
  GraphInput,
  GraphNode,
  NodeOutput,
} from "@/types/agent-graphs";

export interface GraphTemplate {
  description: string;
  edges: GraphEdge[];
  entryNodeId: string;
  inputs?: GraphInput[];
  name: string;
  nodes: GraphNode[];
}

const enumOutput = (
  key: string,
  options: string[],
  description = "",
  required = true,
): NodeOutput => ({
  description,
  key,
  options,
  required,
  saveToState: true,
  type: "enum",
});

const textOutput = (key: string, description: string): NodeOutput => ({
  description,
  key,
  options: [],
  required: true,
  saveToState: true,
  type: "text",
});

export type NodePresetId =
  | "blank"
  | "plan"
  | "implement"
  | "test"
  | "review"
  | "decision";

interface NodePreset {
  agent: GraphNode["agent"];
  instructions: string[];
  maxIterations: number;
  name: string;
  outputs: NodeOutput[];
}

/**
 * Ready-made steps: instructions, agent mode and outputs are pre-configured
 * so a workflow can be assembled by adding presets and connecting them.
 */
const NODE_PRESETS: Record<Exclude<NodePresetId, "blank">, NodePreset> = {
  decision: {
    agent: { agentMode: "plan" },
    instructions: [
      "Decide the following question based on the task and the results of earlier steps:",
      "",
      "(describe the question here)",
    ],
    maxIterations: 5,
    name: "Decision",
    outputs: [
      enumOutput("decision", ["yes", "no"]),
      textOutput("reason", "Why this decision was made."),
    ],
  },
  implement: {
    agent: {},
    instructions: [
      "Implement the plan from the shared workflow state. If earlier test or review feedback exists, address it.",
      "Make the code changes directly in the project.",
    ],
    maxIterations: 5,
    name: "Implement",
    outputs: [
      textOutput("changes", "What was changed and which files were touched."),
    ],
  },
  plan: {
    agent: { agentMode: "plan" },
    instructions: [
      "Plan the task for this workflow run, taking any earlier test or review feedback in the shared state into account.",
      "Produce a concise implementation plan: the files to touch, the approach, and how it will be verified.",
    ],
    maxIterations: 3,
    name: "Plan",
    outputs: [textOutput("plan", "The implementation plan.")],
  },
  review: {
    agent: { agentMode: "plan" },
    instructions: [
      "Review the implementation described in the shared workflow state against the plan and the project's conventions.",
      "If changes are required, describe them precisely.",
    ],
    maxIterations: 3,
    name: "Review",
    outputs: [
      enumOutput("status", ["approved", "changes"]),
      textOutput("feedback", "Precise description of any required changes."),
    ],
  },
  test: {
    agent: {},
    instructions: [
      "Run the project's test suite and type checks.",
      "Determine whether failures are caused by implementation errors or by architectural/design assumptions in the plan.",
    ],
    maxIterations: 5,
    name: "Test",
    outputs: [
      enumOutput("status", ["passed", "failed"]),
      enumOutput(
        "failureType",
        ["implementation", "architecture"],
        "Only when failed: whether the cause is an implementation error or a wrong architectural/design assumption in the plan.",
        false,
      ),
      textOutput("details", "Failing checks and relevant error output."),
    ],
  },
};

export const NODE_PRESET_IDS: readonly NodePresetId[] = [
  "blank",
  "plan",
  "implement",
  "test",
  "review",
  "decision",
];

export const createBlankNode = (
  name: string,
  position: { x: number; y: number },
): GraphNode => ({
  agent: {},
  id: nanoid(),
  instructions: "",
  maxIterations: 5,
  name,
  outputs: [],
  position,
  type: "agent",
});

/** Avoids duplicate step names, which would share one `steps.<name>` slot. */
const uniqueName = (name: string, taken: readonly string[]): string => {
  if (!taken.includes(name)) {
    return name;
  }
  let index = 2;
  while (taken.includes(`${name} ${index}`)) {
    index += 1;
  }
  return `${name} ${index}`;
};

export const createNodeFromPreset = (
  presetId: NodePresetId,
  position: { x: number; y: number },
  options: { blankName: string; takenNames?: readonly string[] },
): GraphNode => {
  const taken = options.takenNames ?? [];
  if (presetId === "blank") {
    return createBlankNode(uniqueName(options.blankName, taken), position);
  }
  const preset = NODE_PRESETS[presetId];
  return {
    agent: { ...preset.agent },
    id: nanoid(),
    instructions: preset.instructions.join("\n"),
    maxIterations: preset.maxIterations,
    name: uniqueName(preset.name, taken),
    outputs: preset.outputs.map((output) => ({
      ...output,
      options: [...output.options],
    })),
    position,
    type: "agent",
  };
};

/**
 * The primary development fixture from the plan:
 *
 *   Plan → Implement → Test ─pass─► Review ─approved─► (done)
 *                        ├─ code failure ─► Implement
 *                        └─ architecture ─► Plan
 *                                   Review ─changes─► Implement
 */
export const createPlanImplementTestReviewTemplate = (): GraphTemplate => {
  const options = { blankName: "Step" };
  const plan = createNodeFromPreset("plan", { x: 80, y: 40 }, options);
  const implement = createNodeFromPreset(
    "implement",
    { x: 80, y: 220 },
    options,
  );
  const test = createNodeFromPreset("test", { x: 80, y: 400 }, options);
  const review = createNodeFromPreset("review", { x: 80, y: 580 }, options);

  const edges: GraphEdge[] = [
    {
      condition: null,
      id: nanoid(),
      priority: 0,
      sourceNodeId: plan.id,
      targetNodeId: implement.id,
    },
    {
      condition: null,
      id: nanoid(),
      priority: 0,
      sourceNodeId: implement.id,
      targetNodeId: test.id,
    },
    {
      condition: {
        field: "failureType",
        operator: "eq",
        value: "architecture",
      },
      id: nanoid(),
      priority: 0,
      sourceNodeId: test.id,
      targetNodeId: plan.id,
    },
    {
      condition: { field: "status", operator: "eq", value: "failed" },
      id: nanoid(),
      priority: 1,
      sourceNodeId: test.id,
      targetNodeId: implement.id,
    },
    {
      condition: null,
      id: nanoid(),
      priority: 0,
      sourceNodeId: test.id,
      targetNodeId: review.id,
    },
    {
      condition: { field: "status", operator: "eq", value: "changes" },
      id: nanoid(),
      priority: 0,
      sourceNodeId: review.id,
      targetNodeId: implement.id,
    },
  ];

  return {
    description:
      "Plan, implement, test and review a task. Test failures loop back to Implement (or Plan for architectural problems); review feedback loops back to Implement.",
    edges,
    entryNodeId: plan.id,
    name: "Plan → Implement → Test → Review",
    nodes: [plan, implement, test, review],
  };
};
