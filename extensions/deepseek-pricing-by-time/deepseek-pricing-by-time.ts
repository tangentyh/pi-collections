import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

// DeepSeek official USD pricing (https://api-docs.deepseek.com/quick_start/pricing)
// Peak hours: 01:00-04:00 & 06:00-10:00 UTC (09:00-12:00 & 14:00-18:00 Beijing time).
// Off-peak rates are exactly half of peak. DeepSeek does not charge for cache writes.
//
// pi's built-in cost display is static: it applies whatever rates are in the model
// metadata (models.json) to every message. This extension corrects that after the
// fact — at `message_end` it re-prices each DeepSeek assistant message with the
// peak/off-peak rate that was in effect at the message's own timestamp, so session
// totals, the footer, the statusline `cost` segment, and exports all reflect the
// amount DeepSeek actually bills.

interface DeepSeekRates {
	/** Cache-miss input, USD per 1M tokens. */
	input: number;
	/** Output, USD per 1M tokens. */
	output: number;
	/** Cache-hit input, USD per 1M tokens. */
	cacheRead: number;
	/** Cache write, USD per 1M tokens. */
	cacheWrite: number;
}

type Tier = "peak" | "offPeak";

/** UTC hours inside a peak window: [01:00, 04:00) and [06:00, 10:00). */
const PEAK_HOURS_UTC = new Set([1, 2, 3, 6, 7, 8, 9]);

const RATES: Record<string, { peak: DeepSeekRates; offPeak: DeepSeekRates }> = {
	"deepseek-v4-flash": {
		peak: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
		offPeak: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
	},
	"deepseek-v4-pro": {
		peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
		offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
	},
};

function tierAt(date: Date): Tier {
	return PEAK_HOURS_UTC.has(date.getUTCHours()) ? "peak" : "offPeak";
}

/** Recompute usage.cost exactly like pi's calculateCost but with the given rates. */
function reprice(usage: Usage, rates: DeepSeekRates): Usage["cost"] {
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

/** message_end replacement with the given rates applied to the message's usage. */
function withCost(message: AssistantMessage, rates: DeepSeekRates): { message: AssistantMessage } {
	return {
		message: {
			...message,
			usage: { ...message.usage, cost: reprice(message.usage, rates) },
		},
	};
}

function isDeepSeekAssistant(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: unknown; provider?: unknown };
	return m.role === "assistant" && m.provider === "deepseek";
}

export default function (pi: ExtensionAPI) {
	// Re-price every DeepSeek assistant message with the rate tier in effect at
	// the message's own timestamp. Session totals, footer, statusline and exports
	// all derive from per-message usage.cost, so correcting here fixes everything.
	pi.on("message_end", (event: MessageEndEvent) => {
		const message = event.message;
		if (!isDeepSeekAssistant(message) || !message.usage) return;
		const rates = RATES[message.responseModel ?? message.model];
		if (!rates) return;

		return withCost(message, rates[tierAt(new Date(message.timestamp ?? Date.now()))]);
	});

	// Surface the currently active tier in the footer status area, updating only
	// when the tier actually flips.
	let lastTier: Tier | undefined;
	const refreshStatus = (ctx: ExtensionContext) => {
		const tier = tierAt(new Date());
		if (tier === lastTier) return;
		lastTier = tier;
		ctx.ui.setStatus(
			"deepseek-tier",
			tier === "peak" ? "deepseek: peak rates ⚠️" : "deepseek: off-peak rates",
		);
	};

	pi.on("session_start", (_event, ctx) => refreshStatus(ctx));
	pi.on("turn_end", (_event, ctx) => refreshStatus(ctx));
	pi.on("model_select", (_event, ctx) => refreshStatus(ctx));

	pi.registerCommand("deepseek-tier", {
		description: "Show the currently active DeepSeek pricing tier (peak/off-peak) and its rates",
		handler: async (_args, ctx) => {
			const now = new Date();
			const tier = tierAt(now);
			const rates = ctx.model ? RATES[ctx.model.id] : undefined;
			const r = rates?.[tier];
			const rateText = r
				? ` input $${r.input}/M, output $${r.output}/M, cacheRead $${r.cacheRead}/M`
				: "";
			ctx.ui.notify(
				`DeepSeek tier: ${tier === "peak" ? "PEAK ⚠️" : "off-peak"} (UTC ${now.getUTCHours()}:00; peak 01-04 & 06-10 UTC)${rateText}`,
				tier === "peak" ? "warning" : "info",
			);
		},
	});
}
