# pi-working-timer

Appends live elapsed time to pi's working indicator, so the line that already
tells you *that* pi is busy also tells you *how long*:

```text
── ⠋ Working · 1m 04s ────────────────────────────────────────────
```

One second tick, no configuration, no runtime dependencies (the closest npm
alternative ships a bundled `effect` runtime for the same twenty lines of timer
logic — see [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md)).

## Install

```bash
pi install ./extensions/working-timer         # local
pi install npm:pi-working-timer               # npm
pi -e npm:pi-working-timer                    # this session only
```

> pi's git sources clone a whole repository and install what its root
> `package.json` declares; the pi-collections root is never published and
> declares no `pi` manifest, so there is no `git:.../pi-collections/...` form. To
> install just this extension from the repo, clone it and `pi install` the
> subdirectory locally, or publish it to npm.

Or add it to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./extensions/working-timer"]
}
```

## What the clock measures

One **run**: from the moment you submit the prompt to the moment pi is fully
idle — `agent_settled`, which pi emits only when no retry, compaction retry or
queued continuation is pending. So multi-round tool work, automatic retries and
steer/follow-up messages all count into a single uninterrupted clock, and it
resets to `0s` for your next prompt.

- **Start** = your keystroke (pi's `input` event), not the provider request: the
  few hundred milliseconds pi spends expanding the prompt, flushing queued
  messages and dispatching the request are time you were waiting too.
- **A run started by another extension** (no `input` event) is timed from
  `agent_start` instead.
- **Interrupting** ends the run: the label is cleared with the rest of the
  working line.
- **Auto-retry and compaction** swap pi's working row for their own
  (`Retrying (1/3)…`, `Auto-compacting…`). The clock keeps counting underneath,
  so when the working row comes back it shows the true total, backoff included.

Formatting: `12s` under a minute, `1m 04s` under an hour, `1h 02m` after that.

## Notes

- **TUI only.** RPC, JSON and print modes accept `setWorkingMessage` as a no-op,
  so the extension starts no timer there.
- **One global working-message slot.** pi exposes the working line as a single
  string (`ctx.ui.setWorkingMessage`) with no getter, so extensions that write
  it (this one, `pi-working-status`, `pi-thinking-messaging`, custom spinner
  packages, …) overwrite each other — last write wins, and this extension's tick
  would fight another one's. Run one at a time. At the end of a run this
  extension clears the message back to pi's default, but it cannot know whether
  someone else had set it first.
- No commands, no settings: to disable it, remove the extension.
- Coexists with `pi-focus-aware-blinking-cursor` and `pi-scroll-speed` — it does
  not touch the editor, the cursor or the border, only the working message, so
  load order is irrelevant.
- `npm test -w pi-working-timer` runs the headless suite, which drives the real
  event wiring against an injected clock and scheduler.
