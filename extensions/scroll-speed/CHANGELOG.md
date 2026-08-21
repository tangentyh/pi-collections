# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-20

Initial release: configurable lines scrolled per mouse-wheel notch in pi
fullscreen mode (defaults to 5). Set via the `scrollSpeed.wheelLines`
setting (global or trusted-project), the `--wheel-lines` CLI flag, or the
`DEFAULT_WHEEL_LINES` constant in `scroll-speed.ts`; regular (non-fullscreen)
mode is intentionally untouched.
