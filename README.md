# pi-collections

A **development-only workspace** for pi extensions: an [npm workspace](https://docs.npmjs.com/cli/v10/using-npm/workspaces) where each extension in `extensions/` is its own **distributable pi package** — its own `package.json` with a `pi` manifest and the `pi-package` keyword.

The repo root is **only a wrapper for development**, not a pi package: never published (`"private": true` in the root `package.json`) and not installable via `pi install`. Its only job is the dev loop — see [AGENTS.md](AGENTS.md) for repo conventions, the `npm run start:<name>` scripts, and the local-path install flow.

To use an extension, install its directory locally or publish the extension's own directory to npm:

```bash
pi install ./extensions/scroll-speed       # local path
pi install npm:pi-scroll-speed             # one extension, if published
```

> pi's git sources clone a whole repository and install what its root
> `package.json` declares, so there is no
> `git:.../pi-collections/extensions/scroll-speed` form — and this repo's root
> declares no `pi` manifest. To install a single
> extension from the repo, clone it and use the local path, or publish the
> extension's directory to npm independently.

| Package | Description |
|---------|-------------|
| `focus-aware-blinking-cursor-and-border/` | Blinking cursor when focused; border dims when the terminal loses focus |
| `scroll-speed/` | Lines per mouse-wheel notch in fullscreen mode |

## Development

`npm run typecheck` checks all packages from the root.

For a dev loop, install a local path — `pi install` records it in
`~/.pi/agent/settings.json` without copying, so edits to
`extensions/<name>/<name>.ts` take effect in a running pi with `/reload`.
Or skip installation and launch pi with a single extension for the current
session: `npm run start:scroll-speed` / `npm run start:cursor` (same as
`pi -e ./extensions/...`).

## Loading an extension dynamically

Skip installation and load an extension for the current session only:

```bash
pi -e ./extensions/scroll-speed/scroll-speed.ts      # load once at startup
```

To load an extension into an already-running pi:

1. `pi install` the extension (or drop it into `~/.pi/agent/extensions/` or
   `.pi/extensions/`), then
2. run `/reload` in pi to hot-reload extensions without restarting.

```bash
pi install ./extensions/scroll-speed                  # persist in settings.json
# then, inside pi:
/reload                                              # hot-reload extensions
```

Extension code in the auto-discovered locations (`~/.pi/agent/extensions/`,
`.pi/extensions/`) is re-read on every `/reload`, so edited files take effect
immediately.

## Security

> Extensions run with your full system permissions and can execute arbitrary
> code. Only install from sources you trust.
