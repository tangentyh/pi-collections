# Plan: move configuration into pi's own settings files

- **Status:** implemented (`io.ts` + rewritten `config.ts` + tests in
  `tests/test.ts`); CHANGELOG/version bump deliberately left for the release
  flow. The optional `/auto-rename migrate` command is NOT implemented. The
  legacy-file fallback described under *Backward compatibility* below has since
  been **removed**, ahead of the sunset in step 4 of that section — only the
  `autoRename` key of pi's own settings files is read.
- **Scope:** `@tangentyh/pi-auto-rename` (fork of `@normful/pi-auto-name` 1.1.0)
- **Authority:** [`docs/extension-config-and-cache.md`](../../../docs/extension-config-and-cache.md)
  (repo-level handoff on config/cache placement). This plan implements its
  decision table for one extension.
- **Related:** [`PLAN-subagent-surfaces.md`](PLAN-subagent-surfaces.md) (also
  edits `config.ts`; decide landing order before implementing either).

## Current state

`config.ts` loads two JSON files with `@juicesharp/rpiv-config` and merges them
with a local `deepMerge`:

| | Path | Source |
| --- | --- | --- |
| Global | `~/.config/pi-auto-name/config.json` (honors `XDG_CONFIG_HOME`) | `configPath("pi-auto-name")` — `config.ts:83` |
| Project | `<cwd>/.pi/pi-auto-name.json` | `join(cwd, CONFIG_DIR_NAME, "pi-auto-name.json")` — `config.ts:112` |

`loadConfig(cwd)` (`config.ts:110`) is async-imported and called from the
`config(cwd)` cache helper in `auto-rename.ts`. Nothing reads
`ctx.isProjectTrusted()`, so project config is always honored.

Problems this creates:

- **Not where pi config lives.** The repo convention (and pi's own layout) is
  `~/.pi/agent/settings.json` (global) + `.pi/settings.json` (project). A
  separate `~/.config/pi-auto-name/` tree is invisible to `/settings`-style
  tooling and to anyone auditing their pi setup.
- **Hardcoded global dir.** `configPath` resolves `XDG_CONFIG_HOME` /
  `~/.config`, not pi's agent dir, so it ignores `PI_CODING_AGENT_DIR` and
  rebranded agent dirs. The convention is `getAgentDir()`.
- **Untrusted project config is honored.** Project values should only apply
  when `ctx.isProjectTrusted()`.
- **Extra dependency.** `@juicesharp/rpiv-config` exists only for
  `configPath` / `loadJsonConfig` / `validateConfig`.

## Target state

Read the `autoRename` key from pi's settings files, exactly mirroring
`pi-footer-template`'s `footerTemplate` key:

| | Path | API |
| --- | --- | --- |
| Global | `join(getAgentDir(), "settings.json")` → `autoRename` | `getAgentDir()` |
| Project (trusted only) | `join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")` → `autoRename` | `CONFIG_DIR_NAME`, `ctx.isProjectTrusted()` |

```jsonc
// ~/.pi/agent/settings.json  (global)
{
  "autoRename": {
    "namingModel": "openrouter/openrouter/free",
    "surfaces": { "renameTmuxWindow": true },
    "language": "en"
  }
}

// <project>/.pi/settings.json  (project, overrides global per field)
{
  "autoRename": { "namingStyle": "slug" }
}
```

The whole existing `Config` shape moves under the `autoRename` object unchanged
— no per-field renames. `surfaces.renamePiSessionInNonTuiModes` and
`surfaces.renameMultiplexersInNonTuiModes` from the sibling plan are added
inside the same object.

Merge semantics must match pi exactly (copy `readSettingsFile` +
`mergeSettings` from `extensions/footer-template/io.ts`):

- project overrides global, recursively for plain objects;
- any non-object value (including `""`) replaces the global value wholesale;
- missing or unparseable file → treated as unset (never throw);
- project file read only when `ctx.isProjectTrusted()`.

## Backward compatibility

> **Superseded:** the legacy fallback below was removed; the `autoRename` key is
> now the only configuration source. Kept for history.

Existing users have `~/.config/pi-auto-name/config.json` and/or
`<cwd>/.pi/pi-auto-name.json`. Plan:

1. **Read new location first.** If the merged settings contain no `autoRename`
   object, fall back to the legacy files (same deep-merge, project over global)
   so nobody's config silently resets.
2. **Notify once per session** when the fallback is used — `ctx.ui.notify(...)`
   when `ctx.hasUI`, plus a `debug()` line — naming the new location.
3. **Optional `/auto-rename migrate` command** that writes the effective legacy
   values into the global `autoRename` key (atomic temp-file + rename, like
   `writeGlobalCostCurrency` in `footer-template/io.ts`) and reports what it
   wrote. Do **not** delete or rewrite the legacy files automatically.
4. **Sunset:** drop the fallback after it has shipped for one or two minor
   versions, with a CHANGELOG note. Until then the fallback is unconditional
   (no config flag to enable it).

Legacy precedence stays project-over-global, matching the current behavior.

## Implementation steps

1. **New `io.ts`** in this extension (repo convention allows multi-file, cf.
   `footer-template/io.ts`): `readSettingsFile`, `mergeSettings`, and
   `resolveAutoRenameConfiguration(ctx)` returning already-validated settings +
   a `legacyFallbackUsed` flag. Namespace extraction lives here.
2. **Rewrite `config.ts`:**
   - Keep `ConfigSchema` (typebox) for defaults/validation of the extracted
     `autoRename` object; drop the `@juicesharp/rpiv-config` imports
     (`configPath`, `loadJsonConfig`, `validateConfig as rpivValidateConfig`).
   - `loadConfig(cwd: string)` → `loadConfig(ctx: ExtensionContext)` so it can
     read `ctx.cwd` and `ctx.isProjectTrusted()`. Keep the existing
     `deepMerge(fullDefaults, validated)` step so a partial `surfaces` override
     keeps untouched fields.
   - Delete `USER_CONFIG_PATH` and the `projectPath` legacy constant from the
     main path (they live only inside the fallback branch of `io.ts`).
3. **Update the caller** `config(cwd)` in `auto-rename.ts` to `config(ctx)` and
   pass the event `ctx`; the per-session `cfg = undefined` reset on
   `session_start` stays. Trust does not change mid-session, so caching once is
   still correct.
4. **Remove the dependency:** drop `"@juicesharp/rpiv-config"` from
   `package.json` dependencies and run `npm install` at the repo root to refresh
   `package-lock.json`. `typebox` stays (still used for the schema). If we later
   prefer hand-rolled validation like `footer-template`, both deps can go — out
   of scope here.
5. **README** — replace the two-file config section with the `autoRename`
   settings example and note the legacy fallback; update the config table only
   for the new key.
6. **CHANGELOG + version** — `0.2.0` (or fold into `0.1.0` if unpublished).

## Tests

Add `tests/test.ts` (Node + erasable TS, per repo convention) covering the pure
parts with injected file contents / temp dirs:

- namespacing: a global `autoRename` object resolves; unrelated settings keys are
  ignored;
- global ← project merge: nested `surfaces` merges, scalars replace;
- untrusted project: project settings are ignored (`ctx.isProjectTrusted()` false);
- legacy fallback: no `autoRename` key + legacy file present → legacy values
  used and `legacyFallbackUsed` true;
- malformed/missing settings file → defaults, no throw;
- schema defaults fill gaps after a partial override.

Manual: set `autoRename.language` in `~/.pi/agent/settings.json`, confirm it
applies; set a project override in `.pi/settings.json` in a trusted project and
confirm it wins.

## Risks / open questions

- **Settings key name.** `autoRename` follows the `footerTemplate` precedent and
  the package name `@tangentyh/pi-auto-rename`; upstream used the package/dir
  name `pi-auto-name`, so `autoName` would be the compatibility-friendly choice.
  Decision needed before implementation.
- **Auto-migration vs. notify.** This plan notifies and offers an explicit
  command rather than silently rewriting `settings.json`. If silent migration is
  wanted, it must be atomic and must not clobber concurrent settings writes.
- **`ctx` availability at config load.** `config.ts` is dynamically imported
  from handlers that already hold `ctx`; confirm no code path loads config
  outside a session context (the current `loadConfig(cwd)` takes only `cwd`, so
  this is the one real signature change).
- **Testing settings reads without mutating the real agent dir.** Tests should
  point at a temp dir via an injectable path rather than writing
  `~/.pi/agent/settings.json`; `io.ts` should take the settings path as an
  argument (as `footer-template/io.ts` does) to keep this easy.
