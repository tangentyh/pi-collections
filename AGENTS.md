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

## Conventions

- Extension names are `pi-<name>` on npm; directories keep the plain name.
- Entry files are semantic (`<name>.ts`), not `index.ts`.
- Every extension ships its own `README.md` and `LICENSE` (MIT).
- Root is never published, never given a `pi` manifest.
