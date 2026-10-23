# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-21

Initial release: pi's built-in `docs` system-prompt section is transcribed into a
`pi-docs` skill generated at startup, and the section is reduced to its routing
sentence plus a pointer (~1 300 fewer characters in every request).

- Nothing about pi's docs is hard-coded: the skill carries the bullets of the
  section the running install actually renders — the three documentation paths,
  the topic → file index, the reading rules, and any caveat an install variant
  appends (Pi-Bolt's `pi-bolt update` note, for instance) — so a pi release that
  adds a topic or rewrites the rules needs no change here.
- The split follows the section's shape: bullets move to the skill, and any line
  without a bullet stays in the prompt, so a standing instruction is never buried
  in a skill that loads only on docs questions.
- The generated `SKILL.md` lives in `$TMPDIR/pi-system-prompt-trim/<docs-root hash>/`
  rather than `~/.pi/agent/skills`: `pi remove` leaves nothing behind, two
  installs on one machine cannot collide, and an unchanged file is not rewritten.
- Registering the skill through `systemPromptOptions.skills` in the same handler
  means it is advertised before the prompt that points at it is sent — no
  `resources_discover` startup ordering, no first-session bootstrap.
- Replaces the section through `systemPromptOptions.sections` in
  `before_agent_start`, so pi records a normal named-section patch instead of a
  forced whole prompt; prompt caching and the transcript's structured prompt
  state are untouched.
- Fails closed, leaving pi's section exactly as built: no named-section map or
  skill list (older pi), an absent or foreign section (`SYSTEM.md`, another
  extension's rewrite), no `read`/`bash` tool selected, or a temp directory that
  cannot be written.
- Idempotent across runs in a session: the same pointer every run, and no
  repeated section deltas.
- Requires pi 1.3+ for the named-section map and the prompt's skill list.
