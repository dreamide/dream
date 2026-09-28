import { createContext, useContext } from "react";

/**
 * Appends text to the composer's prompt and focuses it once the + menu closes.
 * Provided by `ChatComposer` around its action menu items; `null` outside it.
 */
export const ChatComposerInsertContext = createContext<
  ((text: string) => void) | null
>(null);

export const useChatComposerInsert = () =>
  useContext(ChatComposerInsertContext);
