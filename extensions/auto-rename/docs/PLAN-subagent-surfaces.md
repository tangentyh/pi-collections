# Plan: stop subagent sessions from renaming the main session's surfaces

- **Status:** proposed, not implemented
- **Scope:** `@tangentyh/pi-auto-rename` (fork of `@normful/pi-auto-name` 1.1.0)
- **Related:** [`PLAN-config-location.md`](PLAN-config-location.md) (both plans touch
  `config.ts`; land them together or sequence config first)

## Symptom

While a subagent runs, the tmux window (or herdr pane/tab, zellij pane/tab)
that the **main** pi session runs in is renamed to the subagent's task, and the
main window name is not reliably restored. The pi **session** name of the main
session is unaffected.

## Root cause (verified against the installed sources)

1. `@tintinweb/pi-subagents` runs subagents as extra pi sessions **inside the
   same OS process** via `createAgentSession(...)`
   (`@tintinweb/pi-subagents/src/agent-runner.ts:1008`).
2. Those sessions load and bind the whole extension set by default — built-in
   agent types ship `extensions: true`
   (`src/default-agents.ts:21,35,80`) — so `pi-auto-name` is bound into every
   subagent session (`agent-runner.ts:1019`, `session.bindExtensions({ onError })`).
3. Immediately before binding, the runner names the child session
   `"<Type>#<8-hex>"` (`agent-runner.ts:1011`).
4. `bindExtensions` fires `session_start`, whose handler unconditionally syncs
   surfaces: `await syncSurfaces(pi, c, windowNameForSync(state, currentName))`
   (`auto-rename.ts:402`).
5. `syncSurfaces` (`surfaces.ts:60`) calls `renameTmuxWindow`
   (`surfaces.ts:283`), which runs `tmux rename-window -t $TMUX_PANE …`, plus
   the herdr/zellij equivalents. These surfaces are identified by **process
   environment** (`TMUX_PANE`, `HERDR_PANE_ID`, `ZELLIJ_PANE_ID`), which the
   child inherits from the main pi process — so the child renames the parent's
   window.
6. The default `replaceExistingName: "always"` (`config.ts`) means the child is
   not latched `done`; its first `input` / `agent_settled` runs the full naming
   pipeline (an extra LLM call) and calls `pi.setSessionName(...)` on the child
   session, then syncs the same shared surfaces again (`auto-rename.ts:300`,
   `:536`).

### Why no existing guard catches it

- `pi-auto-name` has no child/subagent check. Its only `hasUI` reads
  (`auto-rename.ts:428,471,509`) choose deferred vs. awaited, not skip.
- pi's `ExtensionContext` (pi 0.85.1) exposes no parent/child marker
  (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:209`).
- pi-subagents' child-session marker is a module-private `AsyncLocalStorage`
  (`src/child-context.ts`) that other extensions cannot observe.
- The child's `pi.setSessionName` is scoped to the child session, so it is
  invisible; only the process-global surfaces leak.

## Design goal

A session may only rename the **process-global terminal surfaces** when it is
the session attached to that terminal. Per-session state (the pi session name)
may still be renamed independently.

## Proposed fix

Gate every process-global surface write on a single per-session predicate:

```ts
/** The session that owns the terminal the process is attached to. */
function ownsTerminalSurfaces(ctx: ExtensionContext, cfg: Config): boolean {
	return cfg.renameOutsideTui || ctx.mode === "tui";
}
```

`ctx.mode` is the supported `ExtensionMode` (`"tui" | "rpc" | "json" | "print"`,
`types.d.ts:206`). Subagent sessions default to `"print"`:
`AgentSession` sets `_extensionMode = "print"`
(`dist/core/agent-session.js:122`) and pi-subagents' `bindExtensions({ onError })`
never passes `mode`, so the default survives. The main interactive session is
`"tui"`.

### Apply the gate in three places

1. **Whole pipeline — `prepareRename` (`auto-rename.ts:124`).** Return
   `undefined` up front for a non-owning session. This skips the LLM call, the
   `setSessionName` on the child, and the surface sync in one spot. Preferred
   over gating only surfaces: it also removes the wasted naming request and
   keeps child session names as `pi-subagents` set them.
2. **`session_start` (`auto-rename.ts:402`).** Guard the `syncSurfaces` call, so
   a child binding cannot relabel surfaces even before any rename runs.
3. **`session_info_changed` (`auto-rename.ts:536`).** Guard the `syncSurfaces`
   call for the same reason (covers an external `setSessionName` on a child).

`renameOnce` / `renameOnceDeferred` need no separate guard: both call
`prepareRename`, and the `session_start` / `session_info_changed` handlers are
the only `syncSurfaces` callers outside `completeRename`.

### Config knob

Add one boolean under `surfaces`:

- `surfaces.renameInNonTuiModes` — default `false`.
  `false` (default): only `mode === "tui"` sessions touch tmux/herdr/zellij.
  `true`: restores the current behavior (any mode may rename surfaces) for users
  who drive pi through RPC/print inside a multiplexer and want it named.

Keep `surfaces.renamePiSession` orthogonal: it already controls the per-session
name and does not need the terminal gate.

## Alternatives considered

| Option | Why not (now) |
| --- | --- |
| Detect the `"<Type>#<8hex>"` name convention | Brittle; couples the fork to another extension's naming and breaks for custom/renamed agents. |
| Process-level ownership claim (first binding in the process owns surfaces) | More precise, but relies on module state being shared across the per-session extension loaders, which is not guaranteed. Revisit if the `mode` heuristic proves insufficient. |
| Official pi API for parent/child sessions | Best long-term fix. File/ask for a child-session or `parentSessionId` field on `ExtensionContext`; use it as the primary signal when available and keep `mode` as fallback. |
| Skip only when `ctx.hasUI === false` | Also matches legitimate headless top-level runs; same regression as the mode gate but with no mode documentation behind it. |

## Implementation steps

1. Add `renameInNonTuiModes: Type.Boolean({ default: false })` to
   `ConfigSchema.surfaces` in `config.ts` (this is the file `PLAN-config-location.md`
   also edits — coordinate the merge).
2. Add the `ownsTerminalSurfaces(ctx, cfg)` helper in `auto-rename.ts`.
3. `prepareRename`: after the `!c.enabled` check, return `undefined` when
   `!ownsTerminalSurfaces(ctx, c)` (debug-log the skip with the mode).
4. Guard the two `syncSurfaces` call sites (`auto-rename.ts:402`, `:536`) with
   the same predicate.
5. Tests (see below).
6. README config table + a short "Subagents" note; CHANGELOG entry; bump to
   `0.2.0` (or fold into `0.1.0` if the fork has not been published yet).

## Tests

- **Pure unit test** of `ownsTerminalSurfaces` over the mode matrix
  (`tui` → true; `rpc`/`json`/`print` → false; `renameInNonTuiModes: true` →
  true for all).
- **Handler test** with a stub `pi` and a fake `ctx` (`mode: "print"`): assert
  `syncSurfaces` never calls `pi.exec("tmux", …)` and `prepareRename` returns
  undefined (so `generateNames` is never invoked).
- **Regression test** for the main path: `mode: "tui"` still renames surfaces.
- Manual: in tmux, run the parent, spawn a subagent, confirm the window name
  keeps the parent topic while and after the subagent runs.

The repo's `deepseek-pricing-by-time/tests/` and `sticky-last-prompt/tests/` show
the headless Node + erasable-TS test pattern to copy.

## Risks / open questions

- The `mode` signal is an implementation detail of how pi-subagents binds child
  sessions. If a future version passes the parent's `mode`, this gate silently
  stops working. Mitigation: assert the invariant in a comment and prefer the
  upstream child-session API if/when it exists.
- Non-TUI top-level runs (`pi -p`, RPC, JSON) no longer rename surfaces by
  default. This is the intended trade-off (short-lived / editor-driven runs
  should not rename a shared window); the config knob is the escape hatch.
- Should a future child session be allowed to rename its **own** per-session
  name only? Out of scope here; the plan intentionally keeps child names
  untouched.
