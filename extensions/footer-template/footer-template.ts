import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BALANCE_CACHE_MS,
	BALANCE_PROVIDERS,
	BalanceError,
	fetchBalance,
	formatBalanceText,
	resolveBalanceProvider,
} from "./balance.js";
import type { BalanceValue } from "./balance.js";
import {
	QUOTA_CACHE_MS,
	QUOTA_PROVIDERS,
	QuotaError,
	fetchQuota,
	formatQuotaText,
	resolveQuotaProvider,
} from "./quota.js";
import type { QuotaValue } from "./quota.js";
import { AUTO_CURRENCY, CURRENCIES, CURRENCY_LIST, getFxRates, refreshFxIfStale, resolveDisplayCurrency } from "./currency.js";
import {
	DEFAULT_FOOTER_TEMPLATE,
	formatElapsedTime,
	formatTime,
	getFieldValues,
	renderRunNotification,
	renderTemplate,
} from "./format.js";
import { resolveFooterConfiguration, writeGlobalCostCurrency } from "./io.js";
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
	// Display currency from settings (`footerTemplate.costCurrency`): a
	// concrete code or "auto" (the default, resolving per provider); kept
	// mutable so /set-currency applies without reloading pi.
	let activeCurrency = AUTO_CURRENCY;

	// Account balance behind the {balanceLabel}/{balanceStatus} fields.
	// Supported providers mirror
	// pi-tidy-footer:
	// deepseek, moonshotai-cn, openrouter, siliconflow, zhipu. Refreshed at most
	// once per cache window (mirroring pi-deepseek-usage's 30s cache), on
	// session start, model selection, and after each turn; fetch errors are
	// not cached and render as `<Label>: <err:code>` until the next refresh.
	// The numeric value is kept alongside the rendered text so the balance can
	// be converted into the configured display currency.
	let balanceText = "";
	let balanceValue: BalanceValue | undefined;
	let balanceProvider: string | undefined;
	let balanceFreshUntil = 0;
	let balanceFetching: Promise<void> | undefined;
	let balanceFetchSeq = 0;
	// Provider of the currently active model, tracked synchronously from live
	// event ctxs (see activeQuotaProvider).
	let activeBalanceProvider: string | undefined;

	// Provider quota status behind the {balanceLabel}/{balanceStatus} fields
	// for the OAuth
	// subscription providers (openai-codex, anthropic), mirroring
	// pi-fancy-footer's provider-status widget and pi-usage: the rolling quota
	// windows render as `<Label>: 5h:23% used 7d:41% used` (compact status) with
	// a reset countdown for windows at or above 75% used; the default template
	// renders the structured breakdown fields ({quota5hUsed}, {quota7dUsed},
	// {creditsRemaining}, ...) instead, with {balanceStatus} empty while quota
	// data is available. Quota is only fetched while the active
	// model uses OAuth (API-key models have no subscription quota). Refreshed
	// at most once per cache window (3 min, like pi-usage) on the same events
	// as the balance; fetch errors are not cached and render as
	// `<Label>: <err:code>` until the next refresh.
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
		// Synchronous only: the event ctx is live right now; capture the
		// registry too, so nothing reads the ctx after an await below.
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
		// A provider switch invalidates the old value immediately so a stale
		// provider's fields are never shown while the replacement is fetched.
		if (quotaProvider !== undefined && quotaProvider !== provider) {
			quotaText = "";
			quotaValue = undefined;
			quotaProvider = undefined;
			quotaFreshUntil = 0;
			requestFooterRender?.();
		}
		// A provider switch invalidates the cache: refetch immediately.
		if (quotaProvider === provider && (now < quotaFreshUntil || quotaFetching)) return;
		const label = QUOTA_PROVIDERS[provider].label;
		// The sequence token guards the finally-block: when the provider
		// switches mid-fetch, the superseded request must not clear the
		// in-flight flag of its replacement.
		const seq = ++quotaFetchSeq;
		const fetching = (async () => {
			try {
				const value = await fetchQuota(provider, modelRegistry);
				// The provider or its auth may have changed while the request
				// was in flight; an API-key model switch also retires the quota
				// (it clears activeQuotaProvider). The captured ctx is never
				// read here.
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
		// Synchronous only: the event ctx is live right now; capture the
		// registry too, so nothing reads the ctx after an await below.
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
		if (balanceProvider === provider && (now < balanceFreshUntil || balanceFetching)) return;
		const label = BALANCE_PROVIDERS[provider].label;
		// The sequence token guards the finally-block: when the provider
		// switches mid-fetch, the superseded request must not clear the
		// in-flight flag of its replacement.
		const seq = ++balanceFetchSeq;
		const fetching = (async () => {
			try {
				const value = await fetchBalance(provider, modelRegistry);
				// The provider may have changed while the request was in
				// flight; the captured ctx is never read here (it may be
				// stale after a session replacement or reload).
				if (activeBalanceProvider !== provider) return;
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
		activeCurrency = configuration.costCurrency;
		// Like the footer template, an explicit empty notification template
		// opts out; only an unset one falls back to the default format.
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

	// Like pi-deepseek-usage, refresh the account balance after each turn;
	// the provider quota status refreshes on the same cadence.
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
		quotaText = "";
		quotaValue = undefined;
		quotaProvider = undefined;
		quotaFreshUntil = 0;
		quotaFetching = undefined;
		activeQuotaProvider = undefined;
		if (ctx.mode !== "tui") return;

		const configuration = resolveFooterConfiguration(ctx);
		activeCurrency = configuration.costCurrency;
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
							costCurrency: activeCurrency,
							fxRates: getFxRates(),
							autoCompactionEnabled: configuration.autoCompactionEnabled,
							balanceText,
							balanceValue,
							balanceProvider,
							quotaText,
							quotaValue,
							quotaProvider,
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
				ctx.ui.notify(`Invalid currency: "${ccy}". Use AUTO or one of: ${CURRENCY_LIST}`, "error");
				return;
			}
			// Persist in global settings; a project-level `costCurrency` shadows
			// the global value via the settings merge, so re-resolve to report
			// the effective currency.
			writeGlobalCostCurrency(ccy === "AUTO" ? AUTO_CURRENCY : ccy);
			activeCurrency = resolveFooterConfiguration(ctx).costCurrency;
			requestFooterRender?.();
			// Kick off a rate fetch so the effective currency converts right
			// away; the footer picks the rates up when the fetch completes.
			void refreshFxIfStale().then(() => requestFooterRender?.());
			if (activeCurrency === AUTO_CURRENCY) {
				ctx.ui.notify(
					`Currency: auto — CNY for Chinese providers (deepseek, moonshotai-cn, siliconflow, zhipu), USD otherwise.`,
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
