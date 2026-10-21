# `working-timer` prior art

Decision: **build new — but narrowly.** Live elapsed time in the working line
already exists at least four times; every one of them reimplements the same
`agent_start` + counter + `setWorkingMessage` recipe, and the closest minimal
one bundles a full `effect` runtime to do it. This package is that behavior with
zero runtime dependencies, a documented run window, and a test suite.
Date: 2026-10-21

## Catalog search

Registry (`https://registry.npmjs.org/-/v1/search?text=keywords:pi-package%20<q>`),
top ~12 reviewed per query: `working`, `timer`, `elapsed`, `duration`, `turn`,
`working-indicator`, `spinner`, `status`, `thinking`, `cursor`, `blink`,
`border`.

The registry reports the whole `pi-package` pool (~12.5k) as `total` for every
query, so recall is measured by distinct relevant packages found, not by counts:

- exact/near-exact "elapsed time in the working line": **6 packages**
- elapsed time in the footer/status bar: **3 packages**
- elapsed time as a transcript row after the response: **3 packages**
- editor-border status/timer slot: **3 large suites**
- combining a timer with focus/blinking cursor: **none** (`pi-focus-aware-blinking-cursor`
  is alone in that niche)

`npm view pi-working-timer` → 404, so the name was free.

## Closest alternatives

Downloads are npm last-month (window ending 2026-10-18) at time of writing.

| Package | Approach | Useful ideas |
| --- | --- | --- |
| `npm:@pi-plugins/elapsed` 0.1.2 (259/mo) — *"shows how long the agent has been working"* | `agent_start` → monotonic clock + 1 s ticker → `ctx.ui.setWorkingMessage("Working... 1m 04s")`; cleared on `agent_end`/`session_shutdown` | **Closest prior art: the same feature and the same output.** But it ships a bundled `effect` runtime (1.03 MB unpacked) for ~20 lines of timer logic, ends on `agent_end` (so a retry resets the clock, which its README admits), and has no tests |
| `npm:pi-thinking-messaging` 0.1.3 (204/mo) | `Working… (7m 7s · ↓ 30.0k tokens)`; label flips to `Thinking…`; idle notices at 1/3/5 min; tokens estimated at chars/4 | Phase labels, idle escalation, 13 KB with no dependencies |
| `npm:pi-work-timer` 0.1.0 (33/mo) | Spinner timer + namespaced footer status + `appendEntry` `✓ Worked for: 12s` transcript row | Documents **pi's single global working-indicator slot**; `/work-timer indicator off` to coexist with other indicator packages |
| `npm:pi-metrics` 0.8.0 | `src/turn-elapsed.ts`: per-turn and whole-run clocks; start from `input` rather than `agent_start`; restore on `turn_end` + `agent_end` + `agent_settled` | Best lifecycle reasoning found; its header comment spells out the `setWorkingMessage` tradeoff (it overwrites pi's `Working (Esc to interrupt)`) |
| `npm:pi-working-status` 0.1.0 (167/mo) | Replaces the row: `waiting 4.2s` / `thinking 3.1s · 820 ch` / `calling write 1.2s` / `quiet 6.1s`; 200 ms tick, repaint only when the text changes | Measured-not-estimated discipline; stall visibility |
| `npm:@nicknisi/pi-turn-timer` 0.2.0 (284/mo) | Dim transcript row `· 12.3s` (custom entry `turn-duration`); `agent_start` → `agent_settled`; subtracts `ui_prompt_*` waits | `agent_settled` as the true end; one row per run spanning tool rounds |
| `npm:pi-duration` 0.1.0 (24/mo) | Footer `⧖` live counter + timestamp/duration transcript markers stored in custom session entries (survive reload/resume) | Monotonic clock; persistence |
| `npm:pi-timer` 0.1.4 (128/mo), `npm:@lwlee2608/pi-footer` (458/mo), `npm:@clement_chsn/pi-activity-indicator` (199/mo) | Per-run elapsed inline in the footer / activity bar | Footer-slot variant; background-activity counters |
| `npm:@d3ara1n/pi-editor-shell` | **Editor top-border** indicator: phase spinner while working, `Nm` idle, plus a timer slot | Occupies the "no working-message stomp" slot — as part of a large suite, not a small dedicated package |

Adjacent but non-overlapping: `pi-tps-monitor` (throughput next to the
indicator), `@pi-kaush/pi-working-indicator` and `pi-quiet-spinner` (spinner
frames/cost), `pi-claude-shimmer`.

## Upstream baseline

`examples/extensions/` in the installed `@earendil-works/pi-coding-agent`
already ships the whole recipe:

- **`working-message-test.ts`** — the mechanism, and the piece that is easy to
  get wrong: pi stores `workingMessage` on the interactive session and
  **recreates the loader every turn**, so a message set once survives without
  re-setting it on `turn_start`.
- **`working-indicator.ts`** — `setWorkingIndicator({frames, intervalMs})` for
  the glyph (including `frames: []` to hide it); animation is pi's job, not the
  timer's.
- **`border-status-editor.ts`** — the alternative slot (right side of the top
  border, via `fitBorder()` + `visibleWidth`/`truncateToWidth`), if a timer ever
  has to avoid the shared working message.

Reused natively here: `input` / `agent_start` / `agent_settled` /
`session_shutdown`, `ctx.ui.setWorkingMessage`, and pi's own loader animation.
Deliberately **not** reimplemented: spinner frames, elapsed formatting
dependencies (`effect`), token estimates, transcript entries, footer statuses.

## Implications

1. **Scope to keep narrow.** The row is the entire product: `Working · <clock>`,
   nothing else. No footer status, no transcript row, no token estimate — all of
   those have incumbents, and mixing them is how these extensions become
   unmaintainable suites.
2. **The API choice is forced.** `setWorkingMessage` has no getter, so the timer
   must overwrite whatever label pi (or another extension) had, and two timer
   extensions installed together simply fight. That is a property of pi, not a
   design flaw to fix here — document it and stay out of the footer/editor slots
   so a timer can be combined with a footer or cursor extension.
3. **Differentiation is only dependency hygiene.** Same feature, same output,
   zero runtime dependencies, `agent_settled`-accurate window (retries and
   compaction included), and a headless suite. Anyone who already installs
   `@pi-plugins/elapsed` has no reason to switch; anyone who refuses to add an
   `effect` runtime to their TUI for a clock does.
