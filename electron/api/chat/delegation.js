import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getProvider, listProviders } from "../providers/registry.js";
import { createMcpRequestHandler } from "../shared/mcp-handler.js";

export const ORCHESTRATION_MCP_PATH = "/api/mcp/orchestration";
const providerId = z.enum([
  "openai",
  "anthropic",
  "opencode",
  "cursor",
  "grok",
  "antigravity",
]);
const delegateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(200)
    .describe("Stable task key. Reuse it when retrying the same delegation."),
  provider: providerId,
  model: z.string().min(1),
  prompt: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "Self-contained task and context. Child shares project files, not parent conversation.",
    ),
  permissionMode: z
    .enum(["ask", "auto-accept-edits", "full-access"])
    .optional(),
});
const taskSchema = z.object({ id: z.string().min(1) });
const result = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

export function createDelegationService({
  catalog,
  scheduler,
  providers = { get: getProvider, list: listProviders },
}) {
  const scopes = new Map();
  let endpoint;
  return {
    setEndpoint(baseUrl) {
      endpoint = `${baseUrl}${ORCHESTRATION_MCP_PATH}`;
    },
    async handle(request) {
      const token = request.headers
        .get("authorization")
        ?.replace(/^Bearer /, "");
      const scope = scopes.get(token);
      if (!scope || scope.signal.aborted)
        return new Response("Expired or invalid task scope.", { status: 401 });
      return createMcpRequestHandler({
        name: "dream-orchestration",
        tools: scope.tools,
      })(request);
    },
    open(run, signal) {
      const parent = providers.get(run.request.provider);
      if (!parent.mcp) return { tools: null, mcpServers: [], close() {} };
      const token = randomUUID();
      const active = () => {
        if (signal.aborted || !scopes.has(token))
          throw new Error("Parent turn is no longer active.");
      };
      const ownedTask = async (id) => {
        const task = (await catalog.delegatedTasks(run.chatId)).find(
          (entry) => entry.id === id,
        );
        if (!task)
          throw new Error("Task does not belong to this conversation.");
        return task;
      };
      const define = (description, inputSchema, handler) => ({
        description,
        inputSchema,
        handler: async (args) => {
          try {
            active();
            return result(await handler(inputSchema.parse(args)));
          } catch (error) {
            return {
              ...result({
                error: error instanceof Error ? error.message : String(error),
              }),
              isError: true,
            };
          }
        },
      });
      const tools = {
        orchestration_capabilities: define(
          "List agent providers, readiness and whether they can delegate. Use explicit model IDs supported by the chosen provider.",
          z.object({}),
          async () =>
            Promise.all(
              providers.list().map(async (provider) => ({
                provider: provider.id,
                canDelegate: provider.mcp,
                unavailable: (await provider.checkReady())?.message ?? null,
              })),
            ),
        ),
        delegate_task: define(
          "Start a durable task on another agent provider in this project. Tasks share files: give independent scopes to avoid conflicts. Returns an ID immediately; use task_status for results. Parent Stop stops children. Child permissions cannot exceed the parent.",
          delegateSchema,
          async (input) => {
            const unavailable = await providers
              .get(input.provider)
              .checkReady();
            if (unavailable) throw new Error(unavailable.message);
            active();
            const receipt = await catalog.mutateRunQueue({
              type: "delegate",
              chatId: run.chatId,
              id: run.id,
              request: input,
            });
            scheduler.dispatch(receipt.childChatId);
            return receipt;
          },
        ),
        task_status: define(
          "List this conversation's delegated tasks, or fetch one task and its latest assistant answer. Poll while queued/running/waiting; results remain available in future turns and after restart.",
          z.object({ id: z.string().min(1).optional() }),
          async ({ id }) => {
            if (!id) return catalog.delegatedTasks(run.chatId);
            const task = await ownedTask(id);
            const page = await catalog.transcriptPage({
              chatId: task.childChatId,
              limit: 40,
            });
            const answer = page.messages.findLast(
              (message) => message.role === "assistant",
            );
            const text =
              answer?.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n") ?? "";
            return {
              ...task,
              result: text.slice(-64_000),
              truncated: text.length > 64_000,
              complete: task.status === "completed",
            };
          },
        ),
        task_cancel: define(
          "Stop a delegated task and its descendants, cancelling work that has not started.",
          taskSchema,
          async ({ id }) => {
            const task = await ownedTask(id);
            await scheduler.cancelTask(task.childChatId);
            return ownedTask(id);
          },
        ),
      };
      const close = () => {
        scopes.delete(token);
        signal.removeEventListener("abort", close);
      };
      scopes.set(token, { tools, signal });
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
      // Codex tools are bound to a thread. Never put a run token into its
      // shared process-wide MCP configuration.
      return {
        tools,
        close,
        mcpServers:
          parent.id === "openai" || !endpoint
            ? []
            : [
                {
                  id: "dream-orchestration",
                  name: "dream_orchestration",
                  enabled: true,
                  transport: "http",
                  url: endpoint,
                  headers: { Authorization: `Bearer ${token}` },
                },
              ],
      };
    },
  };
}
