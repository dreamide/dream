import { type ApiClient, apiClient } from "@/lib/api-client";
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

  const projectPathById = new Map(
    projects.map((project) => [project.id, project.path]),
  );
  const chatIdsByProjectPath = new Map<string, string[]>();
  for (const chat of chats) {
    const projectPath = projectPathById.get(chat.projectId);
    if (!projectPath) {
      continue;
    }
    const chatIds = chatIdsByProjectPath.get(projectPath) ?? [];
    chatIds.push(chat.id);
    chatIdsByProjectPath.set(projectPath, chatIds);
  }

  for (const [projectPath, chatIds] of chatIdsByProjectPath) {
    api.checkpointDeleteChats({ chatIds, projectPath }).catch(ignoreFailure);
  }
};
