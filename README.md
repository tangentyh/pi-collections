# pi-collections

A **pi extension monorepo** for development: an [npm workspace](https://docs.npmjs.com/cli/v10/using-npm/workspaces) where each extension in `extensions/` is its own **distributable pi package** — own `package.json` with a `pi` manifest and the `pi-package` keyword. The repo root is itself a distributable package that bundles every extension (`pi install .`), and each subdirectory stays independently installable:

```bash
pi install ./extensions/scroll-speed                        # local
pi install git:github.com/tangentyh/pi-collections              # whole repo: root manifest loads every extension
pi install npm:pi-extension-scroll-speed                    # one extension, if published
```

> pi's git sources clone a whole repository, so there is no
> `git:.../pi-collections/extensions/scroll-speed` form. To install a single
> extension from the repo, use a local path or publish it to npm (see
> [extensions/README.md](extensions/README.md)).

| Package | Description |
|---------|-------------|
| `focus-aware-blinking-cursor-and-border/` | Blinking cursor when focused; border dims when the terminal loses focus |
| `scroll-speed/` | Lines per mouse-wheel notch in fullscreen mode |

## Development

The repo is an npm workspace: one `npm install` at the root installs
hoisted devDependencies for all packages, and `npm run typecheck` checks
everything.

For a dev loop, install a local path — `pi install` records it in
`~/.pi/agent/settings.json` without copying, so edits to
`extensions/<name>/<name>.ts` take effect in a running pi with `/reload`.

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
