// Pending tool approvals: a turn asks the user through the agent-turn writer
// and waits here; the client answers through the route below.
import { z } from "zod";
import { handleJsonRoute } from "./shared/json-route.js";

const pendingToolApprovals = new Map();

const registerPendingToolApproval = ({ id, provider, request, respond }) => {
  pendingToolApprovals.set(id, { provider, request, respond });
};

export const toolApprovalResponseSchema = z.object({
  approved: z.boolean(),
  id: z.string().min(1),
  reason: z.string().nullable().optional(),
  scope: z.enum(["once", "session"]).default("once"),
});

export const waitForToolApproval = ({ id, provider, request, signal }) =>
  new Promise((resolve) => {
    let settled = false;

    const finish = (response) => {
      if (settled) {
        return;
      }

      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      pendingToolApprovals.delete(id);
      resolve(response);
    };

    const handleAbort = () => {
      finish({
        approved: false,
        id,
        reason: "Permission request was cancelled.",
        scope: "once",
      });
    };

    registerPendingToolApproval({
      id,
      provider,
      request,
      respond: finish,
    });

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
  });

/**
 * Answers a pending approval. Returns what the route reports: whether an
 * approval with that id was waiting, and which provider owned it.
 */
export const resolveToolApproval = async (payload) => {
  const pendingApproval = pendingToolApprovals.get(payload.id);
  if (!pendingApproval) {
    // AI SDK-owned approvals, such as the current Anthropic writeFile flow,
    // are resolved in-process by useChat(). The shared endpoint intentionally
    // treats unknown approvals as handled so the frontend can use one path.
    return { handled: false, status: "not-found" };
  }

  pendingToolApprovals.delete(payload.id);
  await pendingApproval.respond(payload);
  return { handled: true, provider: pendingApproval.provider, status: "ok" };
};

export const registerToolApprovalRoutes = (app) => {
  app.post("/api/tool-approval-response", (c) =>
    handleJsonRoute(c, toolApprovalResponseSchema, resolveToolApproval, {
      errorMessage: "Failed to resolve approval.",
      errorStatus: 500,
    }),
  );
};
