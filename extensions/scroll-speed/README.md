# pi-extension-scroll-speed

Sets the lines scrolled per mouse-wheel notch in pi fullscreen mode
(default is 1). With this extension, one wheel notch scrolls **5** lines —
edit `WHEEL_LINES` in `index.ts` to tune it.

## Install

```bash
pi install ./extensions/scroll-speed                         # local
pi install git:github.com/<you>/pi-collections/extensions/scroll-speed  # git
pi install npm:pi-extension-scroll-speed                     # npm (if published)
```

Or add it to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./extensions/scroll-speed"]
}
```

## Notes

- Only affects fullscreen (alt-screen) mode; regular mode scrolls via the
  terminal's own scrollback and is intentionally untouched.
- The alt-screen renderer exposes a mutable `wheelScrollLines` field. This is
  an internal pi-tui field, not a documented setting — it may change in
  future versions.
- Works with `focus-aware-blinking-cursor-and-border` in any load order: it
  delegates to a previously registered editor factory instead of replacing
  it.
