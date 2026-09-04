# AGENTS.md — pi-collections

Conventions for AI agents and humans working in this repo. The repo is a
**development-only npm workspace** for pi extensions — each extension in
`extensions/` is its own distributable pi package.

## Repo layout

- `extensions/<name>/` — one distributable pi package per extension:
  - `package.json` with a `pi` manifest (e.g. `"pi": {"extensions": ["./<name>.ts"]}`),
    the `pi-package` keyword, and a `files` field listing the entry, README, LICENSE
  - `<name>.ts` — semantic entry file (same name as the directory)
  - `README.md`, `CHANGELOG.md`, `LICENSE`
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
- `deepseek-pricing-by-time/` → npm `pi-deepseek-pricing-by-time` — time-of-day-aware DeepSeek
  cost accounting: re-prices every DeepSeek assistant message at `message_end` with the
  official peak/off-peak rates in effect at the message's UTC timestamp, so session
  totals, the footer, the statusline cost segment, and exports match what DeepSeek bills
- `sticky-last-prompt/` → npm `pi-sticky-last-prompt` — pins the latest user message that has scrolled
  completely above the viewport top as a one-line bar at the top of pi's fullscreen TUI (while a prompt
  is still crossing the top edge the bar hides rather than duplicate it); left-clicking the bar
  scrolls the transcript to that message

Keep this list here in `AGENTS.md` in sync with the table in `README.md` (same order, names, descriptions).
When adding an extension, add it to both.

## Dev loop

```bash
npm install          # once, installs the whole workspace
npm run typecheck    # typecheck all extensions from the root
npm run lint         # biome check (format + lint); `npm run format` writes fixes
npm run start:<name> # launch pi with one extension loaded, e.g. start:scroll-speed
                     # (same as `pi -e ./extensions/<name>/<name>.ts`)
```

Every extension declares a `test` script in its own `package.json` (an
`echo "no tests"` placeholder when it has no suite): plain `npm test` at the
root runs every suite via npm workspaces, `npm test -w <pkg-name>` runs one
(e.g. `npm test -w pi-sticky-last-prompt`). Suites live in
`extensions/<name>/tests/` as erasable-only TypeScript that Node runs
directly, headlessly against the real installed pi-tui.

`npm run lint` (Biome `check` from the single root `biome.json`, `recommended`
preset) must pass: fix or `biome-ignore`-with-reason anything it reports, except
the accepted `noExplicitAny` / `noNonNullAssertion` warnings (deliberate
defensive access to pi internals). A `pre-commit` hook checks staged files and
a `pre-push` hook runs typecheck + tests (installed by the root `prepare`
script); `.github/workflows/ci.yml` enforces lint + typecheck + tests on
push/PR, since hooks are bypassable with `--no-verify`.

`pi install ./extensions/<name>` records a local path in
`~/.pi/agent/settings.json` without copying; edited files take effect in a
running pi with `/reload`.

> pi's git sources clone a whole repository and install what its root
> `package.json` declares, so there is no `git:.../extensions/<name>` form.

## Adding a new extension

Follow the layout and naming conventions above; concretely:

1. Create `extensions/<name>/` — easiest by copying an existing extension's
   `package.json` and adjusting it.
2. Add a `"start:<name>": "pi -e ./extensions/<name>/<name>.ts"` script to the
   root `package.json`.
3. Run `npm install` at the root so the workspace links the new package, then
   `npm run typecheck` must pass.
4. Add the extension to the list in this file (`## Extensions`) and to the table
   in `README.md` (`## What's here`) — same order, names, descriptions in both.
5. Before its **first** publish: configure the Trusted Publisher for `pi-<name>`
   on npmjs.com (see Gotchas below).

## Tags & publishing

Per-package annotated tags, named after the npm package name (not the
directory): `<npm-package-name>@<version>`, e.g. `pi-footer-template@0.2.0`.
Tag each published package version accordingly.

Pushing such a tag triggers `.github/workflows/publish.yml`, which publishes
the matching extension to npm with provenance via **npm trusted publishing
(OIDC)** — no token secret is involved. The workflow resolves the extension
directory by matching the tag against every `extensions/*/package.json`
`name@version` and fails loudly on mismatch. After a successful publish it
also creates a GitHub Release for the tag, using the version's section from
the extension's `CHANGELOG.md` as the release notes (annotated tag message,
then GitHub-generated notes, as fallbacks).

Release flow:

```bash
# bump version in extensions/<name>/package.json (+ a CHANGELOG.md entry;
# refresh keywords too), commit,
# push main, THEN tag the pushed commit and push the tag:
git tag -a <npm-package-name>@<version> -m "..." && git push origin <npm-package-name>@<version>
```

Gotchas:

- `npm ci` requires `package-lock.json` to be in sync; run `npm install` at the
  root after any dependency/version change and commit the lockfile.
- One-time setup per new package: configure its Trusted Publisher on npmjs.com
  (GitHub Actions → `tangentyh` / `pi-collections` / `publish.yml`).

## Conventions

- Before working on an extension, read that extension's `README.md` first.
- Extension names are `pi-<name>` on npm; directories keep the plain name.
- Entry files are semantic (`<name>.ts`), not `index.ts`.
- Every extension ships its own `README.md`, `CHANGELOG.md`, and `LICENSE`
  (MIT). The changelog follows the Keep a Changelog format and starts with
  the initial `[0.1.0]` entry; every release adds an entry for its version.
- Root is never published, never given a `pi` manifest.
- Do not bump version or modify CHANGELOG unless asked.
