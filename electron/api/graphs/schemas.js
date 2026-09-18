import { z } from "zod";
import { NODE_TYPES, OUTCOMES } from "./outcomes.js";

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

export const graphNodeSchema = z.object({
  agent: nodeAgentSchema,
  id: identifierSchema,
  instructions: z.string().max(50_000).default(""),
  maxIterations: z.number().int().min(1).max(1000).default(5),
  name: z.string().min(1).max(200),
  position: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .default({ x: 0, y: 0 }),
  type: z.enum(NODE_TYPES).catch("decision"),
});

export const graphEdgeSchema = z.object({
  id: identifierSchema,
  outcome: z.enum(OUTCOMES).default("success"),
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
