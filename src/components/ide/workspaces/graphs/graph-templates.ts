import { nanoid } from "nanoid";
import type { GraphEdge, GraphNode } from "@/types/agent-graphs";

export interface GraphTemplate {
  description: string;
  edges: GraphEdge[];
  entryNodeId: string;
  name: string;
  nodes: GraphNode[];
}

export const createBlankNode = (
  name: string,
  position: { x: number; y: number },
): GraphNode => ({
  agent: {},
  id: nanoid(),
  instructions: "",
  maxIterations: 5,
  name,
  position,
  type: "agent",
});

/**
 * The primary development fixture from the plan:
 *
 *   Plan → Implement → Test ─pass─► Review ─approved─► (done)
 *                        ├─ code failure ─► Implement
 *                        └─ architecture ─► Plan
 *                                   Review ─changes─► Implement
 */
export const createPlanImplementTestReviewTemplate = (): GraphTemplate => {
  const plan: GraphNode = {
    agent: { agentMode: "plan" },
    id: nanoid(),
    instructions: [
      "Read the shared workflow state for the task description and any earlier test/review feedback.",
      "Produce a concise implementation plan: the files to touch, the approach, and how it will be verified.",
      "Do not modify files in this step.",
      "",
      'Return data: { "status": "planned" } and stateUpdates: { "plan": "<your plan>" }.',
    ].join("\n"),
    maxIterations: 3,
    name: "Plan",
    position: { x: 80, y: 40 },
    type: "agent",
  };
  const implement: GraphNode = {
    agent: {},
    id: nanoid(),
    instructions: [
      "Implement the plan from the shared workflow state. If earlier test or review feedback exists, address it.",
      "Make the code changes directly in the project.",
      "",
      'Return data: { "status": "implemented" } and stateUpdates: { "implementation": { "summary": "...", "filesChanged": [] } }.',
    ].join("\n"),
    maxIterations: 5,
    name: "Implement",
    position: { x: 80, y: 220 },
    type: "agent",
  };
  const test: GraphNode = {
    agent: {},
    id: nanoid(),
    instructions: [
      "Run the project's test suite and type checks.",
      "Determine whether failures are caused by implementation errors or by architectural/design assumptions in the plan.",
      "",
      'Return data: { "status": "passed" | "failed", "failureType": "implementation" | "architecture" } and stateUpdates: { "tests": { "status": "...", "details": "..." } }.',
    ].join("\n"),
    maxIterations: 5,
    name: "Test",
    position: { x: 80, y: 400 },
    type: "agent",
  };
  const review: GraphNode = {
    agent: { agentMode: "plan" },
    id: nanoid(),
    instructions: [
      "Review the implementation described in the shared workflow state against the plan and the project's conventions.",
      "Do not modify files. If changes are required, describe them precisely.",
      "",
      'Return data: { "status": "approved" | "changes" } and stateUpdates: { "review": { "status": "...", "feedback": "..." } }.',
    ].join("\n"),
    maxIterations: 3,
    name: "Review",
    position: { x: 80, y: 580 },
    type: "agent",
  };

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
