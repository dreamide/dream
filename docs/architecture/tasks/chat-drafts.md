# The live Composer draft, per chat, outside React

## DRF-01: A chat's draft is held whole, outside the panel

Status: implemented

Problem and trigger: from the 2026-11-12 architecture review (candidate 7).
The draft being written in a chat was held in three places:

- its text in `ChatPanel`'s `useState`;
- its picked references and the caret token in `ChatComposer`'s state;
- prompt history navigation's position and saved draft in refs
  (`usePromptHistoryNavigation`).

The halves were kept in step by an effect that cleared the references
whenever the text became empty. Outside code reached the draft through a
mailbox in the runtime store, `draftRestoreByChatId`, which an effect in the
panel drained. The draft was lost whenever its panel unmounted, which happens
once a chat is scrolled past the keep-alive limit. History navigation saved
and restored only the text, so a draft with a picked file came back without
its reference.

Scope:

- **The new module.** `src/components/ide/chat/chat-drafts.ts` holds each
  chat's draft:
  - its text and references, as one `ComposerDraft`;
  - its history walk;
  - `get`, `subscribe`, `set` and `append`;
  - `clear`, called on send;
  - `stepHistory`, plus `promptHistoryOf`;
  - the `useChatDraft` hook.

  A factory (`createChatDrafts`) has one app instance, `chatDrafts`. An empty
  draft is not kept.
- **`ChatComposer` takes one controlled value.** `draft` with
  `onDraftChange`, holding text and references, replaces `promptText` and
  `onPromptTextChange`. Only the caret token stays in the composer. After a
  send the composer closes the token, and the owner empties the draft.
- **Owners:**
  - the chat panel uses `useChatDraft`, `chatDrafts.stepHistory` for Up and
    Down, and `chatDrafts.clear` on send;
  - the stash's new-item composer holds its whole draft;
  - the stash item composer keeps its text on the item and holds the picked
    references itself.
- **Appending.** The runtime appends a returned message to the chat's draft
  directly. The mailbox, `takeChatDraftRestore` and the panel effect are
  gone. One rule, `appendDraftText` (trim the end, then a blank line), now
  serves both the returned message and the + menu insert, which used two
  slightly different rules.

Changes in behaviour, all deliberate:

- A chat's draft survives its panel unmounting.
- Walking history and coming back restores the draft's references too.
- A history entry is shown with no references; before, the previous ones
  stayed attached.

Bug avoided during the change: the composer used to apply a "submitted" edit
worked out from the draft as it was before sending. With the text now part of
the controlled value, that edit would have handed the sent text back to an
owner that had just emptied it. So the composer no longer edits the draft
after a send; it only closes its caret token, and the owner empties the
draft.

Excluded:

- attachments, which stay in `prompt-input.tsx`;
- the + menu's insert context;
- the focus shortcut's DOM query in `code-workspace.tsx`, which moves focus
  and never touches the draft;
- drafts across a restart;
- dropping the draft of a deleted chat, which is simply never shown.

Completion criteria:

- One place holds a chat's draft. The runtime, the panel and history
  navigation reach it through its interface.
- Text and references are never stored apart for a chat.
- Sending empties the draft, and the composer never sends the text back
  afterwards.
- The draft and history rules are tested without React.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 214 test files (1,504 tests, 4 skipped).

- `chat-drafts.test.ts` (7 tests) checks per-chat drafts, appending, clearing,
  the history walk, and restoring a draft with its references.
- The runtime test checks that a returned message lands in the draft of a
  chat no panel shows.

Limitation: the repository's tests run in Node on `*.test.ts` only, and the
change was not tried in the running app. So these were not exercised:
typing, picking a file, Up and Down, sending, inserting from the + menu, a
draft surviving a panel unmount, and both stash composers.

Remaining/deferred: an in-app check of the cases above.

Recovery: docs/architecture/tasks/chat-drafts.md#drf-01. Check the status
above and the validation results.
