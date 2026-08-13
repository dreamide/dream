export const CHAT_TRANSCRIPT_WINDOW_SIZE = 40;

export const getTranscriptWindow = <Message>(
  messages: readonly Message[],
  requestedSize: number,
) => {
  const windowSize = Math.max(1, Math.floor(requestedSize));
  const startIndex = Math.max(0, messages.length - windowSize);

  return {
    hiddenMessageCount: startIndex,
    messages: messages.slice(startIndex),
    startIndex,
  };
};
