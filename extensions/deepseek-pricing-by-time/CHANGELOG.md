# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-11

### Added

- DeepSeek-V4.1-Flash support: the canonical `deepseek-flash` id is priced at
  the new published rates (peak $0.30 input / $1.20 output / $0.006 cache hit
  per M; off-peak exactly half), and the retired `deepseek-v4-flash` /
  `deepseek-v4-flash-vision-exp` ids — temporarily routed to it by DeepSeek —
  are billed at the same Flash rates
- Effective-dated rate schedules: each model now maps to ordered periods with
  an inclusive `from` instant, so a price change or retirement is expressed as
  a new period. `deepseek-v4-pro` uses one for its 2026-09-14 04:00 UTC
  retirement, from which it follows Flash rates until V4.1 Pro ships
- `/deepseek-tier` reports the rates in effect for the active model and the
  routing note for a retired or legacy id

### Fixed

- Re-pricing no longer silently no-ops on ids pi's catalog does not know: a
  message is resolved by its echoed `responseModel` first and falls back to
  `model`, so a `deepseek-v4-flash` request that DeepSeek echoes as
  `deepseek-flash` is priced at Flash rates instead of being left at pi's
  stale static cost
- A missing or `NaN` message timestamp falls back to the current time instead
  of reading as off-peak and halving the charge
- Unknown ids that collide with `Object.prototype` members (`constructor`,
  `__proto__`, …) no longer throw during the schedule lookup

### Changed

- The peak-window and rate tables were reworked around the schedules above and
  the source comments condensed; formatting is now handled by the repo-wide
  Biome setup, and the extension typechecks and tests against pi 0.85.1

## [0.2.2] - 2026-08-25

### Added

- `CHANGELOG.md` now ships in the published tarball

### Changed

- Enriched the npm keywords to mirror the extension's feature set for better
  search discoverability; no functional changes

## [0.2.1] - 2026-08-23

### Fixed

- Weekend messages are no longer priced at peak rates: DeepSeek applies the
  peak windows (01:00–04:00 & 06:00–10:00 UTC) only Monday–Friday, so
  `tierAt()` now returns off-peak on Sat/Sun regardless of hour. Published
  rates themselves are unchanged.

## [0.2.0] - 2026-08-22

### Added

- `deepseek-v4-flash-vision-exp` support: added to the peak/off-peak rate
  table at the official rates (identical to `deepseek-v4-flash`; images are
  billed as input tokens), and documented in the README rate table and
  compatibility list

### Fixed

- The direct `@earendil-works/pi-ai` import is now declared as a
  devDependency instead of relying on npm hoisting it to the workspace root
  for typechecking

## [0.1.0] - 2026-08-21

Initial release: time-of-day-aware DeepSeek cost accounting. Every DeepSeek
assistant message is re-priced at `message_end` with the official peak/off-peak
rates in effect at the message's own UTC timestamp, so session totals, the
footer, the statusline cost segment, and exports match what DeepSeek bills.
Includes the `/deepseek-tier` command to show the currently active tier, and a
configurable footer tier status indicator (`peak ⚠️` / `off-peak`, on by
default, disableable via the `deepseekPricingByTime` setting).
