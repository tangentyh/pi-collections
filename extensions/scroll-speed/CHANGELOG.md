# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-31

### Added

- `/scroll-speed` command: with no arguments it shows the active value and
  where it came from; `/scroll-speed <N>` sets a session-only override that
  survives session switches; `/scroll-speed off` restores pi's built-in
  wheel scrolling; `/scroll-speed reset` reverts to the configured value
  (a disabled configuration counts as disabled). Any `/scroll-speed <N>`
  re-enables after `off`. Argument completion offers common values plus
  `off` and `reset`.
- Disabling at startup: `scrollSpeed.enabled: false` in project or global
  settings, or `pi --wheel-lines off`.

### Changed

- Runtime changes via `/scroll-speed` now apply immediately — the editor
  factory captures the live alt-screen TUI, and pi's original
  `wheelScrollLines` is remembered per TUI instance so `off` restores it
  exactly (previously every change required a restart).

## [0.1.1] - 2026-08-25

### Added

- `CHANGELOG.md` now ships in the published tarball

### Changed

- Enriched the npm keywords to mirror the extension's feature set for better
  search discoverability; no functional changes

## [0.1.0] - 2026-08-20

Initial release: configurable lines scrolled per mouse-wheel notch in pi
fullscreen mode (defaults to 5). Set via the `scrollSpeed.wheelLines`
setting (global or trusted-project), the `--wheel-lines` CLI flag, or the
`DEFAULT_WHEEL_LINES` constant in `scroll-speed.ts`; regular (non-fullscreen)
mode is intentionally untouched.
