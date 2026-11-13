# Finishing a worktree, outside React

## FWT-01: One flow for merging and removing a worktree

Status: implemented

Problem and trigger: from the 2026-11-12 architecture review (candidate 2).
Two dialogs finish a worktree:

- The Git actions dialog of a worktree project
  (`worktree-action-dialog.tsx`, 954 lines).
- The projects panel's remove dialog (`remove-worktree-dialog.tsx`).

Between them they held the destructive rules in React state, where no test
could reach them:

- **"May remove" was written twice.** `primaryDisabled` in one dialog,
  `canRemove` in the other. Both combined "uncommitted changes only when
  discarded" with "the branch only after an unblocked delete preview".
- **Forgetting the worktree was sequenced two ways.** One dialog purged when
  it closed. The other purged at once and refreshed the main checkout itself.
- **The uncommitted count came from two different reads.** One dialog used
  the compare's worktree status, the other a Project resources status.
- **The merge flow lived in React state.** It had five phases in 17
  `useState`/`useRef` calls, its merge rules inline, a compare-load effect,
  and its retry options in a ref.
- **The compare and per-file diff requests named no host.** They fell back to
  working it out from the path, where the active project wins.

Scope: `src/components/ide/git-actions/worktree-finish.ts` owns finishing a
worktree. It has a `WorktreeFinish` class with a snapshot, store actions
injected, and a `useWorktreeFinish` hook, following the Commit draft. It
owns:

- the phases;
- the compare (read whenever the review is shown, older reads ignored);
- why a merge is blocked, the merge itself, and its conflict;
- the removal options and the one "may remove" rule;
- which head an unmerged branch is deleted against;
- the removal, its retry with the same options, and removal after a merge;
- `finish`, which forgets the worktree only once git removed it, and once.

Both dialogs render it.

- Pacing stays each dialog's choice. The Git actions dialog shows the outcome
  and forgets the worktree as it closes. The projects panel forgets it as
  soon as git has removed it.
- Merging is offered only when the worktree is open as a project. The compare
  refuses detached worktrees, which the panel can list.
- Both dialogs now read uncommitted changes from one full Project resources
  status read of the worktree.
- The store's `forgetWorktree` refreshes the main checkout's git state however
  the removal ends, as `completeWorktreeProject` does after a merge. The panel
  dialog's own refresh call is gone. `purgeWorktreeProject` keeps its refresh
  for the delete-branch dialog, which purges without `forgetWorktree`.
- The compare and per-file diff requests now name the project's host.

Visible changes:

- The Git actions dialog shows the uncommitted-changes warning once the status
  is read, without waiting for the compare. Removing no longer waits for the
  compare either.
- Its "Retry removal" button no longer shows a spinner. The working view
  already replaced the button while a retry ran, so the spinner was never seen.

Excluded: each compared file's diff still loads inside the dialog
(`CompareFileRow`). The Changes view reads its diffs as Project resources
(CDR-01), and doing the same here is a separate change. The delete-branch
dialog keeps its own flow.

Completion criteria:

- One rule decides whether a worktree may be removed, for both dialogs.
- A purge happens only after git removed the worktree, and at most once per
  start.
- A retry reuses the failed removal's options. Nothing removes twice: not a
  second click while working, and not a click after a removal went through.
- An unmerged branch is deleted only against the head its preview showed.
- Merging waits for the compare and is refused for every blocking condition.
  A conflict or failure returns to a review with a fresh compare.
- Committing first returns to a fresh compare, and the stale one is not shown
  meanwhile.
- The main checkout is refreshed after a removal, failed ones included.

Validation (2026-11-13): `pnpm check` passed: the scratch-file check, lint,
typecheck, and 208 test files (1,470 tests, 4 skipped).

- `worktree-finish.test.ts` (13 tests) drives the class over fakes for every
  criterion above.
- `worktree-actions.test.ts` checks the main checkout refresh after a
  removal and after a failed one.

Limitation: the repository's tests run in Node on `*.test.ts` only, so neither
dialog is rendered by a test. Nobody opened the rebuilt dialogs in the app
during this change. The flow's interface is tested, and the dialogs type-check
against it.

Remaining/deferred:

- `CompareFileRow`'s diffs as Project resources (see Excluded).
- An in-app check of both dialogs: merge with a conflict, remove with a
  dirty worktree, remove with an unmerged branch, and a failed removal's
  retry.

Recovery: docs/architecture/tasks/worktree-finish.md#fwt-01. Check the status
above and the validation results.
