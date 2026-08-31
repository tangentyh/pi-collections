# pi-scroll-speed

Sets the lines scrolled per mouse-wheel notch in pi fullscreen mode
(default is 1). With this extension, one wheel notch scrolls **5** lines by
default — tune it with a setting, a CLI flag, or the `/scroll-speed`
command, or disable it entirely to restore pi's built-in scrolling.


## Install

```bash
pi install ./extensions/scroll-speed                         # local
pi install npm:pi-scroll-speed                     # npm (if published)
```

> pi's git sources clone a whole repository and install what its root
> `package.json` declares; the pi-collections root is never published and
> declares no `pi` manifest, so there is no `git:.../pi-collections/...` form. To
> install just this extension from the repo, clone it and `pi install` the
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

Or disable the extension without uninstalling it (leaves pi's built-in
wheel scrolling untouched):

```json
{
  "scrollSpeed": { "enabled": false }
}
```

Per-invocation override via CLI flag:

```bash
pi --wheel-lines 8
pi --wheel-lines off   # disable for this invocation
```

Resolution order (first hit wins): `--wheel-lines` flag (number or `off`) →
project `scrollSpeed` (`"enabled": false`, then `wheelLines`) → global
`scrollSpeed` (same) → `DEFAULT_WHEEL_LINES` in `scroll-speed.ts` (5).
`wheelLines` must be a positive integer; anything else is ignored. Changes
to settings or the flag require a pi restart (or `/reload`) to take effect.

At runtime, the `/scroll-speed` command changes the value immediately
(no restart):

- `/scroll-speed` — show the current value and where it came from
- `/scroll-speed 8` — scroll 8 lines per notch for the rest of the session
- `/scroll-speed off` — disable: restore pi's built-in wheel scrolling
  (1 line per notch, or whatever the terminal had before)
- `/scroll-speed reset` — revert to the configured value above (disabled
  counts: if settings say `"enabled": false`, reset disables again)

Argument completion offers a few common values plus `off` and `reset`. Any
`/scroll-speed <N>` re-enables after `off`. The runtime override is
session-only: it survives session switches, but a configured value still
wins after a restart — to make a value permanent, put it in settings.json.

## Notes

- Only affects fullscreen (alt-screen) mode; regular mode scrolls via the
  terminal's own scrollback and is intentionally untouched.
- The alt-screen renderer exposes a mutable `wheelScrollLines` field. This is
  an internal pi-tui field, not a documented setting — it may change in
  future versions.
- Works with `focus-aware-blinking-cursor-and-border` in any load order: it
  delegates to a previously registered editor factory instead of replacing
  it.
