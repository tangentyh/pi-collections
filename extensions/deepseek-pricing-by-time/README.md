# pi-deepseek-pricing-by-time

Time-of-day-aware [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing) cost
accounting for [pi](https://github.com/earendil-works/pi).

DeepSeek prices every request with **peak/off-peak (valley) rates** that depend on the
hour of day, but pi's cost display is static: it applies one fixed rate set from the
model metadata to every message. This extension fixes that by re-pricing each DeepSeek
assistant message with the rate tier that was actually in effect when the message was
produced, so everything pi derives from per-message cost — session totals, the footer,
the statusline `cost` segment, `/usage`, exports — matches what DeepSeek bills.

## How it works

- Hooks `message_end` (the same event pi's own docs use for cost correction) and, for
  assistant messages from the `deepseek` provider, recomputes `usage.cost` from the
  message's token counts (`input`, `output`, `cacheRead`, `cacheWrite`) using the
  peak or off-peak rate in effect at the message's **own timestamp** (UTC).
- pi's session totals are the sum of per-message `usage.cost.total`, so the corrected
  values flow into every cost display automatically — no other state to sync.
- Also registers the `/deepseek-tier` command to show which tier is active right now,
  and sets a footer status (`deepseek: peak/off-peak rates`) that only updates when
  the tier flips.

## Official rate schedule (as of 2026)

Peak hours: **01:00–04:00 & 06:00–10:00 UTC** (09:00–12:00 & 14:00–18:00 Beijing).
Off-peak rates are exactly half of peak. DeepSeek does not charge for cache writes.

| Model | Tier | Input (cache miss) | Output | Cache hit (input) | Cache write |
|-------|------|--------------------|--------|-------------------|-------------|
| deepseek-v4-flash | peak | $0.44 /M | $1.32 /M | $0.014 /M | $0 |
| deepseek-v4-flash | off-peak | $0.22 /M | $0.66 /M | $0.007 /M | $0 |
| deepseek-v4-pro | peak | $1.32 /M | $3.96 /M | $0.044 /M | $0 |
| deepseek-v4-pro | off-peak | $0.66 /M | $1.98 /M | $0.022 /M | $0 |

## Install

```bash
pi install npm:pi-deepseek-pricing-by-time
```

or from a local clone of this repo:

```bash
pi install ./extensions/deepseek-pricing-by-time
```

## Usage

Nothing to configure. When a DeepSeek response completes, its cost is re-priced at the
tier in effect for that message's timestamp:

- `message_end` corrects the stored per-message cost before it is summed into session
  totals, so the footer/statusline `cost` segment is accurate in real time.
- `/deepseek-tier` reports the currently active tier and its rates (useful for deciding
  when to run a batch).

### Optionally: keep `models.json` as the fallback

If you also override DeepSeek rates in `~/.pi/agent/models.json` (e.g. with the
off-peak values, since most of the day is off-peak), keep them — they remain the
baseline for any message this extension does not touch (for example other frontends
that consume your config). This extension corrects the display on top of them.

## Customizing

The rate table and peak windows live in the top of `deepseek-pricing-by-time.ts`
(`PEAK_HOURS_UTC` and `RATES`). Edit them there if DeepSeek changes the schedule or
prices, or to add other models. The peak windows are defined in **UTC** on purpose —
DeepSeek publishes them in UTC and your local timezone must not affect the tier.

## Compatibility

- pi 0.84+ (uses the `message_end` extension event and `ctx.ui` status API).
- Tested with `deepseek-v4-flash` and `deepseek-v4-pro` on the official DeepSeek API.
- Cost correctness is display-side: like all pi cost accounting, it is an estimate
  based on reported usage tokens and published rates, not an invoice.

## License

MIT
