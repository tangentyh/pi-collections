# pi-collections

A **development-only npm workspace** that collects [pi](https://github.com/earendil-works/pi) extensions. Each directory under `extensions/` is an independent, distributable pi package — its own `package.json` with a `pi` manifest and the `pi-package` keyword (published on npm as `pi-<name>`).

## What's here

| Package | Description |
|---------|-------------|
| [pi-focus-aware-blinking-cursor](extensions/focus-aware-blinking-cursor-and-border) | Blinking cursor when focused; border dims when the terminal loses focus |
| [pi-scroll-speed](extensions/scroll-speed) | Lines scrolled per mouse-wheel notch in pi fullscreen mode |

Each package has its own `README.md` and `LICENSE` (MIT) in its directory — click the name to explore.

## Requirements

- **pi** 0.84+ — the extensions target the pi version this workspace is developed against (see `devDependencies`); pi 0.84 ships with npm as `@earendil-works/pi-coding-agent`
- **Node.js 18+** — packages are ESM (`"type": "module"`)
- **npm 7+** — required for the `workspaces` feature used by this repo
- **TypeScript 5.5+** (dev only) — for `npm run typecheck`

## Installation

The repo's root declares no `pi` manifest, and pi's git sources install whatever a repository's root declares — so there is no `git:.../pi-collections/extensions/...` form. Pick the option that fits:

**Local path** — clone the repo and install the extension's directory. `pi install` records the path in `~/.pi/agent/settings.json` without copying, so edits take effect in a running pi with `/reload`:

```bash
git clone <this repo>
pi install ./extensions/scroll-speed
```

**npm** — publish an extension's own directory to npm, then install it by name:

```bash
cd extensions/scroll-speed
npm publish
pi install npm:pi-scroll-speed
```

**Single session** — skip installation and load one extension at startup:

```bash
pi -e ./extensions/scroll-speed/scroll-speed.ts
```

To load an extension into an already-running pi, `pi install` it first (or drop it into `~/.pi/agent/extensions/` or `.pi/extensions/`), then run `/reload` inside pi to hot-reload it without restarting. Files in the auto-discovered locations are re-read on every `/reload`, so edits apply immediately.

## Development

```bash
npm install            # once, installs the whole workspace
npm run typecheck      # typecheck all extensions from the root
npm run start:scroll-speed   # launch pi with one extension loaded
                         # (same as `pi -e ./extensions/<name>/<name>.ts`)
```

## Security

> Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.
