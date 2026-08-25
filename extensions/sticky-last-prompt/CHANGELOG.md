# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
