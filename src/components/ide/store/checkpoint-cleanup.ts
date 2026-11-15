import { type ApiClient, apiClient } from "@/lib/api-client";
import { type ProjectScope, projectScope } from "@/lib/project-resource-cache";
import type { ChatConfig, ProjectConfig } from "@/types/ide";

const ignoreFailure = () => {
  // Checkpoint cleanup is best-effort; leftover snapshots are harmless.
};

/**
 * Drops the checkpoint snapshots that belong to chats being permanently
 * deleted. Runs fire-and-forget; the store never waits on it.
 */
export const requestChatCheckpointCleanup = (
  chats: ChatConfig[],
  projects: ProjectConfig[],
  api: ApiClient = apiClient,
) => {
  if (chats.length === 0) {
    return;
  }

  // One request per Project, on its own Host: the same path on two Hosts
  // is two Projects.
  const byProject = new Map<
    string,
    { chatIds: string[]; scope: ProjectScope }
  >();
  for (const chat of chats) {
    const project = projects.find((item) => item.id === chat.projectId);
    if (!project) {
      continue;
    }
    const entry = byProject.get(project.id) ?? {
      chatIds: [],
      scope: projectScope(project),
    };
    entry.chatIds.push(chat.id);
    byProject.set(project.id, entry);
  }

  for (const { chatIds, scope } of byProject.values()) {
    api
      .checkpointDeleteChats(
        { chatIds, projectPath: scope.projectPath },
        { hostId: scope.hostId },
      )
      .catch(ignoreFailure);
  }
};
