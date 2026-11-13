// Native forks: a provider's own copy of a source session, cut at the source
// assistant message's recorded native boundary. Each is the `fork` of its
// provider's record (providers/registry.js); which branches fork at all is
// the Provider session's decision (provider-session.js). A fork answers the
// new session's id, `null` when the source recorded no boundary, and throws
// when the provider did not make an independent copy at that boundary.
import { forkSession } from "ai-sdk-provider-claude-code";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import {
  getCodexAppApprovalPolicy,
  getCodexAppSandboxMode,
} from "./codex-common.js";

/** Claude Code forks up to and including the source's native message. */
export async function forkClaudeSession({ source, projectPath }) {
  if (!source.nativeMessageId) return null;
  const fork = await forkSession(source.remoteConversationId, {
    dir: projectPath,
    upToMessageId: source.nativeMessageId,
  });
  if (!fork.sessionId || fork.sessionId === source.remoteConversationId)
    throw new Error("Provider did not create an independent fork.");
  return fork.sessionId;
}

/** Codex forks its thread up to and including the source's native turn. */
export async function forkCodexThread({
  source,
  projectPath,
  model,
  modelSpeed,
  permissionMode,
  mcpServers,
}) {
  if (!source.nativeTurnId) return null;
  const client = await getCodexAppServerClient({ mcpServers });
  const fork = await client.sendRequest("thread/fork", {
    threadId: source.remoteConversationId,
    lastTurnId: source.nativeTurnId,
    cwd: projectPath,
    model,
    serviceTier: modelSpeed === "fast" ? "fast" : null,
    approvalPolicy: getCodexAppApprovalPolicy(permissionMode),
    sandbox: getCodexAppSandboxMode(permissionMode),
    ephemeral: true,
  });
  if (!fork.thread?.id || fork.thread.id === source.remoteConversationId)
    throw new Error("Provider did not create an independent fork.");
  if (fork.thread.turns?.at(-1)?.id !== source.nativeTurnId)
    throw new Error("Provider did not confirm the requested fork boundary.");
  return fork.thread.id;
}
