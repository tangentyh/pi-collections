# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
