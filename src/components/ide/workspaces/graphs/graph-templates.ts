import { nanoid } from "nanoid";
import type {
  GraphEdge,
  GraphNode,
  GraphNodeType,
  StepOutcome,
} from "@/types/agent-graphs";

export interface GraphTemplate {
  description: string;
  edges: GraphEdge[];
  entryNodeId: string;
  name: string;
  nodes: GraphNode[];
}

export const NODE_TYPES: readonly GraphNodeType[] = ["task", "decision"];

/** Step names identify results for later steps, so keep them unique. */
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

export const createNode = (
  type: GraphNodeType,
  name: string,
  position: { x: number; y: number },
  takenNames: readonly string[] = [],
): GraphNode => ({
  agent: {},
  id: nanoid(),
  instructions: "",
  maxIterations: 5,
  name: uniqueName(name, takenNames),
  position,
  type,
});

const step = (
  type: GraphNodeType,
  name: string,
  position: { x: number; y: number },
  instructions: string[],
  overrides: Partial<Pick<GraphNode, "agent" | "maxIterations">> = {},
): GraphNode => ({
  ...createNode(type, name, position),
  ...overrides,
  instructions: instructions.join("\n"),
});

const connect = (
  source: GraphNode,
  target: GraphNode,
  outcome: StepOutcome = "success",
): GraphEdge => ({
  id: nanoid(),
  outcome,
  sourceNodeId: source.id,
  targetNodeId: target.id,
});

/**
 *   Plan → Implement → Test ✓→ Review ✓→ (done)
 *             ▲          ✗─┘      ✗─┘
 *             └── failed tests and review feedback go back to Implement
 *
 * Plan and Implement are tasks (they always continue); Test and Review are
 * decisions.
 */
export const createPlanImplementTestReviewTemplate = (): GraphTemplate => {
  const plan = step(
    "task",
    "Plan",
    { x: 80, y: 40 },
    [
      "Write a concise implementation plan for the task: the files to touch, the approach, and how it will be verified.",
      "If earlier steps reported problems with a previous plan, revise it accordingly.",
      "Put the full plan in your message. Do not modify files.",
    ],
    { agent: { agentMode: "plan" }, maxIterations: 3 },
  );
  const implement = step("task", "Implement", { x: 80, y: 220 }, [
    "Implement the plan. If an earlier test or review step reported problems, fix those.",
    "Make the code changes directly in the project, then summarize what you changed.",
  ]);
  const test = step("decision", "Test", { x: 80, y: 400 }, [
    "Run the project's test suite and type checks.",
    "Succeed if everything passes. Fail otherwise, and include the failing checks and relevant error output.",
  ]);
  const review = step(
    "decision",
    "Review",
    { x: 80, y: 580 },
    [
      "Review the implementation against the plan and the project's conventions. Do not modify files.",
      "Succeed if it can be approved as is. Fail if changes are required, and describe them precisely.",
    ],
    { agent: { agentMode: "plan" }, maxIterations: 3 },
  );

  return {
    description:
      "Plan, implement, test and review a task. Failed tests and review feedback loop back to Implement.",
    edges: [
      connect(plan, implement),
      connect(implement, test),
      connect(test, review),
      connect(test, implement, "failure"),
      connect(review, implement, "failure"),
    ],
    entryNodeId: plan.id,
    name: "Plan → Implement → Test → Review",
    nodes: [plan, implement, test, review],
  };
};
