# omp-url-pin

Every session leaks URLs — a Vite banner, a `curl` you ran, a preview link the agent printed. With several worktrees running their own web app, remembering which session owns port 5173 and which owns 4300 is the annoying part.

`url-pin` counts the http(s) URLs and schemeless `host:port` addresses a session mentions, ranks them by origin, and binds the winner to a key:

- **Cmd+B** (`super+b`) — open the busiest URL available for the current branch. `Ctrl+B` is intentionally not registered because it collides with tmux and herdr commands.
- Status chip — a globe followed by the port (`🌐 5173`), or a pin glyph when pinned. The marker is taken from the active `symbolPreset`, so it renders as a Nerd Font glyph, an emoji, or `:` under `ascii` — matching its neighbouring segments instead of hardcoding a font the terminal may not have.
- `/urls` — picker of URLs seen in the session or recovered for the current branch. `Enter` opens the highlighted URL; `→` pins it without opening the browser.
- `/urls pin` — the same list, where `Enter` pins the selection instead of opening it. A numeric operand always starts a localhost port: `/urls pin 5142` pins `http://localhost:5142`, and `/urls pin 2351/sign-in` pins `http://localhost:2351/sign-in`. An absolute URL selects directly. `/urls pin /fleet/pm` takes the leading ranked URL's scheme, hostname, and port, replaces its path with `/fleet/pm`, and pins the result. `/urls unpin` releases. A pin outranks frequency, is marked in both lists, and survives resume, branch, reload, and a newly started session on the same repository branch.
- `/urls clear` — drop the ranking, pin, and saved record for the current branch.

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

Schemeless addresses with an explicit port are normalized to HTTP: `localhost:3400`, `127.0.0.1:3400/app`, and `preview.example.com:8080` become `http://...` URLs. This applies both to discovered text and direct pins. A leading port is shorthand for localhost, so `2351/sign-in` becomes `http://localhost:2351/sign-in`.

Sources skipped: tool results that carry file content (`read`, `grep`, `glob`, `edit`, `write`, `apply_patch`, `ast_edit`, `lsp`, `todo`, `memory_edit`, `learn`). A URL sitting in a source file should never outrank a server you actually started.

Ties are ranked per **origin**, not per URL: `http://localhost:5173/` and `http://localhost:5173/health` reinforce the same port rather than splitting its score, and the busiest origin's own most-seen URL is the one that opens. A pin always wins.

## Persistence

A URL becomes branch state only after `url-pin` successfully opens it or you explicitly pin it. Merely appearing in a session does not persist it.

State lives at `url-pin/state.json` under omp's active agent directory (normally `~/.omp/agent`, and profile-aware through omp's `getAgentDir()` API). Each record contains the repository's common Git directory, branch name, successful URLs, last-use times, and optional pin. Repository identity prevents equal branch names in unrelated projects from colliding; the common Git directory lets linked worktrees share the repository identity while branch names keep their URLs separate.

The file is atomically replaced under a cross-process lock because several omp sessions can update it at once. Storage is bounded to the 100 most recently updated branches and 20 URLs per branch. `/urls unpin` keeps the branch's proven URLs; `/urls clear` removes its complete saved record.

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

`SendKey` with `SUPER` is dropped, and rewriting it to `Ctrl+B` collides with tmux's common `C-b` prefix and herdr commands. The CSI-u form survives tmux when `extended-keys on` and `extended-keys-format csi-u` are set. `url-pin` registers only `super+b`.

## Test

```sh
bun test
```

Covers ranking, origin grouping, schemeless and port-first URL pinning, right-arrow menu pinning, the file-content exclusion, `!bash` ingestion, punctuation trimming, absolute and origin-relative pins, persistence through branch replay and new sessions, branch isolation, clearing, and the empty-session path.
