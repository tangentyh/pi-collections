# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-23

Initial release: pins your last user message as a one-line bar at the top of
pi's fullscreen TUI; left-clicking the bar scrolls the transcript to that
message (landing just below the bar, with follow-tail disabled). The bar
seeds from the session tail after `/reload`; all other mouse behavior is
untouched.
