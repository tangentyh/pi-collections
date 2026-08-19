import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEEPSEEK_BALANCE_CACHE_MS,
	DeepSeekBalanceError,
	fetchDeepSeekBalance,
	formatDeepSeekBalance,
	isDeepSeekProvider,
	resolveBalanceValue,
} from "./deepseek.js";
import { CURRENCIES, CURRENCY_LIST, getFxRates, readCostCurrency, refreshFxIfStale, writeCostCurrency } from "./currency.js";
import {
	DEFAULT_FOOTER_TEMPLATE,
	formatElapsedTime,
	formatTime,
	getFieldValues,
	renderRunNotification,
	renderTemplate,
} from "./format.js";
import { resolveFooterConfiguration } from "./io.js";
import type { RunStats, SessionUsage, UsageTotals } from "./types.js";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	return (message as { role?: unknown }).role === "assistant";
}

function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input || 0;
	totals.output += usage.output || 0;
	totals.cacheRead += usage.cacheRead || 0;
	totals.cacheWrite += usage.cacheWrite || 0;
	totals.totalTokens += usage.totalTokens || 0;
	totals.cost += usage.cost?.total || 0;
}

/** Match the built-in footer: cumulative usage includes every session entry. */
function computeSessionUsage(ctx: ExtensionContext): SessionUsage {
	const totals = createUsageTotals();
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				addUsage(totals, entry.message.usage);
				const promptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
			} else if (entry.message.role === "toolResult") {
				addUsage(totals, entry.message.usage);
			}
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addUsage(totals, entry.usage);
		}
	}

	return { totals, latestCacheHitRate };
}

function emptyRunStats(): RunStats {
	return {
		tokensPerSecond: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		elapsedTime: "0.0s",
		idleTime: "0.0s",
		time: "",
	};
}

function calculateRunStats(
	messages: readonly unknown[],
	elapsedMs: number,
	idleMs: number,
	endedAt: Date,
): RunStats | undefined {
	const usage = createUsageTotals();
	for (const message of messages) {
		if (isAssistantMessage(message)) addUsage(usage, message.usage);
	}
	if (usage.output <= 0 || elapsedMs <= 0) return undefined;

	const elapsedSeconds = elapsedMs / 1000;
	return {
		tokensPerSecond: usage.output / elapsedSeconds,
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: usage.cost,
		elapsedTime: formatElapsedTime(elapsedSeconds),
		idleTime: formatElapsedTime(idleMs / 1000),
		time: formatTime(endedAt),
	};
}

/** Render pi's footer from a configurable string template. */
export default function footerTemplate(pi: ExtensionAPI): void {
	let agentStartMs: number | null = null;
	let lastAgentEndMs: number | null = null;
	let idleTimeMs = 0;
	let runStats = emptyRunStats();
	let requestFooterRender: (() => void) | undefined;
	let customFooterInstalled = false;

	// DeepSeek account balance behind the {deepseekBalance} field. Refreshed
	// at most once per cache window (mirroring pi-deepseek-usage's 30s cache),
	// on session start, model selection, and after each turn; fetch errors are
	// not cached and render as `DeepSeek: <err:code>` until the next refresh.
	// The numeric value is kept alongside the rendered text so the balance can
	// be converted into the configured display currency.
	let deepseekBalance = "";
	let deepseekBalanceValue: { amount: number; currency: string } | undefined;
	let deepseekBalanceFreshUntil = 0;
	let deepseekBalanceFetching: Promise<void> | undefined;

	const refreshDeepseekBalance = (ctx: ExtensionContext): void => {
		if (!isDeepSeekProvider(ctx.model?.provider)) {
			if (deepseekBalance) {
				deepseekBalance = "";
				deepseekBalanceValue = undefined;
				requestFooterRender?.();
			}
			return;
		}
		const now = Date.now();
		if (now < deepseekBalanceFreshUntil || deepseekBalanceFetching) return;
		deepseekBalanceFetching = (async () => {
			try {
				const data = await fetchDeepSeekBalance(ctx.modelRegistry);
				// The provider may have changed while the request was in flight.
				if (!isDeepSeekProvider(ctx.model?.provider)) return;
				deepseekBalance = formatDeepSeekBalance(data);
				deepseekBalanceValue = resolveBalanceValue(data);
				deepseekBalanceFreshUntil = Date.now() + DEEPSEEK_BALANCE_CACHE_MS;
			} catch (error) {
				if (!isDeepSeekProvider(ctx.model?.provider)) return;
				const code = error instanceof DeepSeekBalanceError ? error.code : "fetch";
				deepseekBalance = `DeepSeek: <err:${code}>`;
				deepseekBalanceValue = undefined;
			} finally {
				deepseekBalanceFetching = undefined;
				requestFooterRender?.();
			}
		})();
	};

	// Session entries are append-only, and every usage-bearing append is
	// accompanied by a message_end, session_compact, or session_tree event. So
	// the cumulative totals can be cached and invalidated on those events,
	// instead of rescanning the whole session on every render (i.e. every
	// keystroke, resize, and setStatus). message_update intentionally does not
	// invalidate: streaming never touches session entries.
	let sessionUsageCache: SessionUsage | undefined;

	const getSessionUsage = (ctx: ExtensionContext): SessionUsage => {
		if (!sessionUsageCache) sessionUsageCache = computeSessionUsage(ctx);
		return sessionUsageCache;
	};

	pi.on("agent_start", () => {
		const now = performance.now();
		idleTimeMs = lastAgentEndMs === null ? 0 : Math.max(0, now - lastAgentEndMs);
		agentStartMs = now;
	});

	pi.on("agent_end", (event, ctx) => {
		const endedAtMs = performance.now();
		lastAgentEndMs = endedAtMs;
		if (agentStartMs === null) return;

		const elapsedMs = endedAtMs - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		const nextRunStats = calculateRunStats(event.messages, elapsedMs, idleTimeMs, new Date());
		if (!nextRunStats) return;
		runStats = nextRunStats;
		requestFooterRender?.();

		if (!ctx.hasUI) return;
		const configuration = resolveFooterConfiguration(ctx);
		// Like the footer template, an explicit empty notification template
		// opts out; only an unset one falls back to the default format.
		if (configuration.notificationTemplate === "") return;
		ctx.ui.notify(
			renderRunNotification(
				configuration.notificationTemplate,
				nextRunStats,
				readCostCurrency(),
				getFxRates(),
			),
			"info",
		);
	});

	// A custom footer is not automatically invalidated by every state change
	// that affects the built-in footer, so request a redraw for the dynamic
	// fields while keeping all values computed lazily in render().
	const requestRender = () => requestFooterRender?.();
	pi.on("message_update", requestRender);
	pi.on("session_info_changed", requestRender);
	pi.on("model_select", (_event, ctx) => {
		requestRender();
		refreshDeepseekBalance(ctx);
	});
	pi.on("thinking_level_select", requestRender);

	// Like pi-deepseek-usage, refresh the account balance after each turn.
	pi.on("turn_end", (_event, ctx) => {
		refreshDeepseekBalance(ctx);
	});

	const invalidateUsageCache = () => {
		sessionUsageCache = undefined;
	};
	pi.on("message_end", () => {
		invalidateUsageCache();
		requestRender();
	});
	pi.on("session_compact", () => {
		invalidateUsageCache();
		requestRender();
	});
	pi.on("session_tree", () => {
		invalidateUsageCache();
		requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		agentStartMs = null;
		lastAgentEndMs = performance.now();
		idleTimeMs = 0;
		runStats = emptyRunStats();
		requestFooterRender = undefined;
		sessionUsageCache = undefined;
		deepseekBalance = "";
		deepseekBalanceValue = undefined;
		deepseekBalanceFreshUntil = 0;
		deepseekBalanceFetching = undefined;
		if (ctx.mode !== "tui") return;

		const configuration = resolveFooterConfiguration(ctx);
		// No configured template falls back to the built-in-shaped default; an
		// explicit empty template opts out and keeps pi's built-in footer.
		const footerTemplate = configuration.template ?? DEFAULT_FOOTER_TEMPLATE;
		if (!footerTemplate) {
			if (customFooterInstalled) {
				ctx.ui.setFooter(undefined);
				customFooterInstalled = false;
			}
			return;
		}
		// Exchange rates for the configured display currency, fetched once per
		// 24h; USD needs none. The footer reads the currency and rates lazily
		// on every render, so a later /set-currency switch is picked up immediately.
		void refreshFxIfStale().then(() => requestFooterRender?.());

		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;
			const unsubscribeBranchChanges = footerData.onBranchChange(requestRender);

			return {
				invalidate() {},
				render(width: number): string[] {
					const fields = getFieldValues(
						ctx,
						footerData,
						getSessionUsage(ctx),
						runStats,
						{
							costCurrency: readCostCurrency(),
							fxRates: getFxRates(),
							autoCompactionEnabled: configuration.autoCompactionEnabled,
							deepseekBalance,
							deepseekBalanceValue,
						},
					);
					return renderTemplate(footerTemplate, fields, width, theme);
				},
				dispose() {
					unsubscribeBranchChanges();
					if (requestFooterRender === requestRender) requestFooterRender = undefined;
				},
			};
		});
		customFooterInstalled = true;
		refreshDeepseekBalance(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (customFooterInstalled) {
			ctx.ui.setFooter(undefined);
			customFooterInstalled = false;
		}
		agentStartMs = null;
		lastAgentEndMs = null;
		requestFooterRender = undefined;
		sessionUsageCache = undefined;
		deepseekBalance = "";
		deepseekBalanceValue = undefined;
		deepseekBalanceFreshUntil = 0;
		deepseekBalanceFetching = undefined;
	});

	pi.registerCommand("set-currency", {
		description:
			"Currency for cost and DeepSeek balance: /set-currency <code> = set; no args = show",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim().toUpperCase();
			return Object.keys(CURRENCIES)
				.filter((ccy) => ccy.startsWith(needle))
				.map((ccy) => ({
					value: ccy,
					label: ccy,
					description: `${CURRENCIES[ccy].symbol} (${ccy === "USD" ? "default" : "converted via daily FX"})`,
				}));
		},
		handler: async (args, ctx) => {
			const ccy = args.trim().toUpperCase();
			if (!ccy) {
				const current = readCostCurrency();
				ctx.ui.notify(
					`Currency: ${current} (${CURRENCIES[current]?.symbol ?? "$"}). Available: ${CURRENCY_LIST}`,
					"info",
				);
				return;
			}
			if (!CURRENCIES[ccy]) {
				ctx.ui.notify(`Invalid currency: "${ccy}". Available: ${CURRENCY_LIST}`, "error");
				return;
			}
			writeCostCurrency(ccy);
			requestFooterRender?.();
			// Kick off a rate fetch so the new currency converts right away;
			// the footer picks the rates up when the fetch completes.
			void refreshFxIfStale().then(() => requestFooterRender?.());
			ctx.ui.notify(
				`Currency: ${ccy} (${CURRENCIES[ccy].symbol}). Cost and DeepSeek balance are now shown in ${ccy}.`,
				"info",
			);
		},
	});
}
