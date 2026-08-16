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
pi install git:github.com/<you>/pi-collections/extensions/scroll-speed
pi install npm:pi-extension-scroll-speed                    # if published
```

Or add it to `"packages"` in `~/.pi/agent/settings.json`. See the
[pi packages docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md)
and [extensions docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md).

## Development workflow

`../install.sh` symlinks this whole directory to `~/.pi/agent/extensions/`,
where pi auto-discovers each `*/index.ts` and hot-reloads it with `/reload`.
Running pi in fullscreen (alt-screen) mode is required by both extensions.

```bash
npm install       # root: installs devDeps for all packages (npm workspaces)
npm run typecheck
```

> Extensions run with your full system permissions and can execute arbitrary
> code. Only install from sources you trust.
