# pi-sticky-last-prompt

Pins the user message your viewport is currently in as a one-line bar at
the very top of pi's fullscreen TUI. Left-click the bar and the transcript
scrolls so that message sits right below it — a quick way to jump back to
what you asked.

## Install

```bash
pi install ./extensions/sticky-last-prompt          # local
pi install npm:pi-sticky-last-prompt                # npm (if published)
```

> pi's git sources clone a whole repository and install what its root
> `package.json` declares; the pi-collections root is never published and
> declares no `pi` manifest, so there is no `git:.../pi-collections/...` form. To
> install just this extension from the repo, clone it and `pi install` the
> subdirectory locally, or publish it to npm.

Or add it to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./extensions/sticky-last-prompt"]
}
```

## Behavior

- The bar shows the latest user message the current viewport reaches:
  while your newest prompt is still on screen (or you're scrolled below
  it) that's the one pinned; scroll up past it and the bar falls back to
  the second-to-last message, then the third-to-last, and so on. When no
  user message has reached the viewport yet, the bar hides. Text is
  whitespace-collapsed to one line, ellipsized if too long, and themed
  with your active theme (`accent` icon on a `selectedBg` strip).
- Left-click anywhere on the bar to scroll the transcript to the message
  currently shown. The view lands just below the bar, and follow-tail is
  disabled so new output doesn't yank you back — exactly like pi's
  built-in search jump.
- Everything else keeps stock behavior: mouse wheel, text selection,
  scrollbar, right-click paste, middle click, drags. The extension swallows
  precisely one gesture — a left-button press inside the bar row.
- On `/reload` or when starting on an existing session, the bar re-derives
  from the rendered transcript — no seeding step; it just tracks wherever
  the viewport opens.

Requires fullscreen TUI mode (pi ≥ 0.84); in regular mode the extension
stays dormant.

## How it works

The pin is a non-capturing full-width overlay anchored top-left; its text
is resolved from the live transcript tree on every paint (message offsets
cached per width + content height), with no polling timers. Click interception
wraps the renderer instance's internal selection handler — in pi 0.84.x,
click events are consumed centrally before any public extension API can see
them, and that handler is the only seam left. The same instance patching
teaches `hasOverlay()` to ignore our non-capturing bar (and only ours), so
the stock scrollbar and text selection stay live while it is shown. All
internal access is defensive: if a future pi renames these pieces, clicking
stops working but nothing else breaks.

### Known tradeoffs

- While the bar is visible, scrollbar dragging and mouse text selection keep
  working: the extension reports "no overlay" to pi while its own
  non-capturing bar is the only overlay shown. When another overlay is on top
  (search box, dialogs), stock pi suppression applies.
- The bar covers the top transcript row while shown.
- Message offsets are re-measured whenever content height changes (e.g.
  while a response streams in), which adds one extra render pass of the
  transcript per such frame; between those frames everything is cached.
- Transcript rebuilds (`/tree` navigation, compaction, session load) swap
  the transcript container's children array wholesale; the offset cache
  keys on that identity, so the bar re-derives immediately from whatever
  messages the new branch renders — no stale labels even at identical
  heights.
