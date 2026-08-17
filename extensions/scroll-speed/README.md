# pi-scroll-speed

Sets the lines scrolled per mouse-wheel notch in pi fullscreen mode
(default is 1). With this extension, one wheel notch scrolls **5** lines by
default — tune it with a setting, a CLI flag, or the `DEFAULT_WHEEL_LINES`
constant in `scroll-speed.ts`.

## Install

```bash
pi install ./extensions/scroll-speed                         # local
pi install git:github.com/tangentyh/pi-collections               # whole repo (root manifest loads all extensions)
pi install npm:pi-scroll-speed                     # npm (if published)
```

> pi's git sources clone a whole repository, so this package cannot be
> installed via `git:.../pi-collections/extensions/scroll-speed`. To install
> just this extension from the repo, clone it and `pi install` the
> subdirectory locally, or publish it to npm.

Or add it to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["./extensions/scroll-speed"]
}
```

## Configuration

Set `scrollSpeed.wheelLines` in global settings
(`~/.pi/agent/settings.json`) or project settings (`.pi/settings.json`;
honored only when the project is trusted):

```json
{
  "scrollSpeed": { "wheelLines": 3 }
}
```

Per-invocation override via CLI flag:

```bash
pi --wheel-lines 8
```

Resolution order (first hit wins): `--wheel-lines` flag → project
`scrollSpeed.wheelLines` → global `scrollSpeed.wheelLines` →
`DEFAULT_WHEEL_LINES` in `scroll-speed.ts` (5). Values must be positive
integers; anything else is ignored. Changes require a pi restart (or
`/reload`) to take effect.

## Notes

- Only affects fullscreen (alt-screen) mode; regular mode scrolls via the
  terminal's own scrollback and is intentionally untouched.
- The alt-screen renderer exposes a mutable `wheelScrollLines` field. This is
  an internal pi-tui field, not a documented setting — it may change in
  future versions.
- Works with `focus-aware-blinking-cursor-and-border` in any load order: it
  delegates to a previously registered editor factory instead of replacing
  it.
