import { z } from "zod";

const pendingToolApprovals = new Map();

const registerPendingToolApproval = ({ id, provider, request, respond }) => {
  pendingToolApprovals.set(id, { provider, request, respond });
};

const toolApprovalResponseSchema = z.object({
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

export const registerToolApprovalRoutes = (app) => {
  app.post("/api/tool-approval-response", async (c) => {
    let payload;
    try {
      payload = toolApprovalResponseSchema.parse(await c.req.json());
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : "Invalid approval response.",
        400,
      );
    }

    const pendingApproval = pendingToolApprovals.get(payload.id);
    if (!pendingApproval) {
      // AI SDK-owned approvals, such as the current Anthropic writeFile flow,
      // are resolved in-process by useChat(). The shared endpoint intentionally
      // treats unknown approvals as handled so the frontend can use one path.
      return c.json({ handled: false, status: "not-found" });
    }

    pendingToolApprovals.delete(payload.id);

    try {
      await pendingApproval.respond(payload);
    } catch (error) {
      return c.text(
        error instanceof Error ? error.message : "Failed to resolve approval.",
        500,
      );
    }

    return c.json({
      handled: true,
      provider: pendingApproval.provider,
      status: "ok",
    });
  });
};
