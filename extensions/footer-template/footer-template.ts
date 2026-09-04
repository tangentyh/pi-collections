import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BalanceValue } from "./balance.js";
import {
	BALANCE_CACHE_MS,
	BALANCE_PROVIDERS,
	BalanceError,
	fetchBalance,
	formatBalanceText,
	resolveBalanceProvider,
} from "./balance.js";
import {
	AUTO_CURRENCY,
	CURRENCIES,
	CURRENCY_LIST,
	getFxRates,
	refreshFxIfStale,
	resolveDisplayCurrency,
} from "./currency.js";
import {
	DEFAULT_FOOTER_TEMPLATE,
	formatElapsedTime,
	formatTime,
	getFieldValues,
	renderRunNotification,
	renderTemplate,
} from "./format.js";
import { resolveFooterConfiguration, writeGlobalCostCurrency } from "./io.js";
import type { QuotaValue } from "./quota.js";
import {
	fetchQuota,
	formatQuotaText,
	QUOTA_CACHE_MS,
	QUOTA_PROVIDERS,
	QuotaError,
	resolveQuotaProvider,
} from "./quota.js";
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
					entry.message.usage.input +
					entry.message.usage.cacheRead +
					entry.message.usage.cacheWrite;
				latestCacheHitRate =
					promptTokens > 0
						? (entry.message.usage.cacheRead / promptTokens) * 100
						: undefined;
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
	// Display currency from settings; mutable so /set-currency applies live.
	let activeCurrency = AUTO_CURRENCY;

	// Account balance behind {balanceLabel}/{balanceStatus}; providers listed
	// in BALANCE_PROVIDERS (balance.ts). Refreshed at most once per cache
	// window on session start, model selection, and turn end; fetch errors
	// are not cached and render as `<Label>: <err:code>` until the next
	// refresh. The numeric value rides along for currency conversion.
	let balanceText = "";
	let balanceValue: BalanceValue | undefined;
	let balanceProvider: string | undefined;
	let balanceFreshUntil = 0;
	let balanceFetching: Promise<void> | undefined;
	let balanceFetchSeq = 0;
	// First successfully fetched balance per provider in this session,
	// backing {balanceDelta} (sign semantics: see formatBalanceDeltaField);
	// cleared on session start/shutdown.
	const firstBalances = new Map<string, BalanceValue>();
	// Tracked synchronously from live event ctxs (see activeQuotaProvider).
	let activeBalanceProvider: string | undefined;

	// Provider quota status behind the same fields for the OAuth subscription
	// providers (openai-codex, anthropic), mirroring pi-fancy-footer's
	// provider-status widget and pi-usage; rendering details live in quota.ts.
	// Only fetched while the active model uses OAuth (API-key models have no
	// subscription quota), under the same fetch/cache/error policy as the
	// balance above.
	let quotaText = "";
	let quotaValue: QuotaValue | undefined;
	let quotaProvider: string | undefined;
	let quotaFreshUntil = 0;
	let quotaFetching: Promise<void> | undefined;
	let quotaFetchSeq = 0;
	// Provider of the currently active OAuth model, tracked synchronously from
	// live event ctxs. In-flight fetch completions must compare against this
	// instead of the captured ctx: after a session replacement or reload the
	// captured ctx is stale and reading any of its getters throws.
	let activeQuotaProvider: string | undefined;

	const refreshQuota = (ctx: ExtensionContext): void => {
		const provider = resolveQuotaProvider(ctx.model?.provider);
		const usingOAuth =
			!!ctx.model && (ctx.modelRegistry.isUsingOAuth(ctx.model) ?? false);
		// Capture the registry synchronously: reading event-ctx getters after a
		// replacement/reload throws.
		const modelRegistry = ctx.modelRegistry;
		if (!provider || !usingOAuth) {
			activeQuotaProvider = undefined;
			if (quotaText || quotaValue) {
				quotaText = "";
				quotaValue = undefined;
				quotaProvider = undefined;
				requestFooterRender?.();
			}
			return;
		}
		activeQuotaProvider = provider;
		const now = Date.now();
		// A provider switch clears stale fields immediately.
		if (quotaProvider !== undefined && quotaProvider !== provider) {
			quotaText = "";
			quotaValue = undefined;
			quotaProvider = undefined;
			quotaFreshUntil = 0;
			requestFooterRender?.();
		}
		// Skip when this provider's data is still fresh or in flight.
		if (quotaProvider === provider && (now < quotaFreshUntil || quotaFetching))
			return;
		const label = QUOTA_PROVIDERS[provider].label;
		// Sequence token: superseded requests must not clear their
		// replacement's in-flight flag.
		const seq = ++quotaFetchSeq;
		const fetching = (async () => {
			try {
				const value = await fetchQuota(provider, modelRegistry);
				// Discard superseded results (provider/auth may have changed
				// mid-fetch); the captured ctx is never read here.
				if (activeQuotaProvider !== provider) return;
				quotaText = formatQuotaText(label, value);
				quotaValue = value;
				quotaProvider = provider;
				quotaFreshUntil = Date.now() + QUOTA_CACHE_MS;
			} catch (error) {
				if (activeQuotaProvider !== provider) return;
				const code = error instanceof QuotaError ? error.code : "fetch";
				quotaText = `${label}: <err:${code}>`;
				quotaValue = undefined;
				quotaProvider = provider;
				quotaFreshUntil = 0;
			} finally {
				if (seq === quotaFetchSeq) quotaFetching = undefined;
				requestFooterRender?.();
			}
		})();
		quotaFetching = fetching;
	};

	const refreshBalance = (ctx: ExtensionContext): void => {
		const provider = resolveBalanceProvider(ctx.model?.provider);
		// Capture the registry synchronously: reading event-ctx getters after a
		// replacement/reload throws.
		const modelRegistry = ctx.modelRegistry;
		if (!provider) {
			activeBalanceProvider = undefined;
			if (balanceText) {
				balanceText = "";
				balanceValue = undefined;
				balanceProvider = undefined;
				requestFooterRender?.();
			}
			return;
		}
		activeBalanceProvider = provider;
		const now = Date.now();
		// A provider switch invalidates the cache: refetch immediately.
		if (
			balanceProvider === provider &&
			(now < balanceFreshUntil || balanceFetching)
		)
			return;
		const label = BALANCE_PROVIDERS[provider].label;
		// Sequence token: superseded requests must not clear their
		// replacement's in-flight flag.
		const seq = ++balanceFetchSeq;
		const fetching = (async () => {
			try {
				const value = await fetchBalance(provider, modelRegistry);
				// Discard superseded results (provider may have changed mid-fetch).
				if (activeBalanceProvider !== provider) return;
				if (value && !firstBalances.has(provider))
					firstBalances.set(provider, value);
				balanceText = formatBalanceText(label, value);
				balanceValue = value ?? undefined;
				balanceProvider = provider;
				balanceFreshUntil = Date.now() + BALANCE_CACHE_MS;
			} catch (error) {
				if (activeBalanceProvider !== provider) return;
				const code = error instanceof BalanceError ? error.code : "fetch";
				balanceText = `${label}: <err:${code}>`;
				balanceValue = undefined;
			} finally {
				if (seq === balanceFetchSeq) balanceFetching = undefined;
				requestFooterRender?.();
			}
		})();
		balanceFetching = fetching;
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
		idleTimeMs =
			lastAgentEndMs === null ? 0 : Math.max(0, now - lastAgentEndMs);
		agentStartMs = now;
	});

	pi.on("agent_end", (event, ctx) => {
		const endedAtMs = performance.now();
		lastAgentEndMs = endedAtMs;
		if (agentStartMs === null) return;

		const elapsedMs = endedAtMs - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		const nextRunStats = calculateRunStats(
			event.messages,
			elapsedMs,
			idleTimeMs,
			new Date(),
		);
		if (!nextRunStats) return;
		runStats = nextRunStats;
		requestFooterRender?.();

		if (!ctx.hasUI) return;
		const configuration = resolveFooterConfiguration(ctx);
		activeCurrency = configuration.costCurrency;
		// An explicitly empty notification template opts out; unset falls
		// back to the default format.
		if (configuration.notificationTemplate === "") return;
		ctx.ui.notify(
			renderRunNotification(
				configuration.notificationTemplate,
				nextRunStats,
				resolveDisplayCurrency(activeCurrency, ctx.model?.provider),
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
		refreshBalance(ctx);
		refreshQuota(ctx);
	});
	pi.on("thinking_level_select", requestRender);

	pi.on("turn_end", (_event, ctx) => {
		refreshBalance(ctx);
		refreshQuota(ctx);
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
		balanceText = "";
		balanceValue = undefined;
		balanceProvider = undefined;
		balanceFreshUntil = 0;
		balanceFetching = undefined;
		activeBalanceProvider = undefined;
		firstBalances.clear();
		quotaText = "";
		quotaValue = undefined;
		quotaProvider = undefined;
		quotaFreshUntil = 0;
		quotaFetching = undefined;
		activeQuotaProvider = undefined;
		if (ctx.mode !== "tui") return;

		const configuration = resolveFooterConfiguration(ctx);
		activeCurrency = configuration.costCurrency;
		// Unset falls back to the built-in-shaped default; "" opts out to pi's
		// built-in footer.
		const footerTemplate = configuration.template ?? DEFAULT_FOOTER_TEMPLATE;
		if (!footerTemplate) {
			if (customFooterInstalled) {
				ctx.ui.setFooter(undefined);
				customFooterInstalled = false;
			}
			return;
		}
		// Exchange rates for the configured display currency, fetched once per
		// 24h; USD needs none. Read lazily per render, so later /set-currency
		// switches pick up automatically.
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
							costCurrency: activeCurrency,
							fxRates: getFxRates(),
							autoCompactionEnabled: configuration.autoCompactionEnabled,
							balanceText,
							balanceValue,
							balanceProvider,
							firstBalances,
							quotaText,
							quotaValue,
							quotaProvider,
						},
					);
					return renderTemplate(footerTemplate, fields, width, theme);
				},
				dispose() {
					unsubscribeBranchChanges();
					if (requestFooterRender === requestRender)
						requestFooterRender = undefined;
				},
			};
		});
		customFooterInstalled = true;
		refreshBalance(ctx);
		refreshQuota(ctx);
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
		balanceText = "";
		balanceValue = undefined;
		balanceProvider = undefined;
		balanceFreshUntil = 0;
		balanceFetching = undefined;
		activeBalanceProvider = undefined;
		firstBalances.clear();
		quotaText = "";
		quotaValue = undefined;
		quotaProvider = undefined;
		quotaFreshUntil = 0;
		quotaFetching = undefined;
		activeQuotaProvider = undefined;
	});

	pi.registerCommand("set-currency", {
		description:
			"Currency for cost and DeepSeek balance: /set-currency <code> = set; no args = show",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim().toUpperCase();
			return [
				{
					value: AUTO_CURRENCY,
					label: AUTO_CURRENCY,
					description:
						"provider-based: CNY for Chinese providers (deepseek, siliconflow, ...), USD otherwise (default)",
				},
				...Object.keys(CURRENCIES).map((ccy) => ({
					value: ccy,
					label: ccy,
					description: `${CURRENCIES[ccy].symbol} (${ccy === "USD" ? "no FX needed" : "converted via daily FX"})`,
				})),
			].filter((c) => c.value.toUpperCase().startsWith(needle));
		},
		handler: async (args, ctx) => {
			const ccy = args.trim().toUpperCase();
			if (!ccy) {
				const current =
					activeCurrency === AUTO_CURRENCY
						? `auto (${resolveDisplayCurrency(activeCurrency, ctx.model?.provider)} for ${ctx.model?.provider ?? "the active provider"})`
						: `${activeCurrency} (${CURRENCIES[activeCurrency].symbol})`;
				ctx.ui.notify(
					`Currency: ${current}. Available: AUTO (provider-based) + ${CURRENCY_LIST}`,
					"info",
				);
				return;
			}
			if (ccy !== "AUTO" && !CURRENCIES[ccy]) {
				ctx.ui.notify(
					`Invalid currency: "${ccy}". Use AUTO or one of: ${CURRENCY_LIST}`,
					"error",
				);
				return;
			}
			writeGlobalCostCurrency(ccy === "AUTO" ? AUTO_CURRENCY : ccy);
			// Re-resolve after persisting: a project-level `costCurrency` may
			// shadow the global value via the settings merge.
			activeCurrency = resolveFooterConfiguration(ctx).costCurrency;
			requestFooterRender?.();
			// Prime the rate table so the effective currency converts right away.
			void refreshFxIfStale().then(() => requestFooterRender?.());
			if (activeCurrency === AUTO_CURRENCY) {
				ctx.ui.notify(
					`Currency: auto — CNY for Chinese providers (deepseek, moonshotai-cn, siliconflow, zai-coding-cn, zai-api-cn), USD otherwise.`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`Currency: ${activeCurrency} (${CURRENCIES[activeCurrency].symbol}). Cost and account balances are now shown in ${activeCurrency}.`,
					"info",
				);
			}
		},
	});
}
