<!--
Title: start with the type of change, e.g. "Add ...", "Fix ...", "Refactor ...".
Keep it concise and descriptive.
-->

## Summary

<!-- What changed, and why? One or two sentences. -->

## Changes

<!--
Bullet the notable edits. For a collection of pi extensions, name the
extension(s) and files involved.
-->

-

## Context

<!-- Background, linked issues/work items, prior attempts, related PRs. -->

## Type of change

<!-- Keep the categories that fit this change. -->

- Feature (new behavior or capability)
- Update to existing behavior
- Fix (incorrect or broken behavior)
- Refactor (no behavior change)
- Docs / tooling / chore

## Verification

<!--
Paste the commands run and the observed result, e.g. `npm run typecheck`.
-->

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (or `npm test -w <pkg-name>` for a single extension)
- [ ] Exercised in a real pi session with the extension loaded
      (`npm run start:<name>` or `pi -e ./extensions/<name>/<name>.ts`)

## Checklist

- [ ] Change is scoped to the stated intent; unrelated edits are split out
- [ ] If a new extension was added: entry added to the `## Extensions` list in
      `AGENTS.md` and the table in `README.md`, plus a `start:<name>` script
- [ ] If a package changed: `package.json`, `README.md`, and `CHANGELOG.md` are in sync
- [ ] Any dependency/version change is reflected in the committed `package-lock.json`
