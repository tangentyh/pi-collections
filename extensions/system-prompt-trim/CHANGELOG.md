# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-26

### Changed

- `systemPromptOptions` is read through pi 1.4's own types
  (`NormalizedBuildSystemPromptOptions`, `Skill`) instead of an `as unknown as`
  cast and duplicate local `SkillEntry`/`PromptOptions` shapes, so an upstream
  rename is a typecheck failure rather than a silent no-op. The runtime guards
  stay: a build without the named-section map or skill list is still left
  exactly as pi built it, a no-op rather than a throw.
- The pushed `pi-docs` skill entry's `sourceInfo` is built by
  `createSyntheticSourceInfo()` with `scope: "temporary"` and
  `origin: "top-level"` — the file is a regenerated cache under pi's agent dir —
  instead of a hand-built `{path, source: "extension", scope: "path",
  origin: "extension"}`.

## [0.1.0] - 2026-10-21

Initial release: pi's built-in `docs` system-prompt section is transcribed into a
`pi-docs` skill generated on each run, and the section is blanked — 1 439
characters down to 16 on a brew pi 1.4.0 install, 1 498 with Pi-Bolt's extra
caveat bullet. What moved is the section's bullets, not a copy of today's
index, so the trimmed section does not grow when pi adds topics.

- Nothing about pi's docs is hard-coded: the skill carries the bullets of the
  section the running install actually renders — the three documentation paths,
  the topic → file index, the reading rules, and any caveat an install variant
  appends (Pi-Bolt's `pi-bolt update` note, for instance) — so a pi release that
  adds a topic or rewrites the rules needs no change here.
- The split follows the section's shape: bullets move to the skill, and any line
  without a bullet stays in the prompt, so a standing instruction is never buried
  in a skill that loads only on docs questions. pi's routing sentence is dropped
  rather than restated — the skill's description gates on the same topics and
  more, and `<skills>` is rendered in every prompt this extension trims.
- What replaces the section is a single space: pi merges `sections` behind a
  truthiness test, so `""` and `null` are skipped and pi renders its whole
  section again, and a built-in section can be replaced but never deleted.
- The generated `SKILL.md` lives in
  `<agent dir>/cache/pi-system-prompt-trim/<install id>/pi-docs/SKILL.md` — pi's
  own per-user state, never `$TMPDIR`, because every skill's absolute `filePath`
  is rendered into `<skills>` and an advertised location that moves makes pi
  record a new skills patch on the next resume, invalidating the provider's
  cached prefix for the whole conversation. One directory per install
  (`pi-coding-agent`, `pi-bolt`) keeps two installs from overwriting each
  other's body, and the id carries no version, so a pi update rewrites the file
  without moving it. `cache/` is neither scanned nor listed, so the skill does
  not show up in pi's skill diagnostics or collide with a user's own `pi-docs`;
  the flip side is that the file outlives `pi remove`.
- Registering the skill through `systemPromptOptions.skills` in the same handler
  means it is advertised before the prompt that points at it is sent — no
  `resources_discover` startup ordering, no first-session bootstrap.
- Replaces the section through `systemPromptOptions.sections` in
  `before_agent_start`, so pi records a normal named-section patch instead of a
  forced whole prompt; prompt caching and the transcript's structured prompt
  state are untouched.
- Fails closed, leaving pi's section exactly as built: no named-section map or
  skill list (older pi), an absent or foreign section (`SYSTEM.md`, another
  extension's rewrite), no `read`/`bash` tool selected, a `pi-docs` skill that
  is not actually rendered (switched off, or a user's own `pi-docs` holding the
  name), or an agent dir that cannot be written.
- `docs` is the only section trimmed; every other section keeps standing
  instructions rather than lookup data, so it stays as pi built it.
- Idempotent within and across sessions: the same blank section every run, an
  unchanged skill file is not rewritten, and no repeated section deltas.
- Requires pi 1.3+ for the named-section map and the prompt's skill list.
