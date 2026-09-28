# @tangentyh/pi-auto-rename

Automatically names your pi session — and the terminal multiplexer surface it
runs in — from the conversation, so you can tell at a glance what each pi is
doing.

This is a **fork** of [`@normful/pi-auto-name`](https://www.npmjs.com/package/@normful/pi-auto-name)
(v1.1.0) vendored into [`pi-collections`](../../README.md). The upstream sources
were copied verbatim (with `src/index.ts` renamed to `auto-rename.ts`); two
behavioral changes are implemented:

- [`docs/PLAN-subagent-surfaces.md`](docs/PLAN-subagent-surfaces.md) —
  **implemented**: subagent/child sessions no longer rename the process-global
  terminal surfaces owned by the main session (see [Subagents](#subagents)).
- [`docs/PLAN-config-location.md`](docs/PLAN-config-location.md) —
  **implemented**: configuration now lives under the `autoRename` key of pi's
  own settings files — `~/.pi/agent/settings.json` (global) and
  `.pi/settings.json` (project, trusted projects only). The pre-fork
  `~/.config/pi-auto-name/config.json` and `.pi/pi-auto-name.json` files are
  **not** read.

Upstream documentation (naming styles, language support, prompt behavior)
remains the authoritative reference for how names are generated; the
configuration location and key are this fork's.

## What it does

On the configured trigger it asks a model to derive two strings from the
conversation — a **session name** (shown in pi's session list / terminal title)
and a shorter **window name** — then applies them:

- the pi session name (unless `autoRename.surfaces.renamePiSession` is off), and
- the window name to each enabled surface: tmux window, herdr pane, herdr tab,
  zellij pane, zellij tab.

A `session_start` sync also applies a window name derived from an existing
deliberate session name, so resuming a named session re-labels its surfaces.

## Subagents

Subagent child sessions run in `"print"` mode; by default only the session
attached to the terminal (`mode === "tui"`) writes to any surface. Two
**independent** gates let a non-TUI session opt in per axis:

- `autoRename.surfaces.renamePiSessionInNonTuiModes` — allow a non-TUI session
to set its **own** pi session name. Safe for subagents: the name is scoped to
the session, so a child can name itself without touching the parent.
- `autoRename.surfaces.renameMultiplexersInNonTuiModes` — allow a non-TUI
session to write the process-global tmux window, herdr pane/tab, and zellij
pane/tab names. This is the deliberate RPC/print-inside-a-multiplexer case; the
surfaces are shared with the parent process, so a child with this on **will**
relabel the parent's pane. Leave it `false` unless you accept that.

Both default to `false`, so a subagent child under the defaults neither names
itself nor touches any surface. Enabling only the session-name gate is the safe
way to give subagent children meaningful names. The `"print"`-mode label is a
heuristic — pi exposes no parent/child marker to extensions — so the multiplexer
gate cannot distinguish a subagent child from a top-level headless run.

This is the fork's fix for the upstream behavior described in
[`docs/PLAN-subagent-surfaces.md`](docs/PLAN-subagent-surfaces.md).

## Configuration

Config is read from the `autoRename` key of pi's own settings files:

```jsonc
// ~/.pi/agent/settings.json  (global)
{
  "autoRename": {
    "namingModel": "openrouter/openrouter/free",
    "surfaces": { "renameTmuxWindow": true },
    "language": "en"
  }
}

// <project>/.pi/settings.json  (project, overrides global per field; trusted projects only)
{
  "autoRename": { "namingStyle": "slug" }
}
```

The merge semantics match pi's own settings merge: the project value overrides
the global one, plain objects merge recursively, and any other value (including
an empty string) replaces the global value wholesale. Project settings are
honored only in trusted projects (`ctx.isProjectTrusted()`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `autoRename.enabled` | boolean | `true` | Master switch |
| `autoRename.namingModel` | string | `""` | `provider/modelId` override for the naming call; empty = the session's current model |
| `autoRename.namingStyle` | `"natural" \| "slug" \| "topic-project"` | `"natural"` | Name style |
| `autoRename.namingContextDepth` | `"first-user-message" \| "recent-user-messages" \| "full-conversation"` | `"recent-user-messages"` | How much conversation is sent to the naming model |
| `autoRename.initialRenameTrigger` | `"first-input" \| "first-agent-settled"` | `"first-input"` | When the first rename fires |
| `autoRename.reRenameEveryNTurns` | integer | `0` | Re-rename every N settled user turns (0 = never) |
| `autoRename.replaceExistingName` | `"always" \| "never"` | `"always"` | Whether an existing name may be overwritten |
| `autoRename.respectExternalRenames` | boolean | `true` | Latch off after a manual/`/name` rename |
| `autoRename.skipSessionNameDedup` | boolean | `false` | Skip sibling-session name de-duplication |
| `autoRename.language` | string | `"en"` | BCP-47 output language tag |
| `autoRename.windowNameMaxLength` | integer | unset | Override the window-name length budget |
| `autoRename.sessionNameMaxLength` | integer | unset | Override the session-name length budget |
| `autoRename.surfaces.renamePiSession` | boolean | `true` | Rename the pi session |
| `autoRename.surfaces.renameHerdrPane` | boolean | `true` | Rename the herdr pane |
| `autoRename.surfaces.renameHerdrTab` | boolean | `true` | Rename the herdr tab |
| `autoRename.surfaces.renameTmuxWindow` | boolean | `true` | Rename the tmux window |
| `autoRename.surfaces.renameZellijPane` | boolean | `true` | Rename the zellij pane |
| `autoRename.surfaces.renameZellijTab` | boolean | `true` | Rename the zellij tab |
| `autoRename.surfaces.renamePiSessionInNonTuiModes` | boolean | `false` | Allow non-TUI sessions (print/RPC/JSON — e.g. subagent child sessions) to rename **their own** pi session name. Scoped to the session, so safe to enable for subagents. |
| `autoRename.surfaces.renameMultiplexersInNonTuiModes` | boolean | `false` | Allow non-TUI sessions to rename the process-global tmux window, herdr pane/tab, and zellij pane/tab. A subagent child with this on relabels the parent's pane — leave `false` unless you drive pi through RPC/print inside a multiplexer and want it named. |

### Legacy config files

The pre-fork files — `~/.config/pi-auto-name/config.json` (honors
`XDG_CONFIG_HOME`) and `<cwd>/.pi/pi-auto-name.json` — are **no longer read**.
Move any values there into the `autoRename` key of pi's settings files (see
above); nothing is migrated automatically.

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
