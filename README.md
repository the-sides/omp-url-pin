# omp-url-pin

Every session leaks URLs — a Vite banner, a `curl` you ran, a preview link the agent printed. With several worktrees running their own web app, remembering which session owns port 5173 and which owns 4300 is the annoying part.

`url-pin` counts the http(s) URLs a session mentions, ranks them by origin, and binds the winner to a key:

- **Cmd+B** (`super+b`) or **Ctrl+B** — open the busiest URL of this session in the external browser.
- Footer chip — `⌘B localhost:5173 ×7` shows what that key will open right now, or `📌 localhost:4300` when pinned.
- `/urls` — picker of every URL seen, ranked, `Enter` opens the selection.
- `/urls pin [n|url]` / `/urls unpin` — force a target regardless of frequency; the pin is stored in the session, so it survives resume, branch, and reload.
- `/urls clear` — drop the ranking and start counting again.

## Install

```sh
omp plugin link ~/repos/omp-url-pin
```

Restart omp (or `/reload`). No build step, no dependencies.

## How the ranking works

Counting reads the **session branch**, deduplicated by entry id — not the live event stream. That is deliberate: output from a `!bash` command you ran yourself is appended to the session but emits no `tool_result`, so an event-only extension would miss the dev server you started by hand. Re-reading the branch is idempotent, so nothing is double counted.

Sources counted: your prompts, assistant text, agent tool output, `!bash` output, `$python` output.

Sources skipped: tool results that carry file content (`read`, `grep`, `glob`, `edit`, `write`, `apply_patch`, `ast_edit`, `lsp`, `todo`, `memory_edit`, `learn`). A URL sitting in a source file should never outrank a server you actually started.

Ties are ranked per **origin**, not per URL: `http://localhost:5173/` and `http://localhost:5173/health` reinforce the same port rather than splitting its score, and the busiest origin's own most-seen URL is the one that opens. A pin always wins.

## Terminal note

`Cmd+B` reaches a TUI only if your terminal forwards it (the kitty keyboard protocol reports it as `super+b`; WezTerm and Kitty do this for unbound combos). `Ctrl+B` is registered as well and works everywhere. In WezTerm you can force the passthrough:

```lua
config.keys = {
  { key = "b", mods = "CMD", action = wezterm.action.SendString("\x02") },
}
```

## Test

```sh
bun test
```

Covers ranking, origin grouping, the file-content exclusion, `!bash` ingestion, punctuation trimming, pin persistence through a branch replay, and the empty-session path.
