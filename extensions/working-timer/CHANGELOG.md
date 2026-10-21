# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-21

Initial release: live elapsed time appended to pi's working indicator
(`Working · 1m 04s`), one second tick, no configuration, no runtime
dependencies.

- One clock per agent run, from the submitted prompt (`input`) to
  `agent_settled`, so tool rounds, automatic retries, compaction retries and
  queued continuations all count into a single total; a run started without a
  prompt event falls back to `agent_start`.
- Steer/follow-up submissions during a run keep the existing start instead of
  restarting the clock; repeated `agent_start` events never double-schedule the
  ticker.
- The working message is cleared at the end of the run (and on session
  shutdown) only if this extension set it — with no getter for pi's working
  message, setting it is documented as last-write-wins (see
  `docs/PRIOR-ART.md`).
- TUI-only by design: RPC/JSON/print modes accept `setWorkingMessage` as a no-op,
  so no ticker is started there.
