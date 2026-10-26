# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-10-26

### Fixed

- The bar no longer silently disappears in hosts that wrap the chat transcript
  in a `Container` subclass (Pi-Bolt's `TranscriptContainer`). Prompt discovery
  matched on `constructor.name === "Container"`, so a subclass was never
  recursed into and the user's message was never found. A container is now
  identified by `instanceof Container` plus the `render`/`renderShared` methods
  it keeps, and its `children` are read once per visit — under Pi-Bolt that
  getter marks the container dirty in its parent, defeating incremental line
  reuse. A subclass that overrides those methods to paint its own lines is
  measured as one opaque block instead of being recomputed from children that
  do not add up to them, so it still counts correctly in a sibling's offsets.

## [0.1.2] - 2026-10-01

### Fixed

- `@earendil-works/pi-tui` — imported for the component and overlay types —
  is declared in `peerDependencies` (`"*"`) now, matching pi's host-provided
  package contract; the manifest previously omitted it entirely

### Changed

- README's click-interception note now refers to pi 0.85.x, where the
  renderer's internal selection handler is still the only available seam

## [0.1.1] - 2026-08-25

### Added

- `CHANGELOG.md` now ships in the published tarball

## [0.1.0] - 2026-08-25

Initial release: pins your last user message as a one-line bar at the top of
pi's fullscreen TUI once it has scrolled completely above the viewport top;
left-clicking the bar scrolls the transcript to that message (landing just
below the bar, with follow-tail disabled). While a prompt is still crossing
the top edge the bar hides rather than duplicate text sitting directly
beneath it, and skill invocations are pinned too, under their
`[skill] name` label. After `/reload` or when opening an existing session,
the bar re-derives itself from the rendered transcript; all other mouse
behavior is untouched.
