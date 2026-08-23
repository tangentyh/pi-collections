# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
