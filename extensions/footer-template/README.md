# pi-footer-template

Render pi's footer from a configurable string template, and report time and
response throughput in a notification after each agent run, configured the
same way.

## Configuration

The extension reads `footerTemplate` from project settings (when the project is
trusted) or global settings. Project settings take precedence:

```json
{
  "footerTemplate": {
    "template": "{cwd}[ ({gitBranch})][ • {sessionName}]{:right}[{balanceLabel}: {balanceStatus}][ Δ{balanceDelta}][ 5h {quota5hUsed} used ({quota5hReset})][ 7d {quota7dUsed} used ({quota7dReset})][ credits: {creditsRemaining}]\n[↑{sessionInput}][ ↓{sessionOutput}][ R{sessionCacheRead}][ W{sessionCacheWrite}][ CH{latestCacheHitRate}%][ Σ{totalTokens}][ {cost} {subscription}] {percent}%/{contextWindow}[={contextTokens}][ {autoCompaction}][ • {xp}]{:right}[ {modelProvider} {modelName} {thinkingLevel}]\n{extensionStatuses}",
    "notificationTemplate": "{time} ({elapsedTime} elapsed/{idleTime} idle) — {tokensPerSecond} tok/s, {cost}, ↑{input} ↓{output} R{cacheRead} W{cacheWrite} Σ{totalTokens}",
    "costCurrency": "auto"
  }
}
```

The default template — used when no template is configured — is the
`template` shown in the JSON example above. It mirrors the layout of pi's
built-in footer, with the account balance — and its session delta, e.g.
`Δ-¥2.15` — right-aligned on the first line, the absolute context-usage
token count appended right after the context usage (prefixed with `=`),
and the cumulative total-token count right after the session token
statistics. For the OAuth subscription providers, the first line renders
the quota-window breakdown from the structured quota fields instead of the
compact balance status (see [Account balance and provider
quota](#account-balance-and-provider-quota)).

So the first line shows e.g. the DeepSeek balance right-aligned
(`DeepSeek: ¥23.45 Δ-¥2.15`, in the configured display currency), and the
stats line shows e.g.

```text
~/project (main)                                                      DeepSeek: ¥23.45 Δ-¥2.15
↑12k ↓9.2k R640k CH98.2% ¥0.08 Σ661,204 3.2%/1.0M=32,144    (deepseek) deepseek-v4-flash • max
```

— the session token statistics, the cumulative total tokens, the context
usage, and the model information right-aligned, exactly like the built-in
stats line. The `¥` figures are the balance and the run cost in the
configured display currency (see [Multi-currency cost display](#multi-currency-cost-display));
for the OAuth subscription providers, the balance slot instead shows the
quota-window breakdown, e.g. `Codex: 5h 4% used (~3h) 7d 12% used (~5d)
credits: 0` (see [Account balance and provider
quota](#account-balance-and-provider-quota)).

The bracketed sections in the default template are optional: each section is
omitted when all of its fields are empty. Separators and other decorations
therefore live in the string template, while fields contain only their values.
An empty field also removes one adjacent whitespace run, so separators around
dropped values leave no stray spaces inside a kept section. The `{:right}`
marker splits its line, pushing everything after it to the right edge: this
is how the balance lands on the right side of the first line and
the model information on the right side of the stats line, just like the
built-in footer. The third line renders only when extension statuses exist.

A string value is also accepted for convenience:

```json
{
  "footerTemplate": "{cwd} — {modelName}"
}
```

In string form only the footer is configured; the notification template needs
the object form. Settings are read from `.pi/settings.json` and
`~/.pi/agent/settings.json` and merged like pi's own settings: a project-level
`footerTemplate` shadows the global one entirely (an empty string in the
project disables the template even when global settings define one), and when
both sides are objects their keys merge, so a project that only sets
`notificationTemplate` keeps a global `template`; an empty
`notificationTemplate` then disables the notification even when a global one
is defined, just as an empty `template` disables the custom footer. When no
template is configured, the extension applies its default template, which
mirrors pi's built-in footer layout plus the account balance, the absolute
context-usage token count, and the cumulative total-token count (shown
above). An empty or whitespace-only template disables the custom
footer, so pi's built-in footer remains active. Reload pi after changing the
setting.

Unknown placeholders are left unchanged. Bracketed sections containing fields
are omitted when all of those fields are empty; bracketed text without fields
is left literal. Each rendered line is truncated to the terminal width, like
pi's built-in footer.

## Built-in fields

These fields provide the values shown by pi's built-in footer:

| Field | Value |
| --- | --- |
| `{cwd}` | Current working directory, with the home directory abbreviated as `~` |
| `{gitBranch}` | `branch` — current git branch; empty when unavailable |
| `{sessionName}` | `name` — session name; empty when unnamed |
| `{sessionInput}` | Cumulative input tokens in pi's compact format (`1.2k`, `3M`); empty when zero |
| `{sessionOutput}` | Cumulative output tokens in pi's compact format; empty when zero |
| `{sessionCacheRead}` | Cumulative cache-read tokens in pi's compact format; empty when zero |
| `{sessionCacheWrite}` | Cumulative cache-write tokens in pi's compact format; empty when zero |
| `{latestCacheHitRate}` | Latest assistant cache-hit percentage, without the `%` sign; empty when the session has no cache usage or the rate is unknown |
| `{cost}` | Cumulative cost, converted to the configured display currency (see [Multi-currency cost display](#multi-currency-cost-display)); includes zero when nothing was spent |
| `{subscription}` | `(sub)` when the active model's usage is subscription-backed (Kimi Coding, OAuth subscription plans); otherwise empty |
| `{totalTokens}` | Cumulative total tokens used across the session (assistant messages, tool results, and compaction/branch-summary generation), as an exact count, e.g. `661,204`; empty when zero |
| `{percent}` | Current context usage percentage, formatted to one decimal place, or `?` |
| `{contextWindow}` | Context-window size in pi's compact token format |
| `{autoCompaction}` | `(auto)` when automatic compaction is enabled; otherwise empty |
| `{contextTokens}` | `=32,144` — absolute number of context tokens currently used, prefixed with `=`; empty when zero, when the usage percentage is unknown, or when no model context is available |
| `{modelName}` | Model id, e.g. `deepseek-v4-flash` (`no-model` without a model) |
| `{thinkingLevel}` | `• low` — thinking level with a leading bullet; `• thinking off` when the level is `off`; empty when the model has no reasoning |
| `{modelProvider}` | `(anthropic)` — provider in parentheses when multiple providers are available; otherwise empty |
| `{extensionStatuses}` | Persistent extension statuses, sorted and joined on one line |
| `{balanceLabel}` | Account-balance or quota label of the active provider, e.g. `DeepSeek`, `Claude`, or `BigModel`; empty when there is no status to show | (see [Account balance and provider quota](#account-balance-and-provider-quota)) |
| `{balanceStatus}` | Account-balance status without the label: `$17.35`, `No balance`, or `<err:...>`; for the OAuth quota providers only the error or `No quota` text renders here — the healthy quota status comes from the breakdown fields below; empty when there is no status to show |
| `{balanceDelta}` | Balance change since the first successful fetch of the session — current balance minus first balance — always signed and converted to the configured display currency: `-$0.15` means the balance went down by $0.15 since the first fetch (money spent), `+$10.00` means it went up (e.g. a top-up); the default template renders it next to `{balanceStatus}` with a `Δ` prefix (`Δ-$0.15`); empty when the active provider has no recorded baseline or no monetary balance, when the baseline's and the current balance's currencies differ, or when the delta rounds to zero |
| `{quota5hUsed}` | Used percentage for the 5-hour quota window, e.g. `23%`; `—` when the window exists but usage is unknown; empty when unavailable |
| `{quota5hRemaining}` | Remaining percentage for the 5-hour quota window, e.g. `77%`; `—` when usage is unknown; empty when unavailable |
| `{quota5hReset}` | Reset countdown for the 5-hour quota window, e.g. `~2h`; empty when unavailable or expired |
| `{quota7dUsed}` | Used percentage for the 7-day quota window, e.g. `41%`; `—` when the window exists but usage is unknown; empty when unavailable |
| `{quota7dRemaining}` | Remaining percentage for the 7-day quota window, e.g. `59%`; `—` when usage is unknown; empty when unavailable |
| `{quota7dReset}` | Reset countdown for the 7-day quota window, e.g. `~3d4h`; empty when unavailable or expired |
| `{creditsRemaining}` | Remaining/available Codex credits, e.g. `12.34`, without a unit or prefix; empty for providers without credits |
| `{xp}` | `xp` when `PI_EXPERIMENTAL=1`, otherwise empty |

A `{:right}` marker splits its line: the text before it stays left-aligned,
and everything after it — fields, optional sections, or literal text — is
pushed to the right edge as one unit. The marker sits at the boundary, e.g.
`{cwd}[ ({gitBranch})][ • {sessionName}]{:right}[{balanceLabel}: {balanceStatus}][ Δ{balanceDelta}]`
or `{:right}{modelName}` to right-align a single field. Only the first marker
outside an optional section splits the line; later ones stay literal text.
The deprecated bare `:right` form is still accepted (the brace form is tried
first, so it is never split in two); inserting anything inside the braces,
e.g. `{ :right}`, renders literal text.
The right side is pushed to the edge with at least two spaces of separation,
and overlong lines are truncated like the built-in stats line (left part
first, then the right part).

The session token fields (`{sessionInput}`, `{sessionOutput}`,
`{sessionCacheRead}`, `{sessionCacheWrite}`, `{cost}`, `{subscription}`,
`{totalTokens}`, `{latestCacheHitRate}`) include usage from assistant
messages, tool results, and compaction/branch-summary generation, matching
pi's built-in totals; their token counts use pi's compact format (`1.2k`,
`3M`, and so on). The `(sub)` marker flags subscription-backed usage exactly
like pi's built-in footer: it appears for Kimi Coding (subscription-backed
despite using API-key authentication) and for OAuth providers whose provider
definition marks the auth as a subscription (e.g. Anthropic and OpenAI
plans).

## Per-run stats notification

After an agent run that produces output, the extension shows a notification.
Its text is configurable via `notificationTemplate` in the `footerTemplate`
settings object; without it, this default format is used:

```text
{time} ({elapsedTime} elapsed/{idleTime} idle) — {tokensPerSecond} tok/s, {cost}, ↑{input} ↓{output} R{cacheRead} W{cacheWrite} Σ{totalTokens}
```

The run-stats token markers mirror the footer template's token statistics:
`↑` input, `↓` output, `R` cache-read, `W` cache-write.

Unlike the footer, the notification is rendered from the run-stats fields only
(it fires before the footer data provider is available). Unknown placeholders
are left unchanged. Like the footer template, an empty or whitespace-only
`notificationTemplate` disables the notification entirely; without the key,
the default format is used.

The following fields are also available in templates and describe the most
recent completed run (in footer templates, `{totalTokens}` and `{cost}`
instead reflect the cumulative session totals, so they can sit next to the
cumulative session token fields):

- `{tokensPerSecond}` — output tokens divided by elapsed time, formatted to one decimal place
- `{output}` — output-token count
- `{input}` — input-token count
- `{cacheRead}` / `{cacheWrite}` — cache-read and cache-write token counts
- `{totalTokens}` — total-token count
- `{cost}` — cost of the run, formatted in the configured display currency (see [Multi-currency cost display](#multi-currency-cost-display))
- `{elapsedTime}` — elapsed time in compact `{h}h{m}m{s}s` form (`2h5m3s`; sub-minute runs show `12.3s`)
- `{idleTime}` — time since the previous agent run ended, or since `session_start` for the first message, formatted like `{elapsedTime}`
- `{time}` — wall-clock completion time of the run, in 24-hour `HH:MM:SS` (local time)

Before the first completed run, these run-stats fields contain zero values
and `{time}` is empty.

## Multi-currency cost display

Cost figures — the `{cost}` field, the run-stats notification, and the
`{balanceStatus}` amount — are priced in USD by the model registry and
converted to a configurable display currency, like
[pi-tidy-footer](https://github.com/eriiic7z/pi-tidy-footer).

| Command | Effect |
| --- | --- |
| `/set-currency` | Show the current currency and the list of available codes |
| `/set-currency <code>` | Set the display currency, e.g. `/set-currency EUR` |
| `/set-currency auto` | Restore the provider-based default |

The default is `auto`: the currency follows the active provider. CNY is used
for the extension's Chinese providers — `deepseek`, `moonshotai-cn`,
`siliconflow`, `zai-coding-cn` — and USD for every other provider:
`openrouter`, `zai` (Z.ai international), the quota providers `openai-codex`
and `anthropic`, and anything else. So a
DeepSeek model shows its cost and balance as `¥...`, an OpenRouter model as
`$...`, and switching models switches the currency with them.

Available currencies: `AUD` (A$), `CAD` (C$), `CNY` (¥), `EUR` (€), `GBP` (£),
`HKD` (HK$), `JPY` (¥), `KRW` (₩), `TWD` (NT$), `USD` ($). Each currency
defines its own decimal places (0 for JPY/KRW, 3 for USD, 2 otherwise),
matching pi-tidy-footer. The selection is user config and lives in the
settings as `footerTemplate.costCurrency`: `/set-currency` writes it to the
global settings (`~/.pi/agent/settings.json`), and a project-level
`costCurrency` in `.pi/settings.json` shadows the global value like any other
setting. Setting `costCurrency` directly also works, e.g.
`{"footerTemplate": {"costCurrency": "EUR"}}`; an unset `costCurrency`
means `auto`.

Exchange rates come from the free `@fawazahmed0/currency-api` package (served from the jsdelivr CDN, USD base). They are fetched once per 24 hours on session start and after `/set-currency` changes, cached in memory, and persisted as a rebuildable cache in `~/.pi/agent/pi-footer-template-state.json` (the agent dir, resolved via `getAgentDir()`, honors `PI_CODING_AGENT_DIR`); fetch failures keep the previous cache. USD needs no rates at all, so it always works offline. When a non-USD currency is selected and no rate is available, the cost renders as the currency symbol with `--` (e.g. `€--`), and the account balance falls back to its native currency formatting. In `auto` mode this applies to the resolved currency: a DeepSeek model without a cached CNY rate renders `¥--` for costs, and the balance keeps its native currency.

## Account balance and provider quota

`{balanceLabel}: {balanceStatus}` shows the remaining account balance of the
active provider, like [pi-tidy-footer](https://github.com/eriiic7z/pi-tidy-footer) and
[pi-deepseek-usage](https://github.com/shaftoe/pi-deepseek-usage):
`DeepSeek: $17.35`. The supported providers and their balance endpoints:

| Provider id | Label | Endpoint | Native currency |
| --- | --- | --- | --- |
| `deepseek` | DeepSeek | `GET https://api.deepseek.com/user/balance` | reported (USD preferred, else first) |
| `moonshotai-cn` | Moonshot | `GET https://api.moonshot.cn/v1/users/me/balance` | CNY |
| `openrouter` | OpenRouter | `GET https://openrouter.ai/api/v1/credits` | USD |
| `siliconflow` | SiliconFlow | `GET https://api.siliconflow.cn/v1/user/info` | CNY |
| `zai-coding-cn` | BigModel | `GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report` | CNY |
| `zai` | Z.AI | `GET https://api.z.ai/api/biz/account/query-customer-account-report` | USD |

bigmodel.cn retired its PaaS monetary-balance endpoint (`account/billing`
answers 404 for every key), so the BigModel and Z.AI balances come from their
undocumented console account-report endpoints above (the same API is also
reachable at `https://bigmodel.cn/api/biz/account/query-customer-account-report`).
They accept the regular API key like every other endpoint in this table, but
— unlike the rest — they answer HTTP 200 with application-level failures in
their JSON envelope. Both fields are empty when the active model's provider
is not in the table.
The balance is fetched with the provider's API key from pi's model registry and
cached for 30 seconds to avoid excessive API calls; a provider switch
refetches immediately. When the account reports no balance, `{balanceStatus}`
renders as `No balance`. Fetch failures render as `<err:code>` (`http401` for
a missing or invalid API key — including the account-report envelope's code
1001/401 credential failures, which arrive under HTTP 200, `fetch` for
network errors, `badjson` for malformed responses, `api{code}` for any other
application-level envelope failure) and are retried on the next refresh.
The balance refreshes on session start, on model selection, and after each
turn, and is recalculated without restarting pi. When the configured display
currency differs from the balance's own currency, the amount is converted with
the same daily FX rates used for costs (`/set-currency`); without a rate, the
balance keeps its native currency. The `{balanceDelta}` field renders how much
the balance moved since the first successful fetch of the session — current
minus first, so spending shows as a negative value (`-¥2.15`) and a top-up
as a positive one; it is converted to the display currency like the balance
amount (falling back to the native currency without a rate), and stays empty
while the delta rounds to zero, when the account reports no balance, or for
the quota providers. Like pi-deepseek-usage, requests are sent
with `Accept-Encoding: identity` to avoid pi's undici gzip-decompression
issue, and the `proxy-managed` key sentinel is respected in sandboxed
environments.

### Provider quota status

For the OAuth subscription providers, the default template renders the rolling
quota windows instead of a monetary balance, mirroring
[pi-fancy-footer](https://github.com/mavam/pi-fancy-footer)'s provider-status
widget and [pi-usage](https://github.com/Sreetej510/pi-extensions):
`Codex: 5h 4% used (~3h) 7d 12% used (~5d) credits: 0` — each window
is its length (`5h`, `7d`), the **used** percentage, and the reset countdown;
the Codex credit balance appears as `credits: 12.34` when the account
reports one. The supported quota providers and their endpoints:

| Provider id | Label | Endpoint | Windows |
| --- | --- | --- | --- |
| `openai-codex` | Codex | `GET https://chatgpt.com/backend-api/wham/usage` | 5h, 7d |
| `anthropic` | Claude | `GET https://api.anthropic.com/api/oauth/usage` | 5h, 7d |

The quota data behind this default rendering is split into explicit fields:
`{quota5hUsed}`, `{quota5hRemaining}`, `{quota5hReset}`, `{quota7dUsed}`,
`{quota7dRemaining}`, `{quota7dReset}`, and `{creditsRemaining}` — the default
template composes the status above from them, and custom layouts can use them
the same way, e.g.:

```text
{balanceLabel}: [5h {quota5hUsed} used ({quota5hReset})][ 7d {quota7dUsed} used ({quota7dReset})][ credits: {creditsRemaining}]
```

The used and remaining fields include the `%` sign. Reset fields contain a
countdown such as `~2h` when available (the default template appends them to
their window; the compact status format shows them only for windows at or
above 75% used), and credit fields represent the remaining/available balance
rather than credits consumed. These fields are empty when their window or
credit balance is unavailable; an existing window with unknown usage uses `—`
for its percentages. While quota data is available, `{balanceStatus}` stays
empty so the breakdown does not duplicate the compact status; only its error
or `No quota` text renders through `{balanceStatus}`.

Quota status is fetched only while the active model uses OAuth auth for one of
the quota providers (API-key Claude models have no subscription quota), using
the same `Accept-Encoding: identity` and `proxy-managed` handling. Like
pi-usage, the quota endpoints are polled at most once every 3 minutes (the
balance refreshes at most every 30 s) with a 15-second request timeout, on the
same triggers as the balance; a provider or auth switch refetches immediately.
Windows whose usage is unknown render as `5h:—`. Fetch failures render as
`<err:code>` (`timeout` for timed-out requests, `fetch` for network errors,
`http401` for missing or invalid OAuth credentials, `badjson` for malformed
responses) and are retried on the next refresh.

## Install

```bash
pi install ./extensions/footer-template
# or, when published:
pi install npm:pi-footer-template
```

## Built-in footer without this extension

Pi's native footer remains active when this extension is not loaded, and when
`footerTemplate` is explicitly set to an empty or whitespace-only value. Its
implementation class is `FooterComponent`, in:

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
plus the account balance — with its session delta — right-aligned on the
first line (the quota-window breakdown for the OAuth subscription
providers), the absolute context-usage token count appended after the
context usage, and the cumulative total-token count right after the session
token statistics.
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

The default template composes these same parts from the primitive fields:

```text
[↑{sessionInput}][ ↓{sessionOutput}][ R{sessionCacheRead}][ W{sessionCacheWrite}][ CH{latestCacheHitRate}%][ {cost} {subscription}] {percent}%/{contextWindow}[ {autoCompaction}]
```

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
- The per-run stats notification fires after every output-producing run,
  independently of the footer template; an explicitly empty
  `notificationTemplate` disables it.
- Cost and account-balance figures are converted into the currency selected
  with `/set-currency`; `auto` is the default (CNY for the extension's
  Chinese providers, USD otherwise) and USD needs no exchange rates.
