import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

// DeepSeek official USD pricing (https://api-docs.deepseek.com/quick_start/pricing;
// exact peak windows at PEAK_HOURS_UTC below). Off-peak rates are exactly half of
// peak; cache writes are free.
//
// Rates are **effective-dated**, not static: every model maps to an ordered list
// of periods (`RatePeriod`). A period carries an inclusive `from` (epoch ms) and
// applies until the next one; the first period has no `from` and therefore
// applies to every instant. The message's own timestamp selects the period, then
// `tierAt()` selects peak vs. off-peak inside it.
//
// Two aliases are also modelled:
//   - `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` were retired on
//     2026-09-10 and are temporarily routed to V4.1 Flash, billed at Flash rates.
//   - `deepseek-v4-pro` is retired from 2026-09-14T04:00:00Z (`V4_PRO_RETIRED`)
//     and is served by V4.1 Flash at Flash rates until V4.1 Pro ships. Its
//     second period is what expresses that rerouting, regardless of whether
//     DeepSeek echoes the legacy id or `deepseek-flash`.
//
// Only forward-looking boundaries are encoded. The 2026-09-10 Flash price cut is
// intentionally *not* a boundary: corrections are persisted per message at
// `message_end` and history is never re-priced, so no future message can predate
// it. (A replay-based re-pricing path would need a `FLASH_V4 -> FLASH_V41`
// period reintroduced.)
//
// pi's built-in cost display applies whatever static rates the model metadata
// carries to every message; this extension instead re-prices each DeepSeek
// assistant message at `message_end` with the period and tier in effect at the
// message's own timestamp, so session totals, the footer, the statusline cost,
// and exports match what DeepSeek actually bills.

export interface DeepSeekRates {
	/** Cache-miss input, USD per 1M tokens. */
	input: number;
	/** Output, USD per 1M tokens. */
	output: number;
	/** Cache-hit input, USD per 1M tokens. */
	cacheRead: number;
	/** Cache write, USD per 1M tokens. */
	cacheWrite: number;
}

export type Tier = "peak" | "offPeak";

/** One effective-dated pricing period; applies until the next period begins. */
export interface RatePeriod {
	/** Inclusive start instant (epoch ms). Omitted on the first period. */
	from?: number;
	/** Rates in effect during this period, split by tier. */
	rates: Record<Tier, DeepSeekRates>;
	/** Optional routing/retirement note surfaced by `/deepseek-tier`. */
	note?: string;
}

/**
 * UTC hours inside a peak window: [01:00, 04:00) ∪ [06:00, 10:00) — i.e.
 * 01:00-04:00 & 06:00-10:00 UTC (09:00-12:00 & 14:00-18:00 Beijing time),
 * Monday through Friday; every other hour (weekends included) is off-peak.
 */
const PEAK_HOURS_UTC = new Set([1, 2, 3, 6, 7, 8, 9]);

/** 2026-09-14T04:00:00Z: from this instant `deepseek-v4-pro` bills at Flash rates. */
export const V4_PRO_RETIRED = Date.UTC(2026, 8, 14, 4);

// DeepSeek-V4.1-Flash (canonical id `deepseek-flash`), shipped 2026-09-10.
const FLASH_V41: Record<Tier, DeepSeekRates> = {
	peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
};

// DeepSeek-V4-Pro, unchanged until it is retired in favour of V4.1 Flash.
const V4_PRO: Record<Tier, DeepSeekRates> = {
	peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
	offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
};

/** Routing note `/deepseek-tier` shows for the flash ids retired on 2026-09-10. */
const LEGACY_FLASH_NOTE = "legacy id, routed to V4.1 Flash";

const SCHEDULES: Record<string, RatePeriod[]> = {
	// Canonical V4.1-Flash id.
	"deepseek-flash": [{ rates: FLASH_V41 }],
	// Retired 2026-09-10; temporarily routed to V4.1 Flash at Flash rates.
	"deepseek-v4-flash": [{ rates: FLASH_V41, note: LEGACY_FLASH_NOTE }],
	"deepseek-v4-flash-vision-exp": [
		{ rates: FLASH_V41, note: LEGACY_FLASH_NOTE },
	],
	// Retired 2026-09-14T04:00:00Z; served by V4.1 Flash at Flash rates.
	"deepseek-v4-pro": [
		{ rates: V4_PRO },
		{
			from: V4_PRO_RETIRED,
			rates: FLASH_V41,
			note: "V4 Pro retired, routed to V4.1 Flash",
		},
	],
};

function instantAt(at: number | Date): number {
	return typeof at === "number" ? at : at.getTime();
}

export function tierAt(at: number | Date): Tier {
	const date = new Date(instantAt(at));
	// Peak windows only apply Monday-Friday (getUTCDay(): Sun=0 … Sat=6); the
	// windows never cross midnight, so the timestamp's own day+hour suffice.
	if (date.getUTCDay() < 1 || date.getUTCDay() > 5) return "offPeak";
	return PEAK_HOURS_UTC.has(date.getUTCHours()) ? "peak" : "offPeak";
}

/**
 * The effective-dated period for `modelId` at `at`: the last period whose
 * `from` is at or before the instant, or the first (from-less) period.
 * Returns undefined for unknown or missing ids.
 */
export function periodAt(
	modelId: string | undefined,
	at: number | Date,
): RatePeriod | undefined {
	// Own-property check, not a truthy index lookup: ids like "constructor" or
	// "__proto__" would otherwise resolve to Object.prototype members and throw
	// in the loop below, silently disabling re-pricing.
	if (!modelId || !Object.hasOwn(SCHEDULES, modelId)) return undefined;
	const schedule = SCHEDULES[modelId];
	const ms = instantAt(at);
	// Periods are declared in ascending `from` order (only forward-looking
	// boundaries are encoded), so the last one already in effect is the active
	// one; the from-less first period is the fallback before any boundary.
	let active = schedule[0];
	for (const period of schedule) {
		if (period.from !== undefined && period.from <= ms) active = period;
	}
	return active;
}

/** The tier-selected rates for `modelId` at `at`, or undefined if unknown. */
export function ratesAt(
	modelId: string | undefined,
	at: number | Date,
): DeepSeekRates | undefined {
	return periodAt(modelId, at)?.rates[tierAt(at)];
}

/**
 * Recompute `usage.cost` with pi's per-token multiplication but the given
 * rates. DeepSeek has neither tiered rates nor 1h cache writes (pi's other
 * `calculateCost` branches), so the two agree field for field; neither rounds.
 */
export function reprice(usage: Usage, rates: DeepSeekRates): Usage["cost"] {
	const cost = {
		input: (rates.input / 1_000_000) * usage.input,
		output: (rates.output / 1_000_000) * usage.output,
		cacheRead: (rates.cacheRead / 1_000_000) * usage.cacheRead,
		cacheWrite: (rates.cacheWrite / 1_000_000) * usage.cacheWrite,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return cost;
}

/** Immutably re-price a message's usage at the given rates. */
function withCost(
	message: AssistantMessage,
	rates: DeepSeekRates,
): AssistantMessage {
	return {
		...message,
		usage: { ...message.usage, cost: reprice(message.usage, rates) },
	};
}

function isDeepSeekAssistant(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: unknown; provider?: unknown };
	return m.role === "assistant" && m.provider === "deepseek";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `deepseekPricingByTime` setting: a boolean, or `{ showTierStatus: boolean }`.
 * Returns undefined when unset, so the tier status stays enabled by default.
 */
function configuredShowTierStatus(ctx: ExtensionContext): boolean | undefined {
	const files = [
		ctx.isProjectTrusted()
			? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")
			: undefined,
		join(getAgentDir(), "settings.json"),
	];
	for (const file of files) {
		if (!file) continue;
		let settings: unknown;
		try {
			settings = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue; // missing or invalid settings file: try the next one
		}
		if (!isRecord(settings)) continue;
		const value = settings.deepseekPricingByTime;
		if (typeof value === "boolean") return value;
		if (isRecord(value) && typeof value.showTierStatus === "boolean") {
			return value.showTierStatus;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Re-price every DeepSeek assistant message with the effective-dated rates
	// and the tier in effect at the message's own timestamp.
	pi.on("message_end", (event: MessageEndEvent) => {
		const message = event.message;
		if (!isDeepSeekAssistant(message) || !message.usage) return;
		// A NaN timestamp must fall back too: new Date(NaN) reads as off-peak and
		// would silently halve the charge instead of failing loudly.
		const at = new Date(
			Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
		);
		// The echoed responseModel wins when it is a known id; otherwise fall back
		// to the requested model so an unknown alias cannot disable re-pricing.
		const rates =
			ratesAt(message.responseModel, at) ?? ratesAt(message.model, at);
		if (!rates) return;

		return { message: withCost(message, rates) };
	});

	// Footer status area, gated by the `deepseekPricingByTime` setting (see
	// configuredShowTierStatus).
	let lastStatus: string | undefined;
	const refreshStatus = (ctx: ExtensionContext) => {
		const status =
			(configuredShowTierStatus(ctx) ?? true)
				? tierAt(new Date()) === "peak"
					? "peak ⚠️"
					: "off-peak"
				: undefined;
		if (status === lastStatus) return;
		lastStatus = status;
		ctx.ui.setStatus("deepseek-tier", status);
	};

	pi.on("session_start", (_event, ctx) => refreshStatus(ctx));
	pi.on("turn_end", (_event, ctx) => refreshStatus(ctx));
	pi.on("model_select", (_event, ctx) => refreshStatus(ctx));

	pi.registerCommand("deepseek-tier", {
		description:
			"Show the currently active DeepSeek pricing tier (peak/off-peak) and its rates",
		handler: async (_args, ctx) => {
			const now = new Date();
			const tier = tierAt(now);
			const period = periodAt(ctx.model?.id, now);
			const r = period?.rates[tier];
			const rateText = r
				? ` input $${r.input}/M, output $${r.output}/M, cacheRead $${r.cacheRead}/M`
				: "";
			const noteText = period?.note ? ` [${period.note}]` : "";
			ctx.ui.notify(
				`DeepSeek tier: ${tier === "peak" ? "PEAK ⚠️" : "off-peak"} (UTC ${now.getUTCHours()}:00; peak 01-04 & 06-10 UTC Mon-Fri)${rateText}${noteText}`,
				tier === "peak" ? "warning" : "info",
			);
		},
	});
}
