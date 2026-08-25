# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-25

### Changed

- Enriched the npm keywords to mirror the extension's feature set for better
  search discoverability; no functional changes

## [0.1.1] - 2026-08-21

### Fixed

- Blinking stays compatible with current pi-tui releases: both SGR 0 and SGR 27
  reset codes are recognized when stripping the fake reverse-video cursor
- Hide the terminal's own (non-blinking) hardware cursor on the "off" half of
  the blink when `showHardwareCursor` is enabled — pi-tui's zero-width cursor
  marker used to keep the cursor cell permanently visible

## [0.1.0] - 2026-08-17

Initial release: blinking cursor (~2 Hz) when focused, dimmed border when the
terminal loses focus, immediate reappearance on cursor movement or refocus, and
terminal-window focus detection via raw stdin in fullscreen TUI mode.
