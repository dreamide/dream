export const resolveChatPermissionModes = ({ agentMode, permissionMode }) => {
  if (permissionMode === "full-access") {
    return {
      claudePermissionMode: "bypass-permissions",
      codexPermissionMode: "full-access",
    };
  }

  if (agentMode === "plan") {
    return {
      claudePermissionMode: "ask-permissions",
      codexPermissionMode: "default",
    };
  }

  return {
    claudePermissionMode: "accept-edits",
    codexPermissionMode: "auto-accept-edits",
  };
};
