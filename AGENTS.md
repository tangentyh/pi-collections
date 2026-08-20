# AGENTS.md — pi-collections

Conventions for AI agents and humans working in this repo. The repo is a
**development-only npm workspace** for pi extensions — each extension in
`extensions/` is its own distributable pi package.

## Repo layout

- `extensions/<name>/` — one distributable pi package per extension:
  - `package.json` with a `pi` manifest (e.g. `"pi": {"extensions": ["./<name>.ts"]}`),
    the `pi-package` keyword, and a `files` field listing the entry, README, LICENSE
  - `<name>.ts` — semantic entry file (same name as the directory)
  - `README.md`, `LICENSE`
- Root `package.json` — **dev wrapper only**:
  - `"private": true`, never published
  - no `pi` manifest → the root is not installable via `pi install`
  - `workspaces: ["extensions/*"]` so one `npm install` at the root installs everything
- `tsconfig.json` — shared strict TypeScript config (`tsc --noEmit`), includes `extensions/**/*.ts`

## Extensions

Currently in the collection:

- `focus-aware-blinking-cursor-and-border/` → npm `pi-focus-aware-blinking-cursor` —
  blinking cursor when focused; border dims when the terminal loses focus
- `scroll-speed/` → npm `pi-scroll-speed` — lines scrolled per mouse-wheel notch in pi
  fullscreen mode
- `footer-template/` → npm `pi-footer-template` — render pi's footer from a configurable
  string template (the default mirrors the built-in footer plus the right-aligned
  account balance and absolute context-token usage); time and response throughput are
  reported in a notification configured the same way; multi-provider account balance
  mirrors pi-tidy-footer, plus provider quota status for Codex/Claude OAuth subscriptions
  mirrors pi-usage/pi-fancy-footer

Keep this list here in `AGENTS.md` in sync with the table in `README.md` (same order, names, descriptions).
When adding an extension, add it to both.

## Dev loop

```bash
npm install          # once, installs the whole workspace
npm run typecheck    # typecheck all extensions from the root
npm run start:<name> # launch pi with one extension loaded, e.g. start:scroll-speed
                     # (same as `pi -e ./extensions/<name>/<name>.ts`)
```

`pi install ./extensions/<name>` records a local path in
`~/.pi/agent/settings.json` without copying; edited files take effect in a
running pi with `/reload`.

> pi's git sources clone a whole repository and install what its root
> `package.json` declares, so there is no `git:.../extensions/<name>` form.

## Tags

Per-package annotated tags, named after the npm package name (not the
directory): `<npm-package-name>@<version>`, e.g. `pi-footer-template@0.2.0`.
Tag each published package version accordingly.

## Conventions

- Before working on an extension, read that extension's `README.md` first.
- Extension names are `pi-<name>` on npm; directories keep the plain name.
- Entry files are semantic (`<name>.ts`), not `index.ts`.
- Every extension ships its own `README.md` and `LICENSE` (MIT).
- Root is never published, never given a `pi` manifest.
- Do not prepare bump version or modify CHANGELOG unless asked.
