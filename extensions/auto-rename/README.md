# @tangentyh/pi-auto-rename

Automatically names your pi session — and the terminal multiplexer surface it
runs in — from the conversation, so you can tell at a glance what each pi is
doing.

This is a **fork** of [`@normful/pi-auto-name`](https://www.npmjs.com/package/@normful/pi-auto-name)
(v1.1.0) vendored into [`pi-collections`](../../README.md). The upstream sources
were copied verbatim (with `src/index.ts` renamed to `auto-rename.ts`); one
behavioral change is implemented and one is still planned:

- [`docs/PLAN-subagent-surfaces.md`](docs/PLAN-subagent-surfaces.md) —
  **implemented**: subagent/child sessions no longer rename the process-global
  terminal surfaces owned by the main session (see [Subagents](#subagents)).
- [`docs/PLAN-config-location.md`](docs/PLAN-config-location.md) — still
  **planned**: move configuration from `~/.config/pi-auto-name/config.json` to
  pi's own settings files.

Upstream documentation (config reference, naming styles, language support)
remains the authoritative reference for everything the config plan has not
changed yet.

## What it does

On the configured trigger it asks a model to derive two strings from the
conversation — a **session name** (shown in pi's session list / terminal title)
and a shorter **window name** — then applies them:

- the pi session name (unless `surfaces.renamePiSession` is off), and
- the window name to each enabled surface: tmux window, herdr pane, herdr tab,
  zellij pane, zellij tab.

A `session_start` sync also applies a window name derived from an existing
deliberate session name, so resuming a named session re-labels its surfaces.

## Subagents

Subagent child sessions run in `"print"` mode; by default only the session
attached to the terminal (`mode === "tui"`) writes to any surface. Two
**independent** gates let a non-TUI session opt in per axis:

- `surfaces.renamePiSessionInNonTuiModes` — allow a non-TUI session to set its
**own** pi session name. Safe for subagents: the name is scoped to the session,
so a child can name itself without touching the parent.
- `surfaces.renameMultiplexersInNonTuiModes` — allow a non-TUI session to write
the process-global tmux window, herdr pane/tab, and zellij pane/tab names. This
is the deliberate RPC/print-inside-a-multiplexer case; the surfaces are shared
with the parent process, so a child with this on **will** relabel the parent's
pane. Leave it `false` unless you accept that.

Both default to `false`, so a subagent child under the defaults neither names
itself nor touches any surface. Enabling only the session-name gate is the safe
way to give subagent children meaningful names. The `"print"`-mode label is a
heuristic — pi exposes no parent/child marker to extensions — so the multiplexer
gate cannot distinguish a subagent child from a top-level headless run.

This is the fork's fix for the upstream behavior described in
[`docs/PLAN-subagent-surfaces.md`](docs/PLAN-subagent-surfaces.md).

## Configuration

Config is read from two JSON files that are deep-merged (project wins per field):

- **Global:** `~/.config/pi-auto-name/config.json` (respects `XDG_CONFIG_HOME`)
- **Project:** `<cwd>/.pi/pi-auto-name.json`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch |
| `namingModel` | string | `""` | `provider/modelId` override for the naming call; empty = the session's current model |
| `namingStyle` | `"natural" \| "slug" \| "topic-project"` | `"natural"` | Name style |
| `namingContextDepth` | `"first-user-message" \| "recent-user-messages" \| "full-conversation"` | `"recent-user-messages"` | How much conversation is sent to the naming model |
| `initialRenameTrigger` | `"first-input" \| "first-agent-settled"` | `"first-input"` | When the first rename fires |
| `reRenameEveryNTurns` | integer | `0` | Re-rename every N settled user turns (0 = never) |
| `replaceExistingName` | `"always" \| "never"` | `"always"` | Whether an existing name may be overwritten |
| `respectExternalRenames` | boolean | `true` | Latch off after a manual/`/name` rename |
| `skipSessionNameDedup` | boolean | `false` | Skip sibling-session name de-duplication |
| `language` | string | `"en"` | BCP-47 output language tag |
| `windowNameMaxLength` | integer | unset | Override the window-name length budget |
| `sessionNameMaxLength` | integer | unset | Override the session-name length budget |
| `surfaces.renamePiSession` | boolean | `true` | Rename the pi session |
| `surfaces.renameHerdrPane` | boolean | `true` | Rename the herdr pane |
| `surfaces.renameHerdrTab` | boolean | `true` | Rename the herdr tab |
| `surfaces.renameTmuxWindow` | boolean | `true` | Rename the tmux window |
| `surfaces.renameZellijPane` | boolean | `true` | Rename the zellij pane |
| `surfaces.renameZellijTab` | boolean | `true` | Rename the zellij tab |
| `surfaces.renamePiSessionInNonTuiModes` | boolean | `false` | Allow non-TUI sessions (print/RPC/JSON — e.g. subagent child sessions) to rename **their own** pi session name. Scoped to the session, so safe to enable for subagents. |
| `surfaces.renameMultiplexersInNonTuiModes` | boolean | `false` | Allow non-TUI sessions to rename the process-global tmux window, herdr pane/tab, and zellij pane/tab. A subagent child with this on relabels the parent's pane — leave `false` unless you drive pi through RPC/print inside a multiplexer and want it named. |

Set `PI_AUTO_NAME_DEBUG=1` to append a structured debug trail to the session
transcript.

## Development

```bash
npm install                 # from the repo root — installs the workspace
npm run typecheck           # tsc --noEmit across extensions
npm run start:auto-rename   # pi -e ./extensions/auto-rename/auto-rename.ts
```

## Security

> Extensions run with your full system permissions and can execute arbitrary
> code. Only install from sources you trust.
