// Request schemas: the contract with the renderer's route client
// (src/lib/api-client.ts), which takes its request types from here.
import { z } from "zod";

// Pull request lookups for the Code workspace PR panel.
export const codePullRequestRequestSchema = z.object({
  projectPath: z.string().min(1),
  action: z.enum([
    "context",
    "list",
    "detail",
    "files",
    "comments",
    "reviews",
    "threads",
    "edit",
    "comment",
    "editComment",
    "inline",
    "reply",
    "review",
    "checkout",
    "merge",
    "mergeInfo",
  ]),
  repository: z.string().optional(),
  number: z.number().int().positive().optional(),
  page: z.number().int().min(1).max(1000).default(1),
  state: z.enum(["open", "closed", "merged", "all"]).default("open"),
  search: z.string().max(200).default(""),
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  commentId: z.number().int().positive().optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  updatedAt: z.string().optional(),
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
});
