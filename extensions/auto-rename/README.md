# @tangentyh/pi-auto-rename

Automatically names your pi session — and the terminal multiplexer surface it
runs in — from the conversation, so you can tell at a glance what each pi is
doing.

This is a **fork** of [`@normful/pi-auto-name`](https://www.npmjs.com/package/@normful/pi-auto-name)
(v1.1.0) vendored into [`pi-collections`](../../README.md). The upstream sources
were copied verbatim (with `src/index.ts` renamed to `auto-rename.ts`); two
behavioral changes are planned but **not yet implemented**:

- [`docs/PLAN-subagent-surfaces.md`](docs/PLAN-subagent-surfaces.md) — stop
  subagent/child sessions from renaming the process-global terminal surfaces
  owned by the main session.
- [`docs/PLAN-config-location.md`](docs/PLAN-config-location.md) — move
  configuration from `~/.config/pi-auto-name/config.json` to pi's own settings
  files.

Upstream documentation (config reference, naming styles, language support) is
the authoritative behavioral reference until the plans land.

## What it does

On the configured trigger it asks a model to derive two strings from the
conversation — a **session name** (shown in pi's session list / terminal title)
and a shorter **window name** — then applies them:

- the pi session name (unless `surfaces.renamePiSession` is off), and
- the window name to each enabled surface: tmux window, herdr pane, herdr tab,
  zellij pane, zellij tab.

A `session_start` sync also applies a window name derived from an existing
deliberate session name, so resuming a named session re-labels its surfaces.

## Configuration (current — inherited from upstream)

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
