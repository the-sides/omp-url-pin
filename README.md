# omp-url-pin

Every session leaks URLs — a Vite banner, a `curl` you ran, a preview link the agent printed. With several worktrees running their own web app, remembering which session owns port 5173 and which owns 4300 is the annoying part.

`url-pin` counts the http(s) URLs a session mentions, ranks them by origin, and binds the winner to a key:

- **Cmd+B** (`super+b`) or **Ctrl+B** — open the busiest URL of this session in the external browser.
- Status chip — a globe followed by the port (`🌐 5173`), or a pin glyph when pinned. The marker is taken from the active `symbolPreset`, so it renders as a Nerd Font glyph, an emoji, or `:` under `ascii` — matching its neighbouring segments instead of hardcoding a font the terminal may lack.
- `/urls` — picker of every URL seen, ranked; `Enter` opens the selection.
- `/urls pin` — the same list, where `Enter` pins the selection instead of opening it. `/urls pin 3` and `/urls pin <url>` skip the picker; `/urls unpin` releases. A pin outranks frequency, is marked in both lists, and is stored in the session, so it survives resume, branch, and reload.
- `/urls clear` — drop the ranking and start counting again.

## Install

From npm:

```sh
omp plugin install omp-url-pin
```

Or from the marketplace catalog this repo ships:

```sh
omp plugin marketplace add the-sides/omp-url-pin
omp plugin install url-pin@url-pin
```

Or from a clone, for hacking on it:

```sh
omp plugin link /path/to/omp-url-pin
```

Restart omp (or `/reload`). No build step, no dependencies — the extension is a single TypeScript file the host loads directly.

## How the ranking works

Counting reads the **session branch**, deduplicated by entry id — not the live event stream. That is deliberate: output from a `!bash` command you ran yourself is appended to the session but emits no `tool_result`, so an event-only extension would miss the dev server you started by hand. Re-reading the branch is idempotent, so nothing is double counted.

Sources counted: your prompts, assistant text, agent tool output, `!bash` output, `$python` output.

Sources skipped: tool results that carry file content (`read`, `grep`, `glob`, `edit`, `write`, `apply_patch`, `ast_edit`, `lsp`, `todo`, `memory_edit`, `learn`). A URL sitting in a source file should never outrank a server you actually started.

Ties are ranked per **origin**, not per URL: `http://localhost:5173/` and `http://localhost:5173/health` reinforce the same port rather than splitting its score, and the busiest origin's own most-seen URL is the one that opens. A pin always wins.

## Putting the chip in the status line

omp renders extension statuses as their own row under the composer. To get the port as a powerline chip instead — same style as `cost`, immediately after it — put the `status` segment in the status line and turn the standalone row off. Only the `custom` preset honors explicit segment lists, so this is the `default` preset verbatim plus `status`:

```yaml
# ~/.omp/agent/config.yml
statusLine:
  preset: custom
  showHookStatus: false
  separator: powerline-thin
  leftSegments: [pi, model, mode, collab, path, git, pr, context_pct, cost, status]
  rightSegments: [session_name]
  segmentOptions:
    model: { showThinkingLevel: true }
    path: { abbreviate: true, maxLength: 40, stripWorkPrefix: true }
    git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true }
```

A `!bash` you run yourself has no completion event, so the chip re-syncs on a managed timer 0.5s and 3s after the command starts. The shortcut always re-syncs on press, so `⌘B` is never stale even if the chip is.

## Terminal note

`Cmd+B` only arrives if your terminal sends it. macOS terminals keep the Command modifier to themselves by default, so map it to the kitty-keyboard CSI-u encoding of `super+b` — codepoint 98 with the super bit (`1 + 8 = 9`):

```lua
-- ~/.config/wezterm/wezterm.lua
config.keys = {
  { key = "b", mods = "SUPER", action = wezterm.action.SendString("\x1b[98;9u") },
}
```

`SendKey` with `SUPER` is dropped, and rewriting it to `Ctrl+B` collides with tmux's common `C-b` prefix. The CSI-u form survives tmux when `extended-keys on` and `extended-keys-format csi-u` are set. `Ctrl+B` stays registered for terminals where that is free.

## Test

```sh
bun test
```

Covers ranking, origin grouping, the file-content exclusion, `!bash` ingestion, punctuation trimming, pin persistence through a branch replay, and the empty-session path.
