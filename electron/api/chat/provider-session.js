const getNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const shouldResumeProviderSession = ({
  model,
  modelSpeed = "standard",
  projectPath,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
}) =>
  Boolean(
    getNonEmptyString(remoteConversationId) &&
      remoteConversationModel === model &&
      (remoteConversationModelSpeed ?? "standard") === modelSpeed &&
      remoteConversationProjectPath === projectPath,
  );

export const getProviderSessionMetadata = ({
  model,
  modelSpeed = "standard",
  projectPath,
  responseMessageMetadata,
  sessionId,
}) => ({
  ...responseMessageMetadata,
  remoteConversationId: sessionId,
  remoteConversationModel: model,
  remoteConversationModelSpeed: modelSpeed,
  remoteConversationProjectPath: projectPath,
});
