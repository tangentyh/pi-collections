# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-21

### Added

- `{balanceDelta}` field: signed balance change since the first successful
  fetch of the session, rendered next to the balance in the default footer
  (`Δ-¥2.15` while spending, `+¥10.00` after a top-up)
- Structured quota fields (`{quota5hUsed}`, `{quota5hRemaining}`,
  `{quota5hReset}`, `{quota7dUsed}`, `{quota7dRemaining}`, `{quota7dReset}`,
  `{creditsRemaining}`); the default footer renders the quota-window
  breakdown — with reset countdowns — from them for the OAuth quota
  providers
- `{:right}` line-split marker for right-aligned fields (the bare `:right`
  form stays accepted, deprecated)
- Per-provider auto currency: `auto` now uses CNY for the extension's
  Chinese providers (`deepseek`, `moonshotai-cn`, `siliconflow`, `zhipu`)
  and USD otherwise
- Compact `{h}h{m}m{s}s` elapsed-time format for `{elapsedTime}`/
  `{idleTime}` (`2h5m3s`; sub-minute runs show `12.3s`)

### Changed

- Default templates aligned: absolute context usage renders as
  `={contextTokens}`, and the run notification uses the same `↑↓RW` markers
  as the footer token stats
- Default run notification no longer puts a comma before `Σ{totalTokens}`
- Extension state/cache persistence aligned with pi's config/cache
  conventions (agent dir via `getAgentDir()`, honors `PI_CODING_AGENT_DIR`)

### Fixed

- Stale context access after a session replacement or reload
- Footer field values carry no decorations — separators live in the
  templates

## [0.2.0] - 2026-08-20

### Added

- Account balance display for DeepSeek, Moonshot, OpenRouter, SiliconFlow, and Zhipu, mirroring pi-tidy-footer
- Provider quota status for Codex/Claude OAuth subscriptions
- Multi-currency cost display
- Cumulative total-token counts in the default footer template

### Changed

- Use the sigma sign (∑) for total-token counts in the default templates

### Other

- Prior-art notes moved under `docs/`

## [0.1.0] - 2026-08-19

Initial release: configurable footer template, per-run notification template,
right-aligned fields, cost/throughput stats, and absolute context-token usage.
