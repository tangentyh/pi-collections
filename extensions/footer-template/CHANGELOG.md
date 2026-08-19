# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
