# pi-extension-focus-aware-blinking-cursor

Blinking cursor + focused/unfocused distinction for the pi TUI:

- **Focused**: fake cursor cell blinks on/off at ~2 Hz; border keeps pi's
  dynamic color (thinking level / bash mode).
- **Unfocused**: cursor hidden entirely; border dimmed.

"Focused" is two independent signals, both required for the blink:

- **TUI focus** (`Editor.focused`): the input editor is the active component
  (loses focus while selectors/overlays are open).
- **Terminal focus**: the terminal window itself. pi's TUI consumes the
  terminal's focus-in/focus-out sequences internally before extension input
  listeners run, so this extension watches raw stdin for them. In regular
  (non-fullscreen) mode focus reporting is off and the cursor blinks
  regardless of window focus.

## Install

```bash
pi install ./extensions/focus-aware-blinking-cursor-and-border   # local
pi install git:github.com/<you>/pi-collections                    # whole repo (root manifest loads all extensions)
pi install npm:pi-extension-focus-aware-blinking-cursor           # npm (if published)
```

> pi's git sources clone a whole repository, so this package cannot be
> installed via `git:.../pi-collections/extensions/focus-aware-...`. To
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
