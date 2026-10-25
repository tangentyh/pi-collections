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
- `archive/<name>/` — retired material (dropped-idea research, deprecated/
  removed extensions), moved verbatim from `extensions/` plus an `ARCHIVED.md`
  status note. Deliberately outside every automation scope: not an npm
  workspace member, not typechecked (`tsconfig.json` covers only
  `extensions/**/*.ts`), force-ignored by Biome, invisible to the publish
  workflow. See `archive/README.md` for the archiving procedure.
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
- `working-timer/` → npm `pi-working-timer` — live elapsed time appended to pi's working indicator
  (`Working · 1m 04s`), one clock per agent run from prompt submission to `agent_settled`; zero
  configuration, zero runtime dependencies (see `docs/PRIOR-ART.md` for the crowded field)
- `auto-rename/` → npm `@tangentyh/pi-auto-rename` — fork of `@normful/pi-auto-name`: auto-generates a session name
  and window name from the conversation and applies the window name to the tmux window, herdr pane/tab,
  and zellij pane/tab the process runs in; deliberately diverges from upstream — see the package README
- `system-prompt-trim/` → npm `pi-system-prompt-trim` — trims pi's built-in `docs` system-prompt
  section out of every request and into an on-demand `pi-docs` skill: the section's bullets (doc paths,
  topic → file index, reading rules, and any variant caveat such as Pi-Bolt's) are transcribed verbatim
  into a generated `SKILL.md` in a temp dir, and the section is left blank. The `docs` section is the only
  one trimmed — every other section stays as pi built it (requires pi 1.3+, which exposes the prompt's
  named sections and its skill list to `before_agent_start`)

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

A test's expectation comes from outside the code — a vendor table, a spec, the
bug report it reproduces — pasted as a literal, never recomputed from the
module's own tables. **A test is red for a reason other than the code you just
wrote**; one that only reddens when its own line changes restates the
implementation, and a restating suite is worse than none. Prove it by deleting
the guard, flipping the sign, returning early: every guard you add or touch needs
a path that goes red. A bug fix starts with the repro as a failing test. Drive
time through an injected clock — a suite that sleeps or hits the network flakes,
and a flake gets deleted.

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

### Git worktrees

A fresh worktree has no `node_modules` — run `npm ci` in it. Never symlink it to
main's: the relative workspace links (`node_modules/pi-scroll-speed -> ../extensions/scroll-speed`)
would resolve back to main's `extensions/`, silently ignoring the worktree's source.

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
then GitHub-generated notes, as fallbacks). It is idempotent: a version already
on the registry — the hand-published first one, or a re-run after a partial
failure — skips `npm publish` and only ensures the Release exists.

Release flow:

```bash
# bump version in extensions/<name>/package.json (+ a CHANGELOG.md entry;
# refresh keywords too), commit on a branch, open a PR and let it merge,
# THEN tag the resulting commit on main and push the tag:
git tag -a <npm-package-name>@<version> -m "..." && git push origin <npm-package-name>@<version>
```

Gotchas:

- `npm ci` requires `package-lock.json` to be in sync; run `npm install` at the
  root after any dependency/version change and commit the lockfile.
- `protect-release-tags` blocks updating or deleting release tags — both
  unscoped `pi-*@*` and scoped `@*/pi-*@*` names: a tag on
  the wrong commit can only be superseded by a new version, not moved.
- One-time setup per new package: configure its Trusted Publisher on npmjs.com
  (GitHub Actions → `tangentyh` / `pi-collections` / `publish.yml`) and publish
  the first version by hand (`npm publish` in the extension directory) — trusted
  publishing cannot create a package that does not exist yet.

## Conventions

- **Never push to `main`** — PRs only, squash-merge: `protect-main` requires a
  green `check` and resolved threads on `main`; tag pushes are unaffected.
- Before working on an extension, read that extension's `README.md` first.
- Extension names are `pi-<name>` on npm; directories keep the plain name.
- Entry files are semantic (`<name>.ts`), not `index.ts`.
- Every extension ships its own `README.md`, `CHANGELOG.md`, and `LICENSE`
  (MIT). The changelog follows the Keep a Changelog format and starts with
  the initial `[0.1.0]` entry; every release adds an entry for its version.
- **Plans are scaffolds, not docs.** `extensions/<name>/docs/PLAN-*.md` lives
  only while the work is pending and is **deleted in the PR that lands it** —
  not kept with a status header (an implemented plan's target-state and step
  lists read as live spec and get "restored"). Before deleting, move behavior →
  README, non-obvious rationale → the code site, decision of record → the
  release CHANGELOG entry; never link a plan as current behavior.
  `docs/PRIOR-ART.md` is research about *other* packages — keep it, dated.
- **Markdown is deliberately unformatted.** `markdown.formatter.enabled` is
  off in `biome.json`, so `npm run lint` / `npm run format` never touch `.md`.
  Biome 2.6's markdown printer re-pads every table cell to the widest cell in
  its column (one edit to the README table reflows the whole column, which here
  means ~340-column rows) and deletes the blank line before a list even when
  that silently destroys an ordered list that does not start at 1 — such a list
  cannot interrupt a paragraph, so the items collapse into prose. Do not
  re-enable it, and do not hand-format markdown to match it.
- Root is never published, never given a `pi` manifest.
- Do not bump version or modify CHANGELOG unless asked.
