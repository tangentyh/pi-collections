# Archive

Retired material kept for reference: dropped-idea research and
deprecated/removed extensions. `extensions/` holds only live packages —
anything here is dead. Read it, don't install it.

```
archive/<name>/   # moved verbatim from extensions/<name>, plus:
  ARCHIVED.md     # what / status / date / why / replacement / last npm version
```

Top-level (not under `extensions/`) so archived items stay out of every
automation scope: npm workspaces, typecheck, Biome lint, and the publish
workflow all key off `extensions/`. Archived code is expected to bit-rot.

To archive: `git mv extensions/<name> archive/<name>`, add `ARCHIVED.md`,
remove its `start:<name>` script and its `AGENTS.md` / `README.md` entries,
re-run `npm install`, and confirm typecheck + lint + tests pass. To
resurrect: move it back and treat it as a new review.
