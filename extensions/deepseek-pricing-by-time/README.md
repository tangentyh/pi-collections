# pi-deepseek-pricing-by-time

Time-of-day-aware [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing) cost
accounting for [pi](https://github.com/earendil-works/pi).

DeepSeek prices every request with **peak/off-peak (valley) rates** that depend on the
hour of day, but pi's cost display is static: it applies one fixed rate set from the
model metadata to every message. This extension fixes that by re-pricing each DeepSeek
assistant message with what was actually in effect when the message was produced — the
effective-dated rate schedule *and* the peak/off-peak tier for that message's own UTC
timestamp — so everything pi derives from per-message cost — session totals, the
footer, the statusline `cost` segment, `/usage`, exports — matches what DeepSeek
bills.

## How it works

- Hooks `message_end` (the same event pi's own docs use for cost correction) and, for
  assistant messages from the `deepseek` provider, resolves the model id against the
  rate period in effect at the message's **own timestamp** (UTC), then recomputes
  `usage.cost` from the message's token counts (`input`, `output`, `cacheRead`,
  `cacheWrite`) at that period's peak or off-peak rate.
- pi's session totals are the sum of per-message `usage.cost.total`, so the corrected
  values flow into every cost display automatically — no other state to sync.
- Also registers the `/deepseek-tier` command to show which tier is active right now,
  and sets a footer status (`peak ⚠️`/`off-peak`) that only updates when the tier
  flips (disableable, see [Configuration](#configuration)).

## Official rate schedule (as of 2026-09-12)

Peak hours: **01:00–04:00 & 06:00–10:00 UTC, Monday–Friday** (09:00–12:00 &
14:00–18:00 Beijing). All other hours — including weekends — are off-peak.
Off-peak rates are exactly half of peak. DeepSeek does not charge for cache writes.

| Model | Tier | Input (cache miss) | Output | Cache hit (input) | Cache write |
|-------|------|--------------------|--------|-------------------|-------------|
| `deepseek-flash` (V4.1-Flash) | peak | $0.30 /M | $1.20 /M | $0.006 /M | $0 |
| `deepseek-flash` (V4.1-Flash) | off-peak | $0.15 /M | $0.60 /M | $0.003 /M | $0 |
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` (legacy ids, routed to V4.1 Flash) | peak | $0.30 /M | $1.20 /M | $0.006 /M | $0 |
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` (legacy ids, routed to V4.1 Flash) | off-peak | $0.15 /M | $0.60 /M | $0.003 /M | $0 |
| `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | peak | $1.32 /M | $3.96 /M | $0.044 /M | $0 |
| `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | off-peak | $0.66 /M | $1.98 /M | $0.022 /M | $0 |

### Timeline

- **2026-08-16** — peak/off-peak (valley) pricing introduced: 01:00–04:00 &
  06:00–10:00 UTC, Monday–Friday. Unchanged since.
- **2026-09-10 04:00 UTC** — DeepSeek-V4.1-Flash ships as `deepseek-flash` at lower
  rates (peak input $0.44 → $0.30 per M, output $1.32 → $1.20; off-peak exactly
  half). `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired but
  temporarily routed to V4.1 Flash and billed at Flash rates.
- **2026-09-14 04:00 UTC (cancelled)** — DeepSeek had announced that
  `deepseek-v4-pro` would retire at this instant and route to V4.1 Flash, then
  reversed the decision: Pro keeps serving — and billing — unchanged past that
  instant until further notice. No retirement period is encoded.

### Effective-dated schedules and id routing

The schedule is not a snapshot: in `deepseek-pricing-by-time.ts` each model id maps to
an ordered list of **rate periods** (`SCHEDULES`), each with an inclusive `from`
instant plus the peak/off-peak rates from that instant on. A period applies until the
next one begins, and the first (from-less) period applies to every earlier instant.
The message's timestamp selects the period; the timestamp's UTC day and hour then
select peak vs. off-peak inside it. Only **forward-looking** boundaries are encoded —
today there are none: every model has a single from-less period, and the mechanism
stays ready for the next price change or retirement.

There is deliberately **no 2026-09-10 boundary** in the schedule. pi persists the
corrected cost on every message at `message_end`, and history is never re-priced, so
no message this extension can see predates the V4.1-Flash price cut: an old message
keeps the rate that was correct when it completed, and its session totals stay
consistent with what DeepSeek billed. (A replay-based re-pricing path would have to
reintroduce a pre-2026-09-10 V4-Flash period; until then it would be dead code.)

Each message is looked up by `responseModel` first, falling back to `model`. The
fallback is what keeps the legacy flash ids priced: DeepSeek echoes a
`deepseek-v4-flash` (or `-vision-exp`) request as `"model": "deepseek-flash"`, but
pi's bundled catalog (0.85.1) has no `deepseek-flash` entry, and an unknown id would
otherwise disable re-pricing entirely and leave pi's stale static catalog cost in
place. `deepseek-v4-pro` echoes its own id.

## Install

```bash
pi install npm:pi-deepseek-pricing-by-time
```

or from a local clone of this repo:

```bash
pi install ./extensions/deepseek-pricing-by-time
```

## Usage

When a DeepSeek response completes, its cost is re-priced at the period and tier in
effect for that message's timestamp:

- `message_end` corrects the stored per-message cost before it is summed into session
  totals, so the footer/statusline `cost` segment is accurate in real time.
- `/deepseek-tier` reports the currently active tier, the rates in effect for the
  active model, and the routing note for a retired/legacy id (useful for deciding
  when to run a batch).

## Configuration

The footer tier status is on by default. It can be disabled from project settings
(when the project is trusted) or global settings, with project settings taking
precedence:

```json
{
  "deepseekPricingByTime": false
}
```

or the object form:

```json
{
  "deepseekPricingByTime": {
    "showTierStatus": false
  }
}
```

Cost re-pricing itself is always on; only the footer status indicator is affected.

### Optionally: keep `models.json` as the fallback

If you also override DeepSeek rates in `~/.pi/agent/models.json` (e.g. with the
off-peak Flash values — `0.15` input, `0.60` output, `0.003` cache hit, in USD per
million tokens — since most of the day is off-peak), keep them: they remain the
baseline for any message this extension does not touch, for example other frontends
that consume your config, or a model id newer than its schedule. This extension
corrects the display on top of them.

## Customizing

The peak windows and the effective-dated schedules live at the top of
`deepseek-pricing-by-time.ts` (`PEAK_HOURS_UTC` and `SCHEDULES`). Edit them there if
DeepSeek changes the schedule or prices, or to add other models. The peak windows are
defined in **UTC** on purpose — DeepSeek publishes them in UTC and your local
timezone must not affect the tier. A period's optional `note` is what
`/deepseek-tier` appends for a retired or routed id.

Append a period to express a future price change, keeping each list in ascending
`from` order — e.g. when V4.1 Pro ships, add a second period to `deepseek-v4-pro`
(with placeholders standing in for the real launch instant and rates):

```ts
"deepseek-v4-pro": [
  { rates: V4_PRO },
  { from: V41_PRO_LAUNCH, rates: V41_PRO },
],
```

A brand-new model id is just a new entry with its own list (even a single from-less
period). Add a row to the rate table above when the published prices change.

## Compatibility

- pi 0.85+ (uses the `message_end` extension event and `ctx.ui` status API).
- Tested with `deepseek-flash` (V4.1 Flash, the canonical id), the legacy ids
  `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` (routed to V4.1 Flash), and
  `deepseek-v4-pro` (Pro rates — the announced 2026-09-14 retirement was reversed)
  on the official DeepSeek API.
- Cost correctness is display-side: like all pi cost accounting, it is an estimate
  based on reported usage tokens and published rates, not an invoice.
- Compaction and branch-summary entries still carry pi's static catalog cost:
  `session_compact` exposes no way to replace them, so those entries are not
  re-priced. Every actual assistant message is, so the residual error is limited
  to those summary entries.

## License

MIT
