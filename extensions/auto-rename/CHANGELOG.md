# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-26

### Added

- `autoRename.showNamingGreeting` (default `true`) appends one dim startup
  transcript line naming the model the next naming call will actually use —
  marked `(override)` when `autoRename.namingModel` supplied it instead of the
  session model — and the configured `namingThinking` verbatim. `effort: off`
  renders as `off` rather than as "no reasoning": it means no explicit level is
  sent, and some OpenAI reasoning models still reason at their own default. The
  line is a custom session entry, so it is never sent to the model and costs no
  context; it is written once per session (a resumed session that already
  carries one stays untouched) and is deliberately not refreshed by
  `/auto-rename model`, which remains authoritative.
- `autoRename.showNamingCost` (default `true`) publishes the session's
  cumulative naming cost in the keyed footer slot `auto-rename`, visible in
  pi's built-in footer and in footer-template's `{extensionStatuses}`. The
  figure uses four decimals with a `<$0.0001` floor, because a single naming
  call lands far below pi's 3-decimal session-cost precision and `$0.000` would
  read as free. Nothing appears until a cost is actually incurred; a call that
  cost `0` — a subscription-covered or unpriced model — shows no figure even
  though tokens were spent.
- Spend is accumulated from pi-ai's own `usage.cost.total` (raw USD) and
  persisted as one small `pi-auto-name:usage` session entry per billed naming
  run, so it survives `/reload` and resume and is re-published to the footer at
  session start. pi's own session cost total still excludes this spend — an
  extension cannot append usage entries — so the footer cost, `/session` stats
  and HTML exports under-report by exactly the amount the new status shows.

### Changed

- Both display switches are gated on `ctx.mode === "tui"`: a headless or
  subagent session neither writes display entries into its session file nor
  claims a footer slot it cannot show.
- The extension now needs pi-ai ≥ 1.4 at runtime, where `completeOnce` builds
  its request context with pi-ai's `normalizeContext()`; `peerDependencies`
  stay `"*"`.

## [0.2.1] - 2026-10-01

### Fixed

- `typebox` is declared in `peerDependencies` (`"*"`) instead of
  `dependencies`: pi supplies `typebox` to extensions, and a second physical
  copy can bypass pi's extension module mapping in compiled ESM —
  duplicating classes and registries — and makes pi warn about a
  host-provided package listed as a dependency

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
