import type { UIMessage } from "ai";
import { createChatConfig } from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";

export const getMessagesThroughBranchPoint = (
  messages: UIMessage[],
  messageId: string,
): UIMessage[] => {
  const branchIndex = messages.findIndex((message) => message.id === messageId);
  if (branchIndex === -1) {
    throw new Error(`Unable to find branch message: ${messageId}`);
  }

  return structuredClone(messages.slice(0, branchIndex + 1));
};

export const createBranchedChatConfig = (
  sourceChat: ChatConfig,
  targetProject: ProjectConfig,
  messageId: string,
): ChatConfig => {
  const branchedChat = createChatConfig(targetProject, {
    agentMode: sourceChat.agentMode,
    model: sourceChat.model,
    modelSpeed: sourceChat.modelSpeed,
    permissionMode: sourceChat.permissionMode,
    provider: sourceChat.provider,
    reasoningEffort: sourceChat.reasoningEffort,
    title: `${sourceChat.title} (branch)`,
  });

  return {
    ...branchedChat,
    branchedFrom: {
      chatId: sourceChat.id,
      messageId,
    },
    remoteConversationId: null,
    remoteConversationModel: null,
    remoteConversationModelSpeed: null,
    remoteConversationProjectPath: null,
    sparklesPalette: sourceChat.sparklesPalette,
  };
};
