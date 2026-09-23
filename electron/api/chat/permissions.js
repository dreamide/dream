import { normalizeChatPermissionMode } from "../../shared/chat-permissions.js";

export const resolveChatPermissionModes = ({ agentMode, permissionMode }) => ({
  permissionMode: normalizeChatPermissionMode(permissionMode, agentMode),
});
