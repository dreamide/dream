const MAX_SCROLLBACK_CHARACTERS = 150_000;

interface TerminalScrollbackBuffer {
  chunks: string[];
  firstChunkOffset: number;
  firstChunkIndex: number;
  length: number;
}

type TerminalOutputListener = (chunk: string) => void;

const scrollbackBySessionId = new Map<string, TerminalScrollbackBuffer>();
const listenersBySessionId = new Map<string, Set<TerminalOutputListener>>();

const createBuffer = (): TerminalScrollbackBuffer => ({
  chunks: [],
  firstChunkOffset: 0,
  firstChunkIndex: 0,
  length: 0,
});

const compactDiscardedChunks = (buffer: TerminalScrollbackBuffer) => {
  if (
    buffer.firstChunkIndex >= 1_024 &&
    buffer.firstChunkIndex * 2 >= buffer.chunks.length
  ) {
    buffer.chunks.splice(0, buffer.firstChunkIndex);
    buffer.firstChunkIndex = 0;
  }
};

const appendToBuffer = (buffer: TerminalScrollbackBuffer, chunk: string) => {
  if (chunk.length >= MAX_SCROLLBACK_CHARACTERS) {
    buffer.chunks = [chunk.slice(-MAX_SCROLLBACK_CHARACTERS)];
    buffer.firstChunkOffset = 0;
    buffer.firstChunkIndex = 0;
    buffer.length = MAX_SCROLLBACK_CHARACTERS;
    return;
  }

  buffer.chunks.push(chunk);
  buffer.length += chunk.length;

  let charactersToDiscard = buffer.length - MAX_SCROLLBACK_CHARACTERS;
  while (charactersToDiscard > 0) {
    const firstChunk = buffer.chunks[buffer.firstChunkIndex];
    if (firstChunk === undefined) {
      buffer.chunks = [];
      buffer.firstChunkOffset = 0;
      buffer.firstChunkIndex = 0;
      buffer.length = 0;
      return;
    }

    const availableCharacters = firstChunk.length - buffer.firstChunkOffset;
    if (charactersToDiscard < availableCharacters) {
      buffer.firstChunkOffset += charactersToDiscard;
      buffer.length -= charactersToDiscard;
      compactDiscardedChunks(buffer);
      return;
    }

    buffer.firstChunkIndex += 1;
    buffer.firstChunkOffset = 0;
    buffer.length -= availableCharacters;
    charactersToDiscard -= availableCharacters;
  }

  compactDiscardedChunks(buffer);
};

export const resetTerminalScrollback = (sessionId: string) => {
  scrollbackBySessionId.set(sessionId, createBuffer());
};

export const deleteTerminalScrollback = (sessionId: string) => {
  scrollbackBySessionId.delete(sessionId);
  listenersBySessionId.delete(sessionId);
};

export const hasTerminalScrollback = (sessionId: string) =>
  scrollbackBySessionId.has(sessionId);

export const getTerminalScrollback = (sessionId: string) => {
  const buffer = scrollbackBySessionId.get(sessionId);
  if (!buffer || buffer.chunks.length === 0) {
    return "";
  }

  const [firstChunk, ...remainingChunks] = buffer.chunks.slice(
    buffer.firstChunkIndex,
  );
  return [
    firstChunk?.slice(buffer.firstChunkOffset) ?? "",
    ...remainingChunks,
  ].join("");
};

export const publishTerminalOutput = (sessionId: string, chunk: string) => {
  const buffer = scrollbackBySessionId.get(sessionId);
  if (!buffer || !chunk) {
    return false;
  }

  appendToBuffer(buffer, chunk);
  for (const listener of listenersBySessionId.get(sessionId) ?? []) {
    listener(chunk);
  }

  return true;
};

export const subscribeToTerminalOutput = (
  sessionId: string,
  listener: TerminalOutputListener,
) => {
  let listeners = listenersBySessionId.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    listenersBySessionId.set(sessionId, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersBySessionId.delete(sessionId);
    }
  };
};
