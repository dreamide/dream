// Request schemas: the contract with the renderer's terminal client
// (src/lib/terminal-client.ts), which takes its request types from here.
import { z } from "zod";

export const terminalStartRequestSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().min(1),
  sessionId: z.string().min(1),
  shellPath: z.string().optional(),
  strictCwd: z.boolean().optional(),
});

export const terminalStopRequestSchema = z.object({
  sessionId: z.string().min(1),
});

export const terminalEmptyRequestSchema = z.object({}).passthrough();
