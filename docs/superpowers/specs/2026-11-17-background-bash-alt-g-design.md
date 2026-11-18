# Alt+G to background the running bash command

## Intent

When the agent has started a bash/powershell tool command and is waiting for it, Alt+G
detaches that execution: the command keeps running, its output continues into a temp file,
and the tool call returns immediately so the agent can continue its turn. This is the
minimal detach approach chosen in the design discussion (Approach A).

## Goals

- Alt+G while a tool command is running backgrounds **that** execution. The child process
  is not killed; `escape`/abort still kills it as today.
- The tool result returned to the model says the command is running in the background and
  names the output file, so the agent can keep working and read the file later with the
  existing `read` tool.
- The TUI shows a status line with the output path.
- Built-in `bash` and `powershell` tools behave the same, since they share
  `createShellToolDefinition`.

## Non-goals

- No job registry, job ids, or tool to poll/wait for completion; no exit code is delivered
  after detaching.
- No automatic notification when the background command finishes.
- The user-typed `!command` path (`AgentSession.executeBash`), print/RPC modes, and the p2
  web UI.
- Stronger cross-process survival than pi already gives detached descendants, especially
  on Windows where the local backend does not spawn `detached`.

## Constraints found

- The shell tool awaits `ops.exec(...)` (`tools/bash.ts:392`). The abort signal currently
  kills the whole process tree (`tools/bash.ts:145-157`), so cancel cannot be reused for
  detach.
- `OutputAccumulator` only creates a temp file when output is truncated
  (`output-accumulator.ts:72-74`, `:110-112`); a detach needs a way to force persistence so
  the tool result can name a real file immediately.
- `waitForChildProcess` destroys the child's stdio streams when it settles
  (`child-process.ts:72-78`). Detaching must keep reading those streams until the process
  exits.
- `alt+g` is not used by any binding in `TUI_KEYBINDINGS` or `APP_KEYBINDINGS`, so no editor
  binding needs to change. (`ctrl+b` moves the cursor left and `alt+b` moves one word left;
  both stay as they are.) `CustomEditor.handleInput` checks app actions before editor keys
  (`custom-editor.ts:147-153`). Per AGENTS.md the new action must live in `APP_KEYBINDINGS`,
  not in a hardcoded key check.
- One `InteractiveMode` serves every tab, so the handle to the active execution belongs to
  the session, not the UI instance.

## Approaches

**A. Detach in place (chosen).** Add an app action bound to Alt+G. On press, the active
shell tool execution resolves its wait early without aborting the child, keeps streaming
output into a temp file, and returns a short tool result naming that file. Smallest change
that actually lets the agent continue; the cost is that the agent must check the file
itself and never learns the final exit code.

**B. Detach plus a job registry and poll/wait tool.** Gives the agent a job id and a way to
collect the exit code, but adds public API, a new tool, prompt changes and tests. Deferred
as scope creep for this request.

**C. UI-only detach** (stop rendering the command while the agent keeps waiting) was
rejected: it does not satisfy "agent continues immediately".

## Decisions (builder's calls, changeable in the plan)

- Add `app.bash.background` with default `alt+g` to `APP_KEYBINDINGS`. No editor binding is
  removed or changed. Update `docs/keybindings.md`.
- Keep a per-session handle to the running shell execution, registered when the tool
  starts and cleared when it settles. Alt+G with no running command shows a status and
  changes nothing.
- Add an optional `detached` flag to the result of `BashOperations.exec`; local backends
  resolve it early without aborting. Custom backends that do not implement detach keep
  today's behavior and report that the command cannot be backgrounded.
- On detach, force `OutputAccumulator` to persist all output to a temp file, snapshot it,
  and return the tool result with that path; keep writing to the file until the child exits.
- Add tests for the detach result, the keybinding, and the no-command case; run the package
  tests and `npm run check`.

## What is left to the builder

Decide the exact seam between `InteractiveMode`, `AgentSession` and the tool for reaching
the active execution, and how `waitForChildProcess` is bypassed safely on detach. Record
those choices in the implementation plan, then implement from that plan.
