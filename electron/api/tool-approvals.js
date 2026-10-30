// Pending tool approvals: a turn asks the user through the agent-turn writer
// and waits here; the client answers through the route below.
//
// Which chats have one waiting is announced (`onToolApprovalsChange`): the
// host publishes it on its catalog channel and lists it with the catalog,
// so every client shows a chat waiting for its user, open or not.
import { z } from "zod";
import { handleJsonRoute } from "./shared/json-route.js";

const pendingToolApprovals = new Map();
/** @type {Set<(event: { chatId: string, awaiting: boolean }) => void>} */
const approvalListeners = new Set();

/** The chats with an approval waiting now. */
export const awaitingApprovalChatIds = () => [
  ...new Set(
    [...pendingToolApprovals.values()]
      .map((approval) => approval.chatId)
      .filter((chatId) => typeof chatId === "string"),
  ),
];

/**
 * Tells `listener` whenever a chat starts or stops waiting on an approval
 * (its first one asked, its last one settled). Returns the unsubscribe.
 * @param {(event: { chatId: string, awaiting: boolean }) => void} listener
 */
export const onToolApprovalsChange = (listener) => {
  approvalListeners.add(listener);
  return () => approvalListeners.delete(listener);
};

const isAwaiting = (chatId) =>
  [...pendingToolApprovals.values()].some(
    (approval) => approval.chatId === chatId,
  );

const announce = (chatId, awaiting) => {
  if (typeof chatId !== "string") return;
  for (const listener of approvalListeners) {
    try {
      listener({ awaiting, chatId });
    } catch (error) {
      console.warn("[approvals] A listener failed.", error);
    }
  }
};

const registerPendingToolApproval = ({
  id,
  chatId,
  provider,
  request,
  respond,
}) => {
  const first = typeof chatId === "string" && !isAwaiting(chatId);
  pendingToolApprovals.set(id, { chatId, provider, request, respond });
  if (first) announce(chatId, true);
};

/** Settles approval `id`; announces its chat when nothing else waits there. */
const removePendingToolApproval = (id) => {
  const approval = pendingToolApprovals.get(id);
  if (!approval) return;
  pendingToolApprovals.delete(id);
  if (typeof approval.chatId === "string" && !isAwaiting(approval.chatId)) {
    announce(approval.chatId, false);
  }
};

export const toolApprovalResponseSchema = z.object({
  chatId: z.string().min(1).optional(),
  approved: z.boolean(),
  id: z.string().min(1),
  reason: z.string().nullable().optional(),
  scope: z.enum(["once", "session"]).default("once"),
});

/**
 * Waits for the user's answer to approval `id`. `chatId`, when the turn
 * knows it, is the chat announced as waiting meanwhile.
 * @param {{ id: string, chatId?: string | null, provider: string, request: unknown, signal?: AbortSignal }} options
 */
export const waitForToolApproval = ({
  id,
  chatId = null,
  provider,
  request,
  signal,
}) =>
  new Promise((resolve) => {
    let settled = false;

    const finish = (response) => {
      if (settled) {
        return;
      }

      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      removePendingToolApproval(id);
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
      chatId,
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
    // A saved approval can outlive its provider callback after a restart.
    // Never tell the renderer that an expired callback was accepted.
    return { handled: false, status: "not-found" };
  }

  removePendingToolApproval(payload.id);
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
