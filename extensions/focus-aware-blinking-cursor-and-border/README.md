# pi-focus-aware-blinking-cursor

Blinking cursor + focused/unfocused distinction for the pi TUI:

- **Focused**: the cursor cell blinks on/off at ~2 Hz; border keeps pi's
  dynamic color (thinking level / bash mode).
- **Unfocused**: cursor hidden entirely; border dimmed.
- **Immediate on movement**: the blink phase resets when the cursor moves
  (typing, arrows, word jumps like option+f, scrolling) or when focus
  returns, so the cursor reappears instantly instead of waiting out the
  current "off" half of the cycle.

"Focused" is two independent signals, both required for the blink:

- **TUI focus** (`Editor.focused`): the input editor is the active component
  (loses focus while selectors/overlays are open).
- **Terminal focus**: the terminal window itself. pi's TUI consumes the
  terminal's focus-in/focus-out sequences internally before extension input
  listeners run, so this extension watches raw stdin for them. In regular
  (non-fullscreen) mode focus reporting is off and the cursor blinks
  regardless of window focus.

With pi's `showHardwareCursor` setting **on** (and a pi-tui that resolves its
own fake cursor cell, i.e. ≥ 1.2.0), pi shows the terminal's own cursor at
the caret, which blinks natively — a second blink would only fight it. The
extension then leaves the cursor cell untouched and contributes the focus
handling alone: no cursor at all while the editor or the window is unfocused,
plus the dimmed border. With the setting off, or on an older pi-tui that always
paints its own cell, the extension supplies the blinking.

## Install

```bash
pi install ./extensions/focus-aware-blinking-cursor-and-border   # local
pi install npm:pi-focus-aware-blinking-cursor           # npm (if published)
```

> pi's git sources clone a whole repository and install what its root
> `package.json` declares; the pi-collections root is never published and
> declares no `pi` manifest, so there is no `git:.../pi-collections/...` form. To
> install just this extension from the repo, clone it and `pi install` the
> subdirectory locally, or publish it to npm.

Or add it to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./extensions/focus-aware-blinking-cursor-and-border"]
}
```

## Notes

- Works with `scroll-speed` in any load order: it delegates to a previously
  registered editor factory instead of replacing it.
- Requires fullscreen (alt-screen) TUI mode for the terminal-focus signal.
- Handles both cursor encodings pi-tui has used: the reverse-video SGR of
  releases before 1.2.0 and the zero-width fake-cursor markers from 1.2.0 on
  (the TUI resolves those to reverse video *after* extension render hooks, so
  the SGR never appears in the lines an extension sees). Both are stripped
  together with the hardware-cursor marker, which is what makes the TUI hide
  the terminal cursor for the frame.
- Never touches the cursor cell while the terminal draws it, i.e. with
  `showHardwareCursor` on and a pi-tui ≥ 1.2.0 (detected through the exported
  `renderFakeCursor`): stripping the marker there would keep pi-tui from
  dropping its fake cell, painting a static reverse-video block instead of the
  terminal's blinking cursor. An older pi-tui paints its own cell regardless,
  so the blink stays with the extension there.
- `npm test -w pi-focus-aware-blinking-cursor` runs the headless suite, which
  asserts both encodings against the real installed editor classes.
