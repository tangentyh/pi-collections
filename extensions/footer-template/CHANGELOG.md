# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-01

### Added

- `zai-api-cn` balance provider: the pay-as-you-go bigmodel.cn API — usually
  added as a custom provider in `~/.pi/agent/models.json` — joins the built-in
  coding-plan provider (`zai-coding-cn`) on the same console account-report
  endpoint, sharing the `BigModel` label and CNY parsing (same account, same
  wallet); auto currency resolves to CNY for it, and the `/set-currency` help
  lists it

## [0.4.0] - 2026-08-27

### Added

- Z.AI (`zai`) balance provider via the console account-report endpoint, with
  USD auto-currency for the international host

### Changed

- BigModel balance restored through bigmodel.cn's undocumented console
  account-report endpoint (provider `zai-coding-cn`, label `BigModel`, CNY
  auto-currency), replacing the dark `zhipu` entry: the PaaS monetary-balance
  endpoint (`account/billing`) was retired and answers 404 for every key
- Account-report endpoints answer HTTP 200 with application-level failures in
  their JSON envelope: codes 1001/401 render as the familiar `http401` error,
  anything else as `api{code}`

## [0.3.2] - 2026-08-25

### Changed

- Enriched the npm keywords to mirror the extension's feature set for better
  search discoverability; no functional changes

## [0.3.1] - 2026-08-21

### Fixed

- `{cost}` renders `0` when nothing was spent instead of going empty,
  matching the other numeric fields such as `{contextTokens}`
- Default footer template: the cumulative total-token count sits in its own
  optional section before cost (`[ Σ{totalTokens}][ {cost} {subscription}]`),
  matching the documented layout and omitting the field when empty
- `{totalTokens}` and `{contextTokens}` optional sections are omitted when
  their values are zero; unknown context usage still renders as empty

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
