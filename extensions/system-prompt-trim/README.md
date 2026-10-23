# pi-system-prompt-trim

Transcribes pi's own `docs` system-prompt section into a generated, on-demand
`pi-docs` skill, so every request stops paying for a topic index that only
matters on the rare turn you ask about pi itself.

```
before   <docs> 1 439 chars — routing sentence, doc paths, topic → file index, reading rules
after    <docs>    16 chars — blank; the whole index lives in the `pi-docs` skill
```

Nothing about pi's docs is hard-coded here. The skill is generated from the
section the running install actually renders, so a pi release that adds a topic,
rewrites the rules, or an install variant that appends a caveat — Pi-Bolt's
`pi-bolt update` note, for instance — keeps its wording and stays reachable.

## Install

```bash
pi install ./extensions/system-prompt-trim        # local
pi install npm:pi-system-prompt-trim              # npm
pi -e ./extensions/system-prompt-trim             # this session only
```

Requires **pi 1.3 or newer** — earlier releases build the system prompt from a
flat options object without the named section map (and skill list) this
extension writes to.

## What moves, what stays, what goes

The `docs` section is the only one this extension trims. Every other section —
skills, guidelines, tool notes, project context — is left exactly as pi built
it. Those carry standing instructions rather than lookup data, so moving one
behind a skill would change behaviour on turns that never mention it, and a
section-level trim is a decision each one has to earn on its own. The name
describes the category the extension belongs to, not a promise to touch more of
the prompt than `docs`.

pi's `docs` section is a routing sentence followed by bullets.

| Text | Where it goes |
|---|---|
| `- ` bullets: the three doc roots, the topic → file index, the reading rules, a variant's caveats about the same material | the `pi-docs` skill, verbatim |
| pi's routing sentence (`Pi documentation (read only when…)`) | **dropped** — the skill's description routes on the same topics, and on more |
| Any other line that is not a bullet | **stays** in the prompt, verbatim |

Bullets are lookup data: they only matter once the model has decided to read
pi's docs, which is exactly when a skill loads. A line without a bullet is the
safe default — it is more likely a standing instruction than lookup data, and
burying one in a skill that loads only on docs questions would change behaviour
on unrelated turns. That is the one thing blanking does not touch: if pi or a
variant adds an instruction inside `<docs>` without a bullet, it stays, and the
section is not blank at all.

The routing sentence is dropped for the same reason it was never worth a
pointer line. It gates reading on "the user asks about pi itself, its SDK,
extensions, themes, skills, or TUI"; the generated skill's description gates on
that list plus CLI, providers, models, MCP servers, codemode, settings, sessions
and SDK, and adds "or when working on pi or on a pi extension". The description
is the text skill matching actually consumes, and `<skills>` is rendered in every
prompt this extension trims — the handler bails without a reader tool and again
unless the skill is really advertised. So the routing was already stated where
it does work, and the always-on copy was 110 characters per request spent
repeating it. Its removal is by *shape* (`Pi documentation (…):`), not by
position: a variant's reshaped or inserted line survives.

What is left is a single space, because the section cannot be deleted. pi merges
`sections` with `if (content)` — a truthiness test with no trim — so `""` and
`null` are skipped and pi renders its whole section again; a space is the
smallest value that still replaces it, and 15 of the 16 bytes left are the
`<docs>` wrapper itself. An earlier version put an 83-character pointer line
there; it was a second copy of the description, so it went.

The paths can move now, which they could not when the skill shipped as a static
file: they are absolute and specific to the running install, so a file in the
package cannot state them. A file written on the machine can.

Prompt cost of the change, measured on a brew install of pi 1.4.0 where the
bullets name that install's absolute doc paths: 1 439 → 16 chars (Pi-Bolt's
bundle adds its own caveat bullet and starts at 1 498 — the paths, and so the
saving, scale with the install). The trimmed section does not grow when pi adds
topics: the saved text is the section's bullets, not a copy of today's index.

## The generated skill

`<agent dir>/cache/pi-system-prompt-trim/<install id>/pi-docs/SKILL.md` — on a
default install, `~/.pi/agent/cache/pi-system-prompt-trim/pi-coding-agent/…` —
written only when its content changes:

- **Not the temp directory.** Every skill's absolute `filePath` is rendered into
  its `<skills>` entry, so the advertised location is *in* the prompt and has to
  hold still between runs. `$TMPDIR` does not: it is per login session on macOS,
  fresh per container, and emptied by OS cleanup. A location that moves makes pi
  record a new `sections.skills` patch on the next resume, and a changed system
  prompt invalidates the provider's cached prefix for the entire conversation —
  far more than this extension saves. pi's own per-user state does not move.
- **One directory per install, named after the pi package.**
  `pi-coding-agent` for pi, `pi-bolt` for Pi-Bolt. Two installs on one machine
  must not share one file: the body is install-specific instruction, and the
  model reads it later in the turn, so the last writer would hand a Pi-Bolt
  session pi's transcription — dropping the `do not suggest pi update` caveat —
  or the reverse. The id carries no version, because only the *path* is prompt
  state: brew's Cellar, an npx or pnpm store and a dev checkout all end in
  `pi-coding-agent`, and a `pi-bolt-<platform>-<arch>` bundle is `pi-bolt`, so a
  pi update rewrites the body and leaves the prompt untouched. (Two *versions*
  of the same install do share one file, so for the few turns in which both run,
  the last writer's body wins — the paths differ, the topics barely do.)
- **Not `~/.pi/agent/skills`.** That directory is scanned and listed, so a
  generated skill there would show up in pi's own skill diagnostics and collide
  by name with a user's `pi-docs`; `cache/` is neither scanned nor listed. It
  does outlive `pi remove` — see [Off switch](#off-switch).
- **Registered in the same run that writes it.** The skill is pushed onto the
  prompt's skill list from the same `before_agent_start` handler, so it is
  advertised before the prompt that mentions it is sent. No `resources_discover`
  startup ordering, no "the skill only exists from the next session" bootstrap,
  and a resumed session needs no disk state.
- **Static frontmatter.** Only the body is install-specific; the name and
  description are constants, so the always-on skills section does not churn
  between machines. The body ends with the bullets exactly as pi rendered them.

## How it hooks in

`before_agent_start` gives handlers the prompt's `name → text` section map and
its skill list (`systemPromptOptions.sections` / `.skills`). The handler splits
the section pi actually built, writes the skill, advertises it, checks the skill
is really on in the prompt it just rendered, and blanks `sections.docs`. pi
persists the result as a normal section patch, so prompt caching and the
transcript's structured prompt state are unaffected — given that the advertised
location is the same on the next run, which is why the file lives in pi's own
state directory rather than a temp one. (Returning `systemPrompt` instead would
replace the whole prompt for the run — not what this extension wants.)

The source of truth is the rendered prompt, not a constant, so it **fails
closed**, leaving pi's section exactly as built:

- no section map (pi before 1.3), or no parseable `docs` section (a `SYSTEM.md`
  that replaces pi's prompt, or another extension's rewrite);
- no `read` or `bash` tool selected — pi omits the skills section, so trimming
  would put the index out of reach;
- no skill list in the prompt options to advertise into;
- **the skill is not on.** After advertising, the handler re-reads the prompt
  and requires a `<name>pi-docs</name>` entry inside its `skills` section. An
  entry in the options is no proof: pi leaves a skill out when it sets
  `disable-model-invocation: true`, and a user's own switched-off `pi-docs`
  takes the name this extension would have advertised. Pointing at a skill the
  model cannot see would cost the index *and* the paths — worse than the
  section it replaced;
- the write throws — a read-only or sandboxed agent dir must not cost the model
  its doc paths.

It is also idempotent: the same session re-derives the same blank section, and an
unchanged skill file is not rewritten, so no repeated section deltas are
recorded.

## Off switch

Remove the package (`pi remove ./extensions/system-prompt-trim`) and pi's own `docs`
section returns: the extension only ever *replaces* that section per run, and
keeps no state of its own. The generated file is the one thing it leaves behind
— it has to outlive the run, and the OS temp cleanup that a session resume
would run into — so delete it by hand if you want it gone:

```bash
rm -rf ~/.pi/agent/cache/pi-system-prompt-trim
```

## Alternatives

Two other extensions already move a docs block out of the prompt; neither
transcribes pi's current wording into a skill file the package itself manages.
[`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) has the full comparison, dated to when
this package was designed.

- [`pi-extension-docs-skill`](https://www.npmjs.com/package/pi-extension-docs-skill)
  also transcribes the block — into `~/.pi/agent/skills/pi-docs/SKILL.md`, so
  the skill follows pi's wording at the cost of writing into your agent dir (it
  outlives `pi remove`), stripping only once the skill file already existed at
  session start, and replacing the whole prompt for the run.
- [`@ssk_dev/pi-docs-slim`](https://www.npmjs.com/package/@ssk_dev/pi-docs-slim)
  removes the block entirely and puts it back for one run on `/pi <question>`.
  Cheaper per request, but the model cannot reach the docs on its own, only when
  you type the command.

## Layout

```
system-prompt-trim.ts    the extension: split pi's section, write the skill, patch the prompt
tests/test.ts           checks against pi 1.3.0's section text and Pi-Bolt's appended line
docs/PRIOR-ART.md       comparison with the packages above, dated
```
