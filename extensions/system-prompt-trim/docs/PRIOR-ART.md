# pi's own docs, moved out of the system prompt — prior art

Decision: build new, as a transcribed skill plus a section override — the
two existing extensions both move the docs block out of the prompt, but one
does it behind a `/pi` command and the other writes a skill file into the user's
agent dir; neither manages the skill file itself, and both replace the whole
prompt for the run instead of patching one section.
Date: 2026-10-21

Revised: the first cut shipped a hand-written `pi-docs` skill in the package and
kept the install's doc paths in the prompt, because a static file cannot carry
absolute paths. Generating the file from the prompt pi actually renders removes
that constraint and the second copy of pi's index — see "Where this package
differs" below, which replaces the original reasoning.

## Catalog search

npm registry, `keywords:pi-package <query>` (`.../-/v1/search`). The registry
reports `total: 12485` for every one of these queries — the second term reorders
rather than filters, so hit counts are not discriminating and only the ranked
hits are worth reading.

- `docs skill`, `docs token`, `pi-docs`, `system prompt`, `prompt section`,
  `skill`, `docs`: **exact-domain match** → `pi-extension-docs-skill`,
  `@ssk_dev/pi-docs-slim` (fork of `pi-slim`)
- `system prompt`: adjacent, not competitors — `@zhushanwen/pi-system-prompt`,
  `pi-prompt-profiles`, `pi-model-system-prompt`, `@agnishc/edb-system-prompt-watch`, `pi-system-prompt` (dumps the prompt)
- `skill`: adjacent — `pi-skill-shiori` (skill-catalog token retrieval),
  `pi-skill-enhancer`, `@mrclrchtr/supi-skills`
- `docs`: unrelated caches — `pi-verse-docs`, `@raffaelenatale/pi-docs-sync`,
  `@upstash/context7-pi`, `@aliaksei-raketski/pi-taiga-ui-docs`
- No package ships a *static* `pi-docs` skill in the package that installs the
  extension (checked the manifests of both exact matches).

## Closest alternatives

| Package | Approach | Useful ideas |
| --- | --- | --- |
| `npm:pi-extension-docs-skill@1.0.0` (GreenHatHG) — transcribes pi's docs block into `~/.pi/agent/skills/pi-docs/SKILL.md` and strips the block | runtime write + forced whole prompt | Derives the skill from pi's own wording, so it follows upstream without maintenance; atomic temp-file+rename write, no rewrite when unchanged; **does not strip until the skill file existed at session start** (first session keeps the block); write failure warns and leaves the block intact |
| `npm:@ssk_dev/pi-docs-slim@0.3.1` (fork of `robzolkos/pi-slim`) — strips the block, restores it for one run on `/pi <question>` | command-gated removal, message-level cleanup | Overrides the section with a truthy marker (`""` is regenerated — same wall we hit), then strips `<docs>` from saved and sent system messages; `isBuiltinDocs()` requires all eight native lines, so a project's own `<docs>` block is never touched; cleans history left by an earlier `/pi` run; ties the "keep docs" permission to the exact request so it cannot leak into the next message; offline integration tests against a fake provider |
| `npm:pi-slim@0.2.1` (Rob Zolkos) — the original | string replacement in the rendered prompt | The `/pi` command; broke on Pi 0.87.1 when the prompt became structured sections ([pi-slim#3](https://github.com/robzolkos/pi-slim/issues/3)) — the failure mode any text-splicing approach inherits |
| `npm:pi-skill-shiori`, `pi-skill-enhancer` | skill-catalog token control | Different axis (the skills block), but the same premise: the catalog is a routing table and should be the only always-on cost |

Where this package differs:

1. **The generated skill lives in pi's own state directory, not a temp one.**
   Like `pi-extension-docs-skill` we transcribe pi's own wording instead of
   reimplementing it, so upstream changes need no release here. The file lands
   in `<agent dir>/cache/pi-system-prompt-trim/<install id>/`: one directory per
   install, named after the pi package directory (`pi-coding-agent`, `pi-bolt`),
   so two installs on one machine cannot overwrite each other while a pi update
   keeps the same path. A temp directory is what the first version used, and it
   was wrong: a skill's absolute path is rendered into the prompt, and `$TMPDIR`
   moves between boots, so pi recorded a new `sections.skills` patch on the next
   resume and the provider's cached prefix for the whole conversation was gone.
   There is still no write-permission decision about a directory the user owns —
   the file is regenerated from the prompt on every run, so a deleted or stale
   copy costs nothing. No bootstrap session either: the file is written and
   advertised in the same run that trims the section, so there is never a session
   with the block gone and the skill not yet registered.
2. **The model can self-serve.** `/pi <question>` only restores the docs when
   the *user* types a command; a skill is advertised by name and description, so
   the model loads it on the turn that needs it.
3. **One named section changes, not the whole prompt.** Returning
   `systemPrompt` replaces the prompt for the run; setting
   `sections.docs` makes pi record a normal section delta and keeps the cached
   prefix and the transcript's structured prompt state intact — as long as the
   advertised skill location holds still, which is why it lives in the agent dir.
4. **The doc paths move too, because nothing is hand-written.** They are
   install-specific, so a static file cannot carry them — which is why the
   static-file design had to keep three path lines in every request. Transcribing
   the section on the machine removes that: paths, index and rules all move, and
   the prompt keeps a blank section — 16 bytes of `<docs>` wrapper, because pi
   merges the map with a truthiness check and a built-in section can be replaced
   but never deleted. Nothing of pi's own section stays: its routing sentence
   repeats what the generated skill's description already routes on, and the
   `skills` section is always rendered when the section is trimmed. What does
   stay is whatever a variant writes *without* a bullet, so a standing
   instruction is never buried in a skill that loads only on docs questions.

## Upstream baseline

`examples/extensions/prompt-customizer.ts` is the pattern followed here: mutate
`event.systemPromptOptions.sections` in `before_agent_start` instead of
reparsing or replacing the rendered prompt.

Two details from pi 1.3.0's `buildSystemPromptSections`
(`packages/coding-agent/src/core/system-prompt.ts`) that decide the
implementation:

- `sections` holds *custom* sections, merged over the built-ins by name — an
  empty value is skipped (`if (content)`, truthiness, no trim), so a built-in
  section can only be **replaced**, never deleted. Verified against Pi-Bolt
  1.4.0: `null` and `""` both leave the full built-in section rendered, while a
  single space replaces it — which is why the trimmed section is one space
  rather than nothing.
- The built-in `docs` section exists only while `customPrompt` (a `SYSTEM.md`)
  is unset, so absence is a normal case, not an error.

Do not reimplement: the prompt sections themselves, skill discovery and
advertising (the `pi.skills` manifest entry), or the transcript's section diff
(`diffSystemPromptSections`) — the extension only supplies text for one section.

## Implications

1. **Scope** — trim one section, ship one skill; no marker strings, no system
   message rewriting, no history cleanup. The few hundred characters that remain
   are the price of not owning the prompt pipeline.
2. **API** — `systemPromptOptions.sections` (pi 1.3+), read through an untyped
   access so the package still typechecks against the older `devDependency` and
   no-ops rather than throws on a release without the map.
3. **Differentiation** — package-owned skill (installs and uninstalls as a unit,
   reviewable before install, model-loadable) and a cache-friendly one-section
   delta, with the exact install paths left in the prompt.
