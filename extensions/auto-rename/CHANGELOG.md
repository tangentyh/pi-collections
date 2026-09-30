# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-28

### Added

- Configuration is now read from the `autoRename` key of pi's own settings
  files — `~/.pi/agent/settings.json` (global) and `.pi/settings.json`
  (project, trusted projects only) — and merged with pi's own semantics: the
  project value overrides the global one, plain objects merge recursively, and
  any other value replaces the global one wholesale.
- `autoRename.namingThinking` selects the thinking/reasoning effort for the
  naming call — `"off"` (default; upstream's implicit behavior) or one of
  `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, forwarded as pi-ai's
  provider-neutral `reasoning` on the `*Simple` stream path.
- `/auto-rename model` slash command to read or persist
  `autoRename.namingModel` from the TUI instead of hand-editing
  `settings.json`: it completes model ids from the current session, validates
  the value against the model registry before writing, and preserves every
  other global setting.
- Per-axis opt-in gates for non-TUI sessions:
  `autoRename.surfaces.renamePiSessionInNonTuiModes` (renames the session's
  own pi session name; safe for subagents) and
  `autoRename.surfaces.renameMultiplexersInNonTuiModes` (writes the
  process-global tmux window, herdr pane/tab, and zellij pane/tab names).
  Both default to `false`.

### Changed

- Subagent/child sessions running in non-TUI modes no longer rename the
  process-global terminal surfaces by default; only the session attached to
  the terminal (`mode === "tui"`) writes to any surface unless the matching
  gate above is enabled.

### Removed

- The legacy pre-fork config files (`~/.config/pi-auto-name/config.json` and
  `.pi/pi-auto-name.json`) are no longer read. Values must be moved into the
  `autoRename` key of pi's settings files; nothing is migrated automatically.

## [0.1.0] - 2026-09-27

### Added

- Initial fork of [`@normful/pi-auto-name`](https://www.npmjs.com/package/@normful/pi-auto-name)
  1.1.0 into `pi-collections`: auto-generates a pi session name and a compact
  window name from the conversation, then applies the window name to the tmux
  window, herdr pane/tab, and zellij pane/tab the process runs in.
- Flattened upstream `src/*.ts` into the extension root with `auto-rename.ts`
  as the semantic entry file, per this repo's layout conventions.
- Two design plans under `docs/`:
  - `PLAN-subagent-surfaces.md` — stop child/subagent sessions from renaming
    the process-global terminal surfaces owned by the main session.
  - `PLAN-config-location.md` — move configuration from
    `~/.config/pi-auto-name/config.json` to pi's own settings files.

### Notes

- Code is a verbatim copy of the upstream 1.1.0 sources at this point; neither
  plan above has been implemented yet. Upstream license and copyright are
  preserved — see `LICENSE`.
