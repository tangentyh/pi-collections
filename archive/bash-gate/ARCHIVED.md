# Archived: `bash-gate` (dropped idea, never shipped)

- **What:** research notes for a pi extension that would gate `bash` tool calls
  and return feedback instructions (e.g. `grep` detected → block the call, tell
  the agent to use `rg` instead).
- **Status:** dropped at the research stage. Never became an extension, never
  published to npm.
- **Date:** 2026-09-04 (resolved 2026-09-04).
- **Decision:** adopted `npm:@aaronkyriesenbach/pi-substitute-commands`, which
  already implements the stated behavior (hard-blocks `bash` calls containing
  disallowed commands and suggests replacements, shipping `find`/`grep` →
  `fd`/`rg`).
- **Revisit only if:** custom rules / warn modes / copy-paste feedback become
  needed (see `docs/PRIOR-ART.md` for the full prior-art survey and details).

Preserved here so the research isn't redone from scratch.
