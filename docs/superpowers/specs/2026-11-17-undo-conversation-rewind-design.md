# Conversation rewind for `/undo` and `/revert`

## Intent

`/undo` currently restores workspace files to the checkpoint of a user turn but leaves
the conversation untouched. Make it also move the conversation back to just before that
turn, and put the undone prompt back into the editor so the user can edit and resend it.
`/revert` restores the files and moves the conversation forward to where it was before
the undo.

## Goals

- `/undo` and `/undo <turn>` restore files **and** move the session leaf to the parent
  of that turn's user message, re-render the chat, and refill the editor with the undone
  prompt text.
- `/revert` restores files **and** moves the leaf back to the entry that was current
  before the undo.
- Reuse the existing session tree navigation so extensions still receive
  `session_before_tree` / `session_tree`, and model/thinking restoration comes from the
  existing projection.
- Click-to-undo on a user message stays file-only, as its dialog already says.

## Non-goals

- Deleting transcript entries. A rewind is a leaf move; abandoned entries stay in the
  session file as another branch and remain reachable through `/tree`.
- Restoring conversation state across processes. `/revert` is already in-memory only.
- Fixing checkpoint numbering after tree navigation. Checkpoints are keyed by turn index,
  not by branch, so `/undo` after `/tree` may target a checkpoint created on a sibling
  branch. That limitation predates this change and is out of scope.
- The p2 web UI.

## Constraints found

- Checkpoints are keyed by turn index (count of user messages on the branch + 1,
  `agent-session.ts:1993`); `navigateTree` takes an entry id. The user entry must be
  resolved on the active branch before anything is undone.
- `session.navigateTree(target, { summarize: false })` refuses while streaming or
  compacting, may be cancelled by a `session_before_tree` handler, and returns
  `editorText` for user-message targets.
- One `InteractiveMode` instance serves every tab, so per-session state cannot live on
  the instance. The redo target is stored next to the pending revert in
  `CheckpointManager`, which is already per session.
- A workspace without a checkpoint (non-git cwd) still makes `/undo` do nothing, as today.

## Approaches

**A. Leaf move through `navigateTree` (chosen).** `/undo` calls `navigateTree` with the
resolved user entry, then clears and re-renders the chat, then refills the editor from
`editorText`. `/revert` calls `navigateTree` with the stored leaf id. Entries stay in the
file; extension hooks and projection restore work unchanged. Small diff, no session
format change.

**B. Snapshot and swap the session file.** `/undo` copies the `.jsonl`, `/revert` swaps
it back. Byte-exact, but it reloads a live runtime mid-session, interacts badly with
open tabs and extension state, and is far heavier for the same user-visible result.

Deleting entries was rejected: it destroys the abandoned branch and leaves nothing for
`/revert` to navigate back to.

## Behavior

`/undo` (no argument):

1. Resolve the last user message entry on the active branch. Its turn index is used for
   the checkpoint lookup. If there is none, warn `No user turn to undo.` and stop.
2. `checkpointManager.undoToCheckpoint(turn, currentLeafId)` restores the files and
   records the redo target. Errors keep today's `Failed to undo: <message>`.
3. `session.navigateTree(userEntry.id, { summarize: false })`.
4. On success: `chatContainer.clear()`, `renderInitialMessages()`, fill the editor with
   `editorText` if the editor is empty (it is, the submit handler cleared it), then the
   status line
   `Undid checkpoint (+N restored, -M removed) and moved the conversation back. Use /revert to restore.`
5. Navigation cancelled by an extension: warning
   `Undid checkpoint (+N restored, -M removed) but the conversation was not moved back. Use /revert to restore.`
   The revert record is kept so the files can still be restored.
6. Navigation throws: warning
   `Undid checkpoint (+N restored, -M removed) but rewinding the conversation failed: <message>. Use /revert to restore.`

`/undo <turn>`: same flow, resolving the Nth user entry on the active branch. If the
branch has fewer user messages, warn `No user message found for that turn.` and stop.

`/revert`:

1. Read and clear the stored redo target, then `checkpointManager.revertUndo()`.
2. If a leaf id was stored, `navigateTree(leafId, { summarize: false })`, re-render, and
   show `Reverted undo: code changes and conversation restored.`
3. With no stored leaf (click-to-undo), keep the current file-only revert and its
   `Reverted undo: code changes restored.` message.
4. Navigation cancelled or failing: warning that the code changes were restored but the
   conversation was not moved forward; do not throw away the successful file restore.

The submit handler clears the editor before both commands run, so `/revert` leaves the
editor empty; the restored prompt is not preserved through a redo.

## Decisions

- Resolve the user entry before touching the checkpoint: `/undo` either does both parts
  or, when the turn cannot be resolved, warns and does nothing.
- File restore runs before navigation, so a failed rewind never loses the revert record.
- A partial failure is a warning plus the revert hint, not an error that hides the
  successful file restore.
- One pending redo target, matching the existing single `latestRevertId`; it is cleared
  in `revertUndo` and `dismissRevert`.
- Messages sent after an undo stay on their branch. `/revert` still moves the leaf back,
  so those messages become a side branch reachable via `/tree`; the status says the
  conversation was restored, not that anything was deleted.
- Extract one private helper for "clear chat, render initial messages, refill an empty
  editor" and use it from `/tree`, the extension `navigateTree` wrapper, `/undo`, and
  `/revert`.

## Files

- `packages/coding-agent/src/core/checkpoint-manager.ts`: store the redo leaf id with the
  latest revert, expose it, clear it on revert/dismiss.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: resolve user turns,
  rewind on `/undo`, redo on `/revert`, shared UI helper.
- `packages/coding-agent/src/core/slash-commands.ts`: command descriptions.
- `packages/coding-agent/docs/slash-commands.md`: command table.
- `packages/coding-agent/CHANGELOG.md`: Unreleased entry.

## Tests

- `test/checkpoint-manager.test.ts`: the leaf id is stored, returned, and cleared by
  revert and dismiss.
- `test/interactive-mode-undo-command.test.ts`:
  - `/undo` resolves the last user entry, records the current leaf, navigates, refills
    the editor, re-renders, and shows the new status.
  - `/undo 3` resolves the third branch user entry.
  - no user turn warns and calls neither undo nor navigation.
  - navigation cancelled/errored keeps the file undo and warns.
  - `/revert` navigates back to the stored leaf and shows the redo status; without a
    stored leaf it behaves as today.
- `test/interactive-mode-undo-click.test.ts`: assert click-to-undo never navigates.
- One `test/suite/` scenario driving a real session with the faux provider: send a
  prompt, `/undo`, assert the chat shows only earlier turns and the editor holds the
  prompt; `/revert`, assert the turn is back. Add only if the suite harness can drive
  the editor and chat without a terminal; otherwise rely on the unit tests.
