# extensions/

Each subdirectory is a **distributable pi package**: it has its own
`package.json` with a `pi` manifest (`keywords: ["pi-package"]`), so it can
be shared via npm or git and installed with `pi install`.

| Package | What it does |
|---------|--------------|
| `focus-aware-blinking-cursor-and-border/` | Blinking cursor when focused; border dims when the terminal loses focus |
| `scroll-speed/` | Lines per mouse-wheel notch in fullscreen mode |

## Install a single extension as a package

```bash
pi install ./extensions/scroll-speed                        # from this repo
pi install npm:pi-extension-scroll-speed                    # if published
```

Or add it to `"packages"` in `~/.pi/agent/settings.json`. The repo root's
`pi` manifest also bundles every extension here into one package
(`pi install .` or `pi install git:github.com/<you>/pi-collections`), while
each subdirectory stays independently installable.

> pi's git sources clone a whole repository — there is no
> `git:.../pi-collections/extensions/scroll-speed` form. For a single
> extension over git, clone the repo and `pi install` its subdirectory
> locally, or publish the package to npm.

See the
[pi packages docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md)
and [extensions docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md).

## Development workflow

Install the extension(s) you're working on with `pi install` from the
repo root. A local path is added to `~/.pi/agent/settings.json` without
copying, so edits to `extensions/<name>/<name>.ts` take effect in a running
pi with `/reload`:

```bash
pi install ./extensions/scroll-speed
pi install ./extensions/focus-aware-blinking-cursor-and-border
```

Running pi in fullscreen (alt-screen) mode is required by both extensions.

```bash
npm install       # root: installs devDeps for all packages (npm workspaces)
npm run typecheck
```

> Extensions run with your full system permissions and can execute arbitrary
> code. Only install from sources you trust.
