// Request schemas: the contract with the renderer's route client
// (src/lib/api-client.ts), which takes its request types from here.
import { z } from "zod";

export const mcpImportCandidatesRequestSchema = z.object({
  projectPath: z.string().optional(),
});
