# pi-collections

Curated collections of [pi](https://github.com/earendil-works/pi-coding-agent) resources: extensions and themes.

## Collections

| Collection  | Directory       | Installs to            |
|-------------|-----------------|------------------------|
| Extensions  | `extensions/`   | `~/.pi/agent/extensions/` (dev symlink) |
| Themes      | `themes/`       | `~/.pi/agent/themes/`     |

## Extensions

Every extension in `extensions/` is its own **distributable pi package**
(own `package.json` with a `pi` manifest, tagged `pi-package`), so each can
be installed, shared, and updated independently:

```bash
pi install ./extensions/scroll-speed                        # local
pi install git:github.com/<you>/pi-collections/extensions/scroll-speed
pi install npm:pi-extension-scroll-speed                    # if published
```

| Package | Description |
|---------|-------------|
| `focus-aware-blinking-cursor-and-border/` | Blinking cursor when focused; border dims when the terminal loses focus |
| `scroll-speed/` | Lines per mouse-wheel notch in fullscreen mode |

For development, `./install.sh` symlinks the whole `extensions/` tree into
`~/.pi/agent/extensions/`, where pi auto-discovers each `*/index.ts` and
hot-reloads them with `/reload`.

## Install

```bash
./install.sh          # symlink all collections into ~/.pi/agent/
./install.sh extensions  # or just one collection
```

Changes to extension files take effect in a running pi with `/reload`.

## Type-checking extensions

```bash
npm install
npm run typecheck
```

The repo is an npm workspace: `extensions/*` are packages, and one `npm
install` at the root installs their devDependencies (hoisted) for
type-checking.

## Security

> Extensions run with your full system permissions and can execute arbitrary
> code. Only install from sources you trust.
