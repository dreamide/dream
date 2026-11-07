import type { UIMessage } from "ai";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  describeSessionFile,
  isToolLikePart,
} from "../assistant-message-tools";

/** Absolute paths of session files, by the path their agent links them with. */
type SessionFiles = ReadonlyMap<string, string>;

const NO_SESSION_FILES: SessionFiles = new Map();

const SessionFilesContext = createContext(NO_SESSION_FILES);

export const useSessionFiles = () => useContext(SessionFilesContext);

/**
 * The session files each message's links can name: those saved by it or before
 * it. A later agent session numbers its files from the start again, so a link
 * has to mean the file that had the name when the link was written.
 */
export const getSessionFilesByMessage = (messages: UIMessage[]) => {
  const filesByMessage = new Map<string, SessionFiles>();
  let files = NO_SESSION_FILES;

  for (const message of messages) {
    for (const part of message.parts) {
      const file = isToolLikePart(part) ? describeSessionFile(part) : null;
      if (file) {
        files = new Map(files).set(file.sessionPath, file.path);
      }
    }
    filesByMessage.set(message.id, files);
  }

  return filesByMessage;
};

export const SessionFilesProvider = ({
  children,
  files = NO_SESSION_FILES,
}: {
  children: ReactNode;
  files?: SessionFiles;
}) => {
  // The map is rebuilt on every stream update; keep the value while its content
  // holds so a live turn does not re-render every file link in the transcript.
  const entries = JSON.stringify([...files]);
  const value = useMemo<SessionFiles>(
    () => new Map(JSON.parse(entries)),
    [entries],
  );

  return (
    <SessionFilesContext.Provider value={value}>
      {children}
    </SessionFilesContext.Provider>
  );
};
