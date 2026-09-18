import { z } from "zod";
import { EDGE_CONDITION_OPERATORS } from "./conditions.js";
import { OUTPUT_TYPES } from "./outputs.js";

const identifierSchema = z.string().min(1).max(200);

export const nodeAgentSchema = z
  .object({
    agentMode: z.enum(["plan", "build"]).optional(),
    model: z.string().max(200).optional(),
    modelSpeed: z.enum(["standard", "fast"]).optional(),
    provider: z
      .enum(["openai", "anthropic", "opencode", "cursor", "grok"])
      .optional(),
    reasoningEffort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional(),
  })
  .default({});

export const edgeConditionSchema = z.object({
  field: z.string().min(1).max(200),
  operator: z.enum(EDGE_CONDITION_OPERATORS),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

// Deliberately lenient: the editor autosaves while the user is typing, so
// semantic checks (valid key, enum options…) live in `validateGraph`.
export const nodeOutputSchema = z.object({
  description: z.string().max(500).default(""),
  key: z.string().max(64).default(""),
  options: z.array(z.string().max(200)).max(50).default([]),
  required: z.boolean().default(true),
  saveToState: z.boolean().default(false),
  type: z.enum(OUTPUT_TYPES).default("text"),
});

export const graphInputSchema = z.object({
  description: z.string().max(500).default(""),
  key: z.string().max(64).default(""),
  label: z.string().max(200).default(""),
  options: z.array(z.string().max(200)).max(50).default([]),
  required: z.boolean().default(true),
  type: z.enum(OUTPUT_TYPES).default("text"),
});

export const graphNodeSchema = z.object({
  agent: nodeAgentSchema,
  id: identifierSchema,
  instructions: z.string().max(50_000).default(""),
  maxIterations: z.number().int().min(1).max(1000).default(5),
  name: z.string().min(1).max(200),
  outputs: z.array(nodeOutputSchema).max(20).default([]),
  position: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .default({ x: 0, y: 0 }),
  type: z.literal("agent").default("agent"),
});

export const graphEdgeSchema = z.object({
  condition: edgeConditionSchema.nullable().default(null),
  id: identifierSchema,
  priority: z.number().int().default(0),
  sourceNodeId: identifierSchema,
  targetNodeId: identifierSchema,
});

export const listGraphsRequestSchema = z.object({
  projectId: identifierSchema,
});

export const getGraphRequestSchema = z.object({
  graphId: identifierSchema,
});

export const createGraphRequestSchema = z.object({
  description: z.string().max(5_000).default(""),
  name: z.string().min(1).max(200),
  projectId: identifierSchema,
});

export const updateGraphRequestSchema = z.object({
  description: z.string().max(5_000).optional(),
  graphId: identifierSchema,
  name: z.string().min(1).max(200).optional(),
});

export const deleteGraphRequestSchema = getGraphRequestSchema;

export const saveGraphRequestSchema = z.object({
  edges: z.array(graphEdgeSchema).max(1_000),
  entryNodeId: identifierSchema.nullable(),
  graphId: identifierSchema,
  inputs: z.array(graphInputSchema).max(20).optional(),
  nodes: z.array(graphNodeSchema).max(200),
});

export const startRunRequestSchema = z.object({
  defaultAgent: nodeAgentSchema,
  graphId: identifierSchema,
  initialState: z.record(z.string(), z.unknown()).optional(),
  maxExecutions: z.number().int().min(1).max(10_000).optional(),
  projectId: identifierSchema,
});

export const runIdRequestSchema = z.object({
  runId: identifierSchema,
});

export const listRunsRequestSchema = z
  .object({
    graphId: identifierSchema.optional(),
    projectId: identifierSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .refine(
    (data) => Boolean(data.graphId) !== Boolean(data.projectId),
    "Provide either graphId or projectId.",
  );

export const activeRunRequestSchema = z.object({
  projectId: identifierSchema,
});
