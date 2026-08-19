# pi-footer-template

Render pi's footer from a configurable string template.

> **Scaffold:** footer rendering and configuration resolution are not implemented yet.

## Install

```bash
pi install ./extensions/footer-template
# or, when published:
pi install npm:pi-footer-template
```

## Pi footer reference

Pi canonically calls the UI area at the bottom the **Footer** (or the
built-in/default footer). Its implementation class is `FooterComponent`, in:

```text
dist/modes/interactive/components/footer.js
```

### Rendered shape

The footer renders two lines by default, plus an optional extension-status
line:

```text
{cwd}[ ({gitBranch})][ • {sessionName}]
{tokenStats} {contextUsage}[ • xp]          {modelInfo}
{extensionStatus1} {extensionStatus2} ...
```

The third line is shown only when extension statuses exist. Model information
is right-aligned and may include the provider when multiple providers are
available.

### Token and context stats

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

## Planned configuration

The extension will read a `footerTemplate` setting from global or trusted
project settings:

```json
{
  "footerTemplate": {
    "template": "{cwd}\n{tokenStats} {contextUsage}          {modelInfo}"
  }
}
```

Planned placeholders include:

- `{cwd}`, `{gitBranch}`, and `{sessionName}`
- `{input}`, `{output}`, `{cacheRead}`, `{cacheWrite}`, `{latestCacheHitRate}`
- `{cost}`, `{percent}`, and `{contextWindow}`
- `{tokenStats}`, `{contextUsage}`, and `{modelInfo}`
- `{extensionStatuses}` and `{xp}`
