# pi-footer-template

Render pi's footer from a configurable string template and report response
throughput after each agent run.

## Configuration

The extension reads `footerTemplate` from project settings (when the project is
trusted) or global settings. Project settings take precedence:

```json
{
  "footerTemplate": {
    "template": "{cwd}{gitBranch}{sessionName}\n{tokenStats} {contextUsage}{contextTokens}{xp}{modelInfo:right}\n{extensionStatuses}",
    "notificationTemplate": "{time} ({elapsedTime} elapsed/{idleTime} idle) — {tokensPerSecond} tok/s, ${cost}, {output} out, {input} in, cache r/w {cacheRead}/{cacheWrite}, {totalTokens} total"
  }
}
```

The default template mirrors the layout of pi's built-in footer, with the
absolute context-usage token count appended after `{contextUsage}`:

```text
{cwd}{gitBranch}{sessionName}
{tokenStats} {contextUsage}{contextTokens}{xp}{modelInfo:right}
{extensionStatuses}
```

So the stats line shows e.g. `12.3%/200k (24,680)` — the percentage, the
context window, and the absolute number of tokens currently used.

`{gitBranch}`, `{sessionName}`, and `{xp}` carry their leading separators (see
the field table below), and the `:right` modifier pushes a field to the right
edge of its line — this is how the model information lands on the right side,
just like the built-in footer. The third line renders only when extension
statuses exist.

A string value is also accepted for convenience:

```json
{
  "footerTemplate": "{cwd} — {modelInfo}"
}
```

In string form only the footer is configured; the notification template needs
the object form. Settings are read from `.pi/settings.json` and
`~/.pi/agent/settings.json` and merged like pi's own settings: a project-level
`footerTemplate` shadows the global one entirely (an empty string in the
project disables the template even when global settings define one), and when
both sides are objects their keys merge, so a project that only sets
`notificationTemplate` keeps a global `template`. If no template is configured
— or it is empty or whitespace-only — the extension does not install a custom
footer, so pi's built-in footer remains active. A configured template replaces
it. Reload pi after changing the setting.

Unknown placeholders are left unchanged. Each rendered line is truncated to
the terminal width, like pi's built-in footer.

## Built-in fields

These fields provide the values shown by pi's built-in footer:

| Field | Value |
| --- | --- |
| `{cwd}` | Current working directory, with the home directory abbreviated as `~` |
| `{gitBranch}` | ` (branch)` — git branch in parentheses, leading space included; empty when unavailable |
| `{sessionName}` | ` • name` — session name with a leading bullet; empty when unnamed |
| `{latestCacheHitRate}` | Latest assistant cache-hit percentage, without the `%` sign |
| `{cost}` | Cumulative cost, formatted to three decimal places |
| `{percent}` | Current context usage percentage, formatted to one decimal place, or `?` |
| `{contextWindow}` | Context-window size in pi's compact token format |
| `{tokenStats}` | Cumulative input/output/cache/cost statistics |
| `{contextUsage}` | `{percent}%/{contextWindow}`, with `(auto)` when auto-compaction is enabled |
| `{contextTokens}` | ` (24,680)` — absolute number of context tokens currently used, with a leading space and parentheses; empty when the usage percentage is unknown or no model context is available |
| `{modelInfo}` | Model name, thinking level, and provider when multiple providers are available |
| `{extensionStatuses}` | Persistent extension statuses, sorted and joined on one line |
| `{xp}` | ` • xp` when `PI_EXPERIMENTAL=1`, otherwise empty |

Appending `:right` to any field name right-aligns that field's value on its
line, e.g. `{modelInfo:right}`. The line is split at that placeholder: the
text before it stays left-aligned, the field value is pushed to the right edge
with at least two spaces of separation, and overlong lines are truncated like
the built-in stats line (left part first, then the right part).

`{tokenStats}` includes usage from assistant messages, tool results, and
compaction/branch-summary generation, matching pi's built-in totals. Its token
counts use pi's compact format (`1.2k`, `3M`, and so on). One caveat: the
`(sub)` marker after the cost figure is shown only when the active provider is
`kimi-coding`. Pi's built-in footer additionally flags Anthropic and OpenAI
subscription plans, but its `modelRuntime.isUsingSubscription()` check is not
exposed to extensions, so those plans render without the marker here.

## Response throughput

After an agent run that produces output, the extension shows a notification.
Its text is configurable via `notificationTemplate` in the `footerTemplate`
settings object; without it, this default format is used:

```text
{time} ({elapsedTime} elapsed/{idleTime} idle) — {tokensPerSecond} tok/s, ${cost}, {output} out, {input} in, cache r/w {cacheRead}/{cacheWrite}, {totalTokens} total
```

Unlike the footer, the notification is rendered from the run-stats fields only
(it fires before the footer data provider is available). Unknown placeholders
are left unchanged, and an empty or whitespace-only template falls back to the
default format.

The following fields are also available in templates and describe the most
recent completed run:

- `{tokensPerSecond}` — output tokens divided by elapsed time, formatted to one decimal place
- `{output}` — output-token count
- `{input}` — input-token count
- `{cacheRead}` / `{cacheWrite}` — cache-read and cache-write token counts
- `{totalTokens}` — total-token count
- `{cost}` — cost of the run, formatted to three decimal places
- `{elapsedTime}` — elapsed time, shown as seconds, minutes and seconds, or hours, minutes and seconds
- `{idleTime}` — time since the previous agent run ended, or since `session_start` for the first message, formatted like `{elapsedTime}`
- `{time}` — wall-clock completion time of the run, in 24-hour `HH:MM:SS` (local time)

Before the first completed run, these throughput fields contain zero values
and `{time}` is empty.

## Install

```bash
pi install ./extensions/footer-template
# or, when published:
pi install npm:pi-footer-template
```

## Built-in footer without this extension

Pi's native footer remains active when this extension is not loaded. It also
remains active when no `footerTemplate` is configured. Its implementation class
is `FooterComponent`, in:

```text
dist/modes/interactive/components/footer.js
```

The built-in footer renders two lines, plus an optional extension-status line:

```text
{cwd}[ ({gitBranch})][ • {sessionName}]
{tokenStats} {contextUsage}[ • xp]          {modelInfo}
{extensionStatus1} {extensionStatus2} ...
```

The third line appears only when extension statuses exist. The model
information is right-aligned and may include the provider when multiple
providers are available. The default template above renders this same layout,
plus the absolute context-usage token count appended after `{contextUsage}`.
The built-in footer also handles width-aware truncation and context-usage
coloring; a custom template controls its own spacing and styling.

### Token and context stats

The built-in stats line contains these optional parts:

```text
[↑{input}]
[↓{output}]
[R{cacheRead}]
[W{cacheWrite}]
[CH{latestCacheHitRate}%]
[${cost}[(sub)]]
{percent}%/{contextWindow}[(auto)]
```

- `↑` — input tokens
- `↓` — output tokens
- `R` — cache-read tokens
- `W` — cache-write tokens
- `CH` — latest cache-hit percentage
- `$...` — cumulative cost; `(sub)` indicates subscription-backed usage
- `{percent}%/{contextWindow}` — current context-window usage
- `(auto)` — automatic compaction is enabled

Token totals include assistant responses, tool-result usage, and
compaction/branch-summary generation across the session.

### `xp`

`xp` means **experimental features**. It is displayed as `• xp` when:

```bash
PI_EXPERIMENTAL=1 pi
```

It is not a token or usage metric.

### Extension statuses

Extensions explicitly publish persistent footer statuses through the UI API:

```ts
ctx.ui.setStatus("my-ext", "● active");
```

They clear a status with:

```ts
ctx.ui.setStatus("my-ext", undefined);
```

Pi collects these as extension statuses, sorts them by key, sanitizes them to
one line, and joins them with spaces. Extension health is not inferred
automatically.

## Notes

- Custom footer rendering is active in pi's TUI mode only.
- Footer values are recalculated on render, so model, session, git, context,
  and extension-status changes are reflected without restarting pi.
- The extension keeps the throughput notification even when no custom template
  is configured.
