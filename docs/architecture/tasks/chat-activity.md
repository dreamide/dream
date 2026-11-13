# Chat activity: one answer per question

## ACT-01: Readers ask chat-activity instead of combining the signals

Status: implemented

Problem and trigger: from the 2026-11-12 architecture review (candidate 6).
The store keeps separate signals about a chat:

- `streamingChatIds`: a session in this window streams it;
- `hostRunningChatIds`: a turn runs on the host;
- `awaitingAnswerChatIds` and `hostAwaitingApprovalChatIds`: something waits
  on the user, here or on the host;
- `pendingChatSubmitByChatId`: a message is queued here.

Each reader combined these itself, and the combinations disagreed:

| Question | Readers | What they checked |
|---|---|---|
| Is a turn running? | projects panel and project tabs (spinner), commit box, auto-archive | this window's stream only |
| Is a turn running? | branching | this window or the host |
| Is it waiting on its user? | project tabs ×2, projects panel | this window or the host (written three times) |
| Can a message go to it? | browser element, inline diff and feedback popovers | this window's stream only |
| Can a message go to it? | stash and saved-prompt gate | stream and queue |

The saved-prompt gate said it mirrored `queueChatSubmit`. It did not:
`queueChatSubmit` refuses only a chat that already has a queued message.

Scope: `src/components/ide/chat-activity.ts` answers each question once, over
the store's signals:

- `isChatRunning`: this window's stream or a turn on the host;
- `isChatWaitingOnUser`: this window or the host;
- `chatAcceptsMessage`: nothing streams here and nothing is queued;
- `projectIdsWithRunningChats` and `isProjectRunning`;
- `chatIdsWaitingOnUser`;
- `selectChatActivity`, a selector for shallow comparison.

Every reader above now asks it. Changes in behaviour, all deliberate:

- **Running counts a turn on the host everywhere.** The projects panel and
  project tabs show the spinner for another client's turn. The commit box
  waits while an agent writes in the project from anywhere. Auto-archive no
  longer archives a chat whose turn runs on the host. Branching already
  worked this way, and so did the waiting indicator, whose comment said so.
- **The project tabs lose a special case.** They no longer add host-awaiting
  chats to the running projects: a chat waiting on the host has a turn
  running there, which running now includes.
- **The three feedback popovers refuse a chat with a queued message**, as the
  stash and the saved-prompt gate already did. `queueChatSubmit` refused it
  anyway.
- **Accepting a message does not wait for a turn on the host.** That was
  already true for every gate; the module now states it as the rule.

Excluded: two readers are about this window rather than the chat, and keep
their own rules:

- the chat runtime's `isSessionBusy`;
- the transcript cache's eviction guard.

The side effects inside `setChatStreaming`'s updater (the activity store's
start and finish) are unchanged.

Completion criteria:

- No reader outside the runtime, the cache, the store's writers and the
  `getAwaitingAnswerProjectIds` helper combines the raw signals.
- Each question has one answer, tested signal by signal.
- A turn on the host blocks branching and auto-archive.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 213 test files.

- `chat-activity.test.ts` checks each signal against each question.
- `chat-branch-actions.test.ts` now checks that a host turn blocks branching,
  and adds an auto-archive test.

Limitation: the spinner and the commit box's behaviour for another client's
turn were not checked in the running app.

Remaining/deferred: the `setChatStreaming` side effects.

Recovery: docs/architecture/tasks/chat-activity.md#act-01. Check the status
above and the validation results.
