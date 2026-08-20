# Handoff: Extension Config, Cache & State Placement (pi)

**How to use this document:** point any task (or paste this file) that works on a
pi extension's persistence layer — config files, cache files, or state — at this
reference. It contains the decisions and reasoning from the original
investigation; treat it as the source of truth unless pi's docs change.

---

## Summary of decisions

| Concern | Location | API |
|---|---|---|
| Extension config (user-settable) | Keys in `~/.pi/agent/settings.json` (global) + `.pi/settings.json` (project, overrides global) | `getAgentDir()`, `CONFIG_DIR_NAME` |
| Rebuildable cache (survives restarts) | `~/.pi/agent/<extension>-cache.json` or `~/.pi/agent/<extension>/` subdir | `getAgentDir()` |
| Ephemeral scratch (safe to lose) | `os.tmpdir()` + own subdir | `node:os` |
| Session-bound state | `pi.appendEntry()` / tool result `details` (survives restarts, follows branching) | SDK |
| Project-local config that should only be honored for trusted projects | `.pi/` paths | check `ctx.isProjectTrusted()` first |

## Hard rules (do not violate)

1. **Never** put extension files in `~/.pi/agent/extensions/` — it is the
   auto-discovery directory for extension **code** (`*.ts` / `*/index.ts` are
   loaded and *executed*), and `pi install` (npm/git packages) materializes
   installed packages there. Package updates can overwrite or wipe whatever you
   drop in.
2. **Never** use `~/.pi/agent/tmp/` — it is pi's own scratch space (the package
   installer stages installs in `tmp/extensions`). Managed and cleaned; don't
   squat there.
3. **Never** hardcode `~/.pi/agent` — the agent dir is overridable via
   `PI_CODING_AGENT_DIR`. Always use `getAgentDir()` from the SDK.
4. **Never** hardcode `.pi` for project paths — use `CONFIG_DIR_NAME` from the
   SDK (rebranded distributions use a different config directory name).
5. Treat caches as **rebuildable by design**: write atomically (temp file +
   rename) and treat unreadable/corrupt cache files as "no cache" — never crash
   on them.
6. Keep the agent dir lean — it is moved/backed up as a unit (`auth.json`,
   `sessions/`, `trust.json`). Big caches go to the OS temp dir or a subdir,
   not as loose files in the agent dir root.

## API reference (imports from `@earendil-works/pi-coding-agent`)

```ts
import {
  CONFIG_DIR_NAME,          // ".pi" (rebrand-safe) for project-local paths
  getAgentDir,              // global agent dir (honors PI_CODING_AGENT_DIR)
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Global config/cache
const globalSettingsPath = join(getAgentDir(), "settings.json");
const cachePath = join(getAgentDir(), "my-extension-cache.json");

// Project-local config (per project, merges over global)
const projectSettingsPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");

// Ephemeral scratch
const scratchDir = join(tmpdir(), "pi-my-extension");
```

Context helpers relevant to config:

- `ctx.isProjectTrusted()` — returns whether project-local trust is active for
  the current session. **Check this before honoring project-local config.**
- `ctx.cwd` — current working directory; also the key to use for
  project-scoped cache entries (keep one cache file, keyed by cwd, rather than
  scattering files).
- `ctx.signal` — abort signal for cache-fetch work (e.g. `fetch(url, { signal: ctx.signal })`).

## Merge semantics (global vs project settings)

Mirror pi's own merge behavior: project values override global values; nested
objects merge recursively; any other value (including an empty string) replaces
the global value wholesale — a project-level scalar shadows the global one
entirely, no piecewise fallback. See `footer-template`'s `mergeSettings()`
(`extensions/footer-template/io.ts`) for a proven implementation.

## Reference implementation

`extensions/footer-template/io.ts` is the in-repo reference for all of this:

- `readSettingsFile()` — invalid or missing files treated as unset (cache-grade
  tolerance).
- `mergeSettings()` — pi-compatible global/project merge.
- `resolveFooterConfiguration(ctx)` — reads global settings from
  `join(getAgentDir(), "settings.json")` and project settings from
  `join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")`, then merges.

## Lifecycle notes

- Prefer `pi.appendEntry()` / tool result `details` for **state**, not config:
  it survives restarts and gets proper branch/compaction support inside the
  session.
- Do one-time startup work (fetching remote config, priming caches) in an
  **async factory** or `session_start`; pi awaits the factory before startup
  completes.
- Do not start background resources (watchers, timers, sockets) from the
  factory — defer to `session_start`, clean up in `session_shutdown`.
- Extension code goes in `~/.pi/agent/extensions/` (global) or
  `.pi/extensions/` (project-local) for auto-discovery and `/reload` support;
  `pi -e ./path.ts` is only for quick tests. Config and code never mix.

## When to consult pi's docs

- Extension API details: `docs/extensions.md` (in the pi package, or the
  "Extensions" doc on the pi site) — sections *Extension Locations*, *State
  Management*, *ExtensionContext*.
- `PI_CODING_AGENT_DIR` and other env vars: `docs/environment-variables.md`.
- Repo conventions (packaging, tags, README sync): `AGENTS.md` at repo root —
  read an extension's own `README.md` before modifying it.
