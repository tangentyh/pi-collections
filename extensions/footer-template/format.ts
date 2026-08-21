import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BALANCE_PROVIDERS, currencySymbol } from "./balance.js";
import type { BalanceValue } from "./balance.js";
import { AUTO_CURRENCY, CURRENCIES, ccyRate, formatCost, resolveAutoCurrency } from "./currency.js";
import { getQuotaTemplateFields, QUOTA_PROVIDERS } from "./quota.js";
import type { QuotaValue } from "./quota.js";
import type { RunStats, SessionUsage, UsageTotals } from "./types.js";

const FIELD_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)(?::right)?\}/g;
// Square-bracketed sections are omitted when all contained fields are empty.
// A group directly followed by ":right" is preserved so it can be located as
// a single right-aligned unit (groups cannot nest).
const OPTIONAL_GROUP_PATTERN = /\[([^\[\]\r\n]*)\](?!:right)/g;
// A right-aligned unit: a {field} or an optional section [ ... ], each
// followed by ":right".
const RIGHT_ALIGN_PATTERN = /(?:\{([A-Za-z][A-Za-z0-9_]*)\}|\[([^\[\]\r\n]*)\]):right/;

export function formatElapsedTime(elapsedSeconds: number): string {
	const secondsValue = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
	if (secondsValue < 60) return `${secondsValue.toFixed(1)}s`;

	const totalSeconds = Math.floor(secondsValue);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${seconds}s`;

	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m${seconds}s`;
}

/** The compact token format used by pi's built-in footer. */
export function formatTokens(count: number): string {
	const value = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	if (value < 1000) return value.toString();
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

export function formatCount(count: number): string {
	return (Number.isFinite(count) ? Math.max(0, count) : 0).toLocaleString();
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	// Keep ANSI styling from ctx.ui.setStatus(), matching pi's built-in footer.
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function formatExtensionStatuses(footerData: ReadonlyFooterDataProvider): string {
	return Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter(Boolean)
		.join(" ");
}

/** Wall-clock time in 24-hour HH:MM:SS (local time). */
export function formatTime(date: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Fields describing the most recent completed agent run; `cost` is converted to the display currency. */
export function getRunStatsFields(
	stats: RunStats,
	costCurrency: string,
	fxRates: Record<string, number> | null,
): Record<string, string> {
	return {
		tokensPerSecond: stats.tokensPerSecond.toFixed(1),
		cost: formatCost(stats.cost, costCurrency, fxRates),
		input: formatCount(stats.input),
		output: formatCount(stats.output),
		cacheRead: formatCount(stats.cacheRead),
		cacheWrite: formatCount(stats.cacheWrite),
		totalTokens: formatCount(stats.totalTokens),
		elapsedTime: stats.elapsedTime,
		idleTime: stats.idleTime,
		time: stats.time,
	};
}

/**
 * The `{balanceStatus}` value: the reported balance converted to the configured
 * display currency, e.g. `DeepSeek: €15.23`. When the conversion is not
 * possible (no cached rate for a non-USD display currency), the balance
 * falls back to its native currency formatting (`fallback`). The amount is
 * always shown with two decimals, keeping the documented format. OAuth quota
 * providers (Codex, Claude) have no monetary balance; their quota status is
 * rendered from the structured breakdown fields below, while `{balanceStatus}`
 * only carries their error or `No quota` text.
 */
function formatBalanceField(
	label: string,
	value: { amount: number; currency: string },
	costCurrency: string,
	fxRates: Record<string, number> | null | undefined,
	fallback: string,
): string {
	const info = CURRENCIES[costCurrency] ?? CURRENCIES.USD;
	const rate = ccyRate(costCurrency, fxRates);
	if (rate === undefined) return fallback;
	if (value.currency === costCurrency) {
		return `${label}: ${info.symbol}${value.amount.toFixed(2)}`;
	}
	const sourceRate = ccyRate(value.currency, fxRates);
	if (sourceRate === undefined) return fallback;
	return `${label}: ${info.symbol}${((value.amount / sourceRate) * rate).toFixed(2)}`;
}

/**
 * The `{balanceDelta}` value: first balance fetched minus the current
 * balance, always signed and converted to the configured display currency
 * like `{balanceStatus}` — `+$0.15` means the balance went down by $0.15
 * since the first fetch (money spent), `-$10.00` means it went up (e.g. a
 * top-up). Empty when the active provider has no recorded baseline or no
 * balance, when the baseline's currency differs from the current balance's,
 * or when the delta rounds to zero. When the conversion is not possible
 * (no cached rate), the delta falls back to its native currency formatting,
 * like the balance amount.
 */
function formatBalanceDeltaField(
	first: BalanceValue | undefined,
	current: BalanceValue | undefined,
	costCurrency: string,
	fxRates: Record<string, number> | null | undefined,
): string {
	if (!first || !current || first.currency !== current.currency) return "";
	const delta = first.amount - current.amount;
	const info = CURRENCIES[costCurrency] ?? CURRENCIES.USD;
	let converted = delta;
	let displayCurrency = first.currency;
	if (first.currency !== costCurrency) {
		const rate = ccyRate(costCurrency, fxRates);
		const sourceRate = ccyRate(first.currency, fxRates);
		if (rate !== undefined && sourceRate !== undefined) {
			converted = (delta / sourceRate) * rate;
			displayCurrency = costCurrency;
		}
	}
	const rounded = Math.round(converted * 100) / 100;
	if (rounded === 0) return "";
	const abs = Math.abs(rounded).toFixed(2);
	const symbol =
		displayCurrency === costCurrency ? info.symbol : currencySymbol(displayCurrency);
	return rounded < 0 ? `-${symbol}${abs}` : `+${symbol}${abs}`;
}

/**
 * Whether the active model's usage is backed by a subscription, mirroring
 * pi's built-in footer: Kimi Coding is subscription-backed despite using
 * API-key authentication, and OAuth providers advertise subscription backing
 * through their OAuth auth definition.
 */
function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (model.provider === "kimi-coding") return true;
	try {
		return (
			ctx.modelRegistry.isUsingOAuth(model) &&
			ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true
		);
	} catch {
		return false;
	}
}

/** Options controlling currency conversion and balance rendering of the fields. */
export interface FooterFieldOptions {
	/** The configured display currency: a `CURRENCIES` key, or `auto` to resolve per provider (CNY for Chinese providers, USD otherwise). */
	costCurrency: string;
	/** The cached USD-based exchange-rate table, or null when unavailable. */
	fxRates: Record<string, number> | null;
	/** Whether auto-compaction is enabled (`{autoCompaction}` marker). */
	autoCompactionEnabled: boolean;
	/** `{balanceStatus}` value: "", "<err:...>", or "No balance". */
	balanceText: string;
	/** The numeric balance and its source currency, when available. */
	balanceValue: { amount: number; currency: string } | undefined;
	/** The provider key the balance belongs to (e.g. "deepseek", "openrouter"). */
	balanceProvider: string | undefined;
	/**
	 * The first successfully fetched balance per provider in the current
	 * session, backing the `{balanceDelta}` field (first − current; see
	 * formatBalanceDeltaField). Empty for providers whose balance never
	 * fetched successfully.
	 */
	firstBalances: ReadonlyMap<string, BalanceValue>;
	/**
	 * Provider quota status for OAuth subscription providers (Codex, Claude):
	 * "", "<Label>: 5h:23% used 7d:41% used", or "<Label>: <err:...>".
	 * Non-empty only while the active model's provider reports quota windows;
	 * it takes precedence over the monetary balance in `{balanceLabel}`.
	 * While quota data is available, `{balanceStatus}` stays empty and the
	 * breakdown fields render the windows instead.
	 */
	quotaText: string;
	/** The structured quota data behind the explicit quota template fields. */
	quotaValue: QuotaValue | undefined;
	/** The provider key the quota status belongs to (e.g. "openai-codex", "anthropic"). */
	quotaProvider: string | undefined;
}

export function getFieldValues(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	sessionUsage: SessionUsage,
	runStats: RunStats,
	options: FooterFieldOptions,
): Record<string, string> {
	const { totals, latestCacheHitRate } = sessionUsage;
	const model = ctx.model;
	// `auto` resolves per provider: CNY for the extension's Chinese providers
	// (deepseek, moonshotai-cn, siliconflow, zhipu), USD for everyone else.
	const costCurrency =
		options.costCurrency === AUTO_CURRENCY
			? resolveAutoCurrency(model?.provider)
			: options.costCurrency;
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const rawPercent = contextUsage?.percent;
	const percent = rawPercent === null ? "?" : (rawPercent ?? 0).toFixed(1);
	// The absolute token count behind the usage percentage (the exact
	// estimateContextTokens result, not derived from the rounded percent),
	// or empty when the estimate is unknown (or no model context is available).
	const contextUsageTokens = contextUsage?.tokens;
	const contextTokens =
		contextUsageTokens === null || contextUsageTokens === undefined ? "" : formatCount(contextUsageTokens);
	const usingSubscription = isUsingSubscription(ctx);
	const branch = footerData.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName();

	// The composite balance text, e.g. `DeepSeek: $17.35`: quota status wins
	// over the monetary balance. OAuth subscription providers (Codex, Claude)
	// have no monetary balance; their quota status replaces the balance value
	// for them. The label is only exposed while a status exists, so the
	// template's `[{balanceLabel}: ...]` section disappears entirely when
	// there is nothing to show.
	const balanceProviderLabel = options.balanceProvider
		? (BALANCE_PROVIDERS[options.balanceProvider]?.label ?? options.balanceProvider)
		: "";
	const firstBalance = options.balanceProvider
		? options.firstBalances.get(options.balanceProvider)
		: undefined;
	const quotaProviderLabel = options.quotaProvider
		? (QUOTA_PROVIDERS[options.quotaProvider]?.label ?? options.quotaProvider)
		: "";
	const compositeBalance = options.quotaText
		? options.quotaText
		: options.balanceValue && balanceProviderLabel
			? formatBalanceField(
					balanceProviderLabel,
					options.balanceValue,
					costCurrency,
					options.fxRates,
					options.balanceText,
				)
			: options.balanceText;
	const balanceLabel = compositeBalance
		? (options.quotaText ? quotaProviderLabel : balanceProviderLabel)
		: "";
	// The structured breakdown fields render the healthy quota status in the
	// default template, so {balanceStatus} stays empty while quota data is
	// available; only the error/`No quota` text (there is no data to break
	// down) and the monetary balance render through it.
	const quotaBreakdownShown = !!options.quotaText && !!options.quotaValue;
	const balanceStatus =
		compositeBalance && !quotaBreakdownShown
			? compositeBalance.startsWith(`${balanceLabel}: `)
				? compositeBalance.slice(balanceLabel.length + 2)
				: compositeBalance
			: "";
	const quotaFields = getQuotaTemplateFields(options.quotaValue);

	return {
		...getRunStatsFields(runStats, costCurrency, options.fxRates),
		cwd: formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
		gitBranch: branch || "",
		sessionName: sessionName || "",
		// Like the built-in footer's CH marker: only while the session has any
		// cache usage, and without the % sign (the template adds it).
		latestCacheHitRate:
			(totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined
				? latestCacheHitRate.toFixed(1)
				: "",
		// Overrides the run-stats cost: in footer templates {cost} is the
		// cumulative session total (empty while nothing was spent), so it can
		// sit next to the session token fields.
		cost: totals.cost > 0 ? formatCost(totals.cost, costCurrency, options.fxRates) : "",
		// Overrides the run-stats totalTokens: cumulative session total, so it
		// can sit next to the session token fields.
		totalTokens: formatCount(totals.totalTokens),
		sessionInput: totals.input > 0 ? formatTokens(totals.input) : "",
		sessionOutput: totals.output > 0 ? formatTokens(totals.output) : "",
		sessionCacheRead: totals.cacheRead > 0 ? formatTokens(totals.cacheRead) : "",
		sessionCacheWrite: totals.cacheWrite > 0 ? formatTokens(totals.cacheWrite) : "",
		subscription: usingSubscription ? "(sub)" : "",
		percent,
		contextWindow: formatTokens(contextWindow),
		autoCompaction: options.autoCompactionEnabled ? "(auto)" : "",
		contextTokens,
		modelName: model?.id || "no-model",
		thinkingLevel: model?.reasoning
			? (ctx.thinkingLevel || "off") === "off"
				? "• thinking off"
				: `• ${ctx.thinkingLevel}`
			: "",
		modelProvider:
			footerData.getAvailableProviderCount() > 1 && model ? `(${model.provider})` : "",
		extensionStatuses: formatExtensionStatuses(footerData),
		balanceLabel,
		balanceStatus,
		balanceDelta: formatBalanceDeltaField(
			firstBalance,
			options.balanceValue,
			costCurrency,
			options.fxRates,
		),
		...quotaFields,
		xp: process.env.PI_EXPERIMENTAL === "1" ? "xp" : "",
	};
}

/** The default footer template, mirroring pi's built-in footer layout plus the cumulative total-token count and the right-aligned account balance / quota-window breakdown. */
export const DEFAULT_FOOTER_TEMPLATE =
	"{cwd}[ ({gitBranch})][ • {sessionName}][{balanceLabel}: {balanceStatus}]:right[ 5h {quota5hUsed} used ({quota5hReset})][ 7d {quota7dUsed} used ({quota7dReset})][ credits: {creditsRemaining}]\n" +
	"[↑{sessionInput}][ ↓{sessionOutput}][ R{sessionCacheRead}][ W{sessionCacheWrite}][ CH{latestCacheHitRate}%][ {cost} {subscription}] Σ{totalTokens} {percent}%/{contextWindow}[={contextTokens}][ {autoCompaction}][ • {xp}][ {modelProvider} {modelName} {thinkingLevel}]:right\n" +
	"{extensionStatuses}";

/** The notification format used when no custom template is configured; `{cost}` carries its own currency symbol. */
export const DEFAULT_RUN_NOTIFICATION_TEMPLATE =
	"{time} ({elapsedTime} elapsed/{idleTime} idle) — {tokensPerSecond} tok/s, {cost}, ↑{input} ↓{output} R{cacheRead} W{cacheWrite}, Σ{totalTokens}";

/** Render the per-message throughput notification; an unset template falls back to the default format. */
export function renderRunNotification(
	template: string | undefined,
	stats: RunStats,
	costCurrency: string,
	fxRates: Record<string, number> | null,
): string {
	return expandTemplate(
		template?.trim() || DEFAULT_RUN_NOTIFICATION_TEMPLATE,
		getRunStatsFields(stats, costCurrency, fxRates),
	);
}

function expandOptionalGroups(template: string, fields: Record<string, string>): string {
	return template.replace(OPTIONAL_GROUP_PATTERN, (placeholder, contents: string) => {
		const fieldMatches = Array.from(contents.matchAll(FIELD_PATTERN));
		// Preserve bracketed text that does not contain fields, and keep unknown
		// placeholders unchanged just like ordinary template text.
		if (
			fieldMatches.length === 0 ||
			fieldMatches.some(([, fieldName]) => !Object.prototype.hasOwnProperty.call(fields, fieldName))
		) {
			return placeholder;
		}
		return fieldMatches.some(([, fieldName]) => fields[fieldName] !== "") ? contents : "";
	});
}

function expandTemplate(template: string, fields: Record<string, string>): string {
	const text = expandOptionalGroups(template, fields);
	let result = "";
	let cursor = 0;
	for (const match of text.matchAll(FIELD_PATTERN)) {
		const fieldStart = match.index;
		const fieldEnd = fieldStart + match[0].length;
		result += text.slice(cursor, fieldStart);
		cursor = fieldEnd;
		const fieldName = match[1];
		if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
			// Unknown placeholders stay literal, like ordinary template text.
			result += match[0];
			continue;
		}
		const value = fields[fieldName];
		if (value !== "") {
			result += value;
			continue;
		}
		// An empty field also removes one adjacent whitespace run (the one
		// after it, else the one before it), so a kept optional section cannot
		// leave stray separators around a dropped value.
		const afterRun = /^\s+/.exec(text.slice(cursor));
		if (afterRun) {
			cursor += afterRun[0].length;
			continue;
		}
		const beforeRun = /\s+$/.exec(result);
		if (beforeRun) result = result.slice(0, beforeRun.index);
	}
	return result + text.slice(cursor);
}

/**
 * Expand one template line. A `:right` marker on a field or on an optional
 * section splits the line into a left part and a right part, so the unit can
 * be right-aligned on render.
 */
function expandLine(
	line: string,
	fields: Record<string, string>,
): { text: string; right: { left: string; right: string } | undefined } {
	// Resolve optional groups before looking for a right-aligned unit. This
	// also allows an optional group to contain a :right placeholder, while a
	// group directly followed by :right is preserved by the lookahead and
	// located here as a single unit, e.g. `[{balanceLabel}: {balanceStatus}]:right`.
	const expandedOptionalGroups = expandOptionalGroups(line, fields);
	const rightMatch = RIGHT_ALIGN_PATTERN.exec(expandedOptionalGroups);
	if (!rightMatch) {
		return { text: expandTemplate(expandedOptionalGroups, fields), right: undefined };
	}
	// An unknown right-aligned field stays in place, like any placeholder.
	if (rightMatch[1] !== undefined && !Object.prototype.hasOwnProperty.call(fields, rightMatch[1])) {
		return { text: expandTemplate(expandedOptionalGroups, fields), right: undefined };
	}
	const unitStart = rightMatch.index;
	const markerEnd = unitStart + rightMatch[0].length;
	const unitEnd = markerEnd - ":right".length;
	const left = expandTemplate(expandedOptionalGroups.slice(0, unitStart), fields);
	const right = expandTemplate(
		expandedOptionalGroups.slice(unitStart, unitEnd) + expandedOptionalGroups.slice(markerEnd),
		fields,
	);
	// An empty right-aligned unit (e.g. `{balanceLabel}: {balanceStatus}` with
	// no balance) leaves the line as its left part instead of padding it with
	// trailing spaces.
	return right === "" ? { text: left, right: undefined } : { text: left + right, right: { left, right } };
}

/**
 * Right-align `right` after `left` with at least two spaces of separation,
 * mirroring pi's built-in stats line: truncate the left part first, then the
 * right part, and drop the right part entirely when no room is left.
 */
function rightAlign(left: string, right: string, width: number): string {
	const minPadding = 2;
	let leftWidth = visibleWidth(left);
	if (leftWidth > width) {
		left = truncateToWidth(left, width, "...");
		leftWidth = visibleWidth(left);
	}
	const rightWidth = visibleWidth(right);
	if (leftWidth + minPadding + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}
	const availableForRight = width - leftWidth - minPadding;
	if (availableForRight <= 0) return left;
	const truncatedRight = truncateToWidth(right, availableForRight, "");
	const truncatedRightWidth = visibleWidth(truncatedRight);
	const padding = Math.max(0, width - leftWidth - truncatedRightWidth);
	return left + " ".repeat(padding) + truncatedRight;
}

export function renderTemplate(
	template: string,
	fields: Record<string, string>,
	width: number,
	theme: Theme,
): string[] {
	const lines = template.split(/\r?\n/).map((line) => expandLine(line, fields));
	// Do not leave a blank trailing row when the template uses an optional
	// extension-status placeholder.
	while (lines.length > 1 && lines[lines.length - 1].text === "") lines.pop();

	return lines.map(({ text, right }) => {
		if (right) {
			return theme.fg("dim", rightAlign(right.left, right.right, width));
		}
		const styledLine = theme.fg("dim", text);
		return truncateToWidth(styledLine, width, theme.fg("dim", "..."));
	});
}
