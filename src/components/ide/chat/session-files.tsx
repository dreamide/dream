import type { UIMessage } from "ai";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from "react";
import {
  describeSessionFile,
  isToolLikePart,
} from "../assistant-message-tools";

/** Absolute paths of session files, by the path their agent links them with. */
type SessionFiles = ReadonlyMap<string, string>;

const NO_SESSION_FILES: SessionFiles = new Map();

const SessionFilesContext = createContext(NO_SESSION_FILES);

export const useSessionFiles = () => useContext(SessionFilesContext);

/** The session files one message saves, worked out once per message object. */
const declaredFiles = new WeakMap<UIMessage, ReadonlyArray<[string, string]>>();

const filesSavedBy = (message: UIMessage) => {
  let files = declaredFiles.get(message);
  if (!files) {
    const found: [string, string][] = [];
    for (const part of message.parts) {
      const file = isToolLikePart(part) ? describeSessionFile(part) : null;
      if (file) found.push([file.sessionPath, file.path]);
    }
    files = found;
    declaredFiles.set(message, files);
  }
  return files;
};

const sameFiles = (left: SessionFiles, right: SessionFiles) => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [name, path] of left) if (right.get(name) !== path) return false;
  return true;
};

/**
 * The session files each message's links can name: those saved by it or before
 * it. A later agent session numbers its files from the start again, so a link
 * has to mean the file that had the name when the link was written.
 *
 * Given the previous result, a message whose files are the same gets the same
 * map, so a live turn re-renders no file link in the messages before it; a
 * message is only read again when it is a new object (the live one).
 */
export const getSessionFilesByMessage = (
  messages: UIMessage[],
  previous?: ReadonlyMap<string, SessionFiles>,
) => {
  const filesByMessage = new Map<string, SessionFiles>();
  let files = NO_SESSION_FILES;

  for (const message of messages) {
    const saved = filesSavedBy(message);
    if (saved.some(([name, path]) => files.get(name) !== path)) {
      const next = new Map(files);
      for (const [name, path] of saved) next.set(name, path);
      files = next;
    }
    const before = previous?.get(message.id);
    if (before && sameFiles(before, files)) files = before;
    filesByMessage.set(message.id, files);
  }

  return filesByMessage;
};

/** `getSessionFilesByMessage` for a panel's messages, kept across updates. */
export const useSessionFilesByMessage = (messages: UIMessage[]) => {
  const previous = useRef<ReadonlyMap<string, SessionFiles>>(undefined);
  return useMemo(() => {
    const next = getSessionFilesByMessage(messages, previous.current);
    previous.current = next;
    return next;
  }, [messages]);
};

export const SessionFilesProvider = ({
  children,
  files = NO_SESSION_FILES,
}: {
  children: ReactNode;
  files?: SessionFiles;
}) => (
  <SessionFilesContext.Provider value={files}>
    {children}
  </SessionFilesContext.Provider>
);
