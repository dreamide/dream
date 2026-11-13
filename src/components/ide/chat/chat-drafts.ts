/**
 * Each chat's live composer draft, held outside React (GLOSSARY.md: Composer
 * draft). A draft is the text being written and the references picked into
 * it. They are kept together because a picked file sits in the text as an
 * icon slot and its name, and only its reference knows its path. A draft
 * also knows where prompt history navigation stands.
 *
 * A draft outlives the chat panel that shows it, the way a File editor
 * session's drafts outlive the Files panel, and code outside the panel adds
 * to it directly: a queued message that could not be sent comes back to it
 * (chat-runtime.ts). The panel renders it (`useChatDraft`), and the composer
 * edits it through its value (chat-composer.tsx).
 */
import type { UIMessage } from "ai";
import { useCallback, useSyncExternalStore } from "react";
import type { ComposerDraft } from "./composer-draft";

const EMPTY_DRAFT: ComposerDraft = Object.freeze({
  references: Object.freeze([]) as unknown as ComposerDraft["references"],
  text: "",
});

/**
 * `existing` with `addition` after it, a blank line between: how text is
 * added to a draft, by a returned message or by the + menu.
 */
export const appendDraftText = (existing: string, addition: string) => {
  const kept = existing.trimEnd();
  return kept ? `${kept}\n\n${addition}` : addition;
};

/** What a user sent before in a chat, oldest first: Up walks back through it. */
export const promptHistoryOf = (messages: UIMessage[]) =>
  messages
    .filter((message) => message.role === "user")
    .map((message) =>
      message.parts
        .filter(
          (part): part is Extract<typeof part, { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text.trim())
        .join("\n\n"),
    )
    .filter((text) => text.length > 0);

interface Entry {
  draft: ComposerDraft;
  /** While walking history: the entry shown, and the draft to come back to. */
  history: { index: number; saved: ComposerDraft } | null;
}

export const createChatDrafts = () => {
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();

  const write = (chatId: string, entry: Entry) => {
    const empty =
      entry.draft.text === "" &&
      entry.draft.references.length === 0 &&
      entry.history === null;
    // An empty draft is no draft: nothing is kept for it.
    if (empty) entries.delete(chatId);
    else entries.set(chatId, entry);
    for (const listener of listeners.get(chatId) ?? []) listener();
  };
  const entryOf = (chatId: string): Entry =>
    entries.get(chatId) ?? { draft: EMPTY_DRAFT, history: null };

  return {
    /** `chatId`'s draft; the same object until it changes. */
    get: (chatId: string): ComposerDraft => entryOf(chatId).draft,

    subscribe(chatId: string, listener: () => void) {
      let set = listeners.get(chatId);
      if (!set) {
        set = new Set();
        listeners.set(chatId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(chatId);
      };
    },

    /** The draft as the composer has it now (typing, picking, removing). */
    set(chatId: string, draft: ComposerDraft) {
      const entry = entryOf(chatId);
      if (entry.draft === draft) return;
      write(chatId, { ...entry, draft });
    },

    /** Adds text to the draft, after what is there. */
    append(chatId: string, text: string) {
      if (!text) return;
      const entry = entryOf(chatId);
      write(chatId, {
        ...entry,
        draft: {
          ...entry.draft,
          text: appendDraftText(entry.draft.text, text),
        },
      });
    },

    /** It was sent: the draft empties and history navigation starts over. */
    clear(chatId: string) {
      write(chatId, { draft: EMPTY_DRAFT, history: null });
    },

    /**
     * Up or Down in the composer. Up from the draft (with the caret at its
     * start) shows the latest prompt sent, and further Ups earlier ones; Down
     * walks forward again and, past the latest, back to the draft as it was.
     * Returns whether the key was taken.
     */
    stepHistory(
      chatId: string,
      key: "ArrowUp" | "ArrowDown",
      { caretAtStart, history }: { caretAtStart: boolean; history: string[] },
    ) {
      const entry = entryOf(chatId);
      const show = (index: number) =>
        write(chatId, {
          draft: { references: [], text: history[index] },
          history: { index, saved: entry.history?.saved ?? entry.draft },
        });

      if (!entry.history) {
        if (key === "ArrowDown" || !caretAtStart || history.length === 0)
          return false;
        show(history.length - 1);
        return true;
      }
      if (key === "ArrowUp") {
        if (entry.history.index === 0) return false;
        show(Math.min(entry.history.index, history.length) - 1);
        return true;
      }
      if (entry.history.index < history.length - 1) {
        show(entry.history.index + 1);
        return true;
      }
      write(chatId, { draft: entry.history.saved, history: null });
      return true;
    },
  };
};

export type ChatDrafts = ReturnType<typeof createChatDrafts>;

/** This window's drafts. */
export const chatDrafts = createChatDrafts();

/** `chatId`'s draft, kept current, and a way to change it. */
export const useChatDraft = (chatId: string) => {
  const draft = useSyncExternalStore(
    useCallback((listener) => chatDrafts.subscribe(chatId, listener), [chatId]),
    () => chatDrafts.get(chatId),
  );
  const setDraft = useCallback(
    (next: ComposerDraft) => chatDrafts.set(chatId, next),
    [chatId],
  );
  return { draft, setDraft };
};
