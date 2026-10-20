# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-10-20

### Fixed

- Blinking works again on pi-tui ≥ 1.2.0, which encodes the editor's cursor
  cell with zero-width `\x1b_pi:fc\x07` markers instead of reverse video and
  resolves them to reverse video only after extension render hooks run. The
  extension only knew the SGR form, so the cursor neither blinked nor hid
  itself when the editor or the terminal window lost focus, while the 2 Hz
  timer kept requesting renders for no visible effect. Both encodings are now
  stripped together with the hardware-cursor marker
- With pi's `showHardwareCursor` setting on (and a pi-tui that resolves its own
  fake cursor cell), the cursor cell is left untouched: pi-tui drops its own
  cell so the terminal blinks natively, and stripping the marker made
  `resolveFakeCursors` paint a static reverse-video block instead. The
  extension contributes the focus handling alone there — no cursor while the
  editor or the window is unfocused, plus the dimmed border — and skips the
  blink re-renders, which can no longer change anything
- The working/spinner indicator stays in the editor's top border, with its
  thinking-level tint, while a response is streaming: `BlinkingCursorEditor`
  now passes `embedWorkingStatus: true`, which pi's `isWorkingStatusEditor()`
  check requires and `setCustomEditorComponent` cannot carry over from the
  default editor. Without it the indicator dropped into pi's status container
  above the editor during every turn

### Added

- Headless test suite (`npm test -w pi-focus-aware-blinking-cursor`) running
  against the real installed editor classes

### Changed

- Targets pi 0.85.1 (`devDependencies`); no runtime change

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
