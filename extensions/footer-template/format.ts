import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BALANCE_PROVIDERS } from "./balance.js";
import { CURRENCIES, ccyRate, formatCost } from "./currency.js";
import type { RunStats, SessionUsage, UsageTotals } from "./types.js";

const FIELD_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)(?::right)?\}/g;
// Square-bracketed sections are omitted when all contained fields are empty.
const OPTIONAL_GROUP_PATTERN = /\[([^\[\]\r\n]*)\]/g;
const RIGHT_ALIGN_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*):right\}/;

export function formatElapsedTime(elapsedSeconds: number): string {
	const secondsValue = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
	if (secondsValue < 60) return `${secondsValue.toFixed(1)}s`;

	const totalSeconds = Math.floor(secondsValue);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes} min ${seconds} s`;

	const hours = Math.floor(minutes / 60);
	return `${hours} h ${minutes % 60} min ${seconds} s`;
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

export function formatModelInfo(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): string {
	const model = ctx.model;
	const modelName = model?.id || "no-model";
	let modelInfo = modelName;

	if (model?.reasoning) {
		const thinkingLevel = ctx.thinkingLevel || "off";
		modelInfo = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}

	if (footerData.getAvailableProviderCount() > 1 && model) {
		modelInfo = `(${model.provider}) ${modelInfo}`;
	}
	return modelInfo;
}

export function formatTokenStats(
	totals: UsageTotals,
	latestCacheHitRate: number | undefined,
	usingSubscription: boolean,
	costCurrency: string,
	fxRates: Record<string, number> | null,
): string {
	const tokenStats: string[] = [];
	if (totals.input) tokenStats.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) tokenStats.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) tokenStats.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) tokenStats.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		tokenStats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost || usingSubscription) {
		tokenStats.push(
			`${formatCost(totals.cost, costCurrency, fxRates)}${usingSubscription ? " (sub)" : ""}`,
		);
	}
	return tokenStats.join(" ");
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
 * The `{balance}` value: the reported balance converted to the configured
 * display currency, e.g. `DeepSeek: €15.23`. When the conversion is not
 * possible (no cached rate for a non-USD display currency), the balance
 * falls back to its native currency formatting (`fallback`). The amount is
 * always shown with two decimals, keeping the documented format.
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
	/** The configured display currency (a `CURRENCIES` key). */
	costCurrency: string;
	/** The cached USD-based exchange-rate table, or null when unavailable. */
	fxRates: Record<string, number> | null;
	/** Whether auto-compaction is enabled (`(auto)` marker in {contextUsage}). */
	autoCompactionEnabled: boolean;
	/** `{balance}` value: "", "<Label>: <err:...>", or "<Label>: No balance". */
	balanceText: string;
	/** The numeric balance and its source currency, when available. */
	balanceValue: { amount: number; currency: string } | undefined;
	/** The provider key the balance belongs to (e.g. "deepseek", "openrouter"). */
	balanceProvider: string | undefined;
	/**
	 * Provider quota status for OAuth subscription providers (Codex, Claude):
	 * "", "<Label>: 5h:23% 7d:41%", or "<Label>: <err:...>". Non-empty only
	 * while the active model's provider reports quota windows; it takes
	 * precedence over the monetary balance in `{balance}`.
	 */
	quotaText: string;
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

	const tokenStats = formatTokenStats(
		totals,
		latestCacheHitRate,
		usingSubscription,
		options.costCurrency,
		options.fxRates,
	);

	// The `{balance}` field. OAuth subscription providers (Codex, Claude) have
	// no monetary balance; their quota status replaces the balance value for
	// them.
	const balanceLabel = options.balanceProvider
		? (BALANCE_PROVIDERS[options.balanceProvider]?.label ?? options.balanceProvider)
		: "";
	const balanceField = options.quotaText
		? options.quotaText
		: options.balanceValue && balanceLabel
			? formatBalanceField(
					balanceLabel,
					options.balanceValue,
					options.costCurrency,
					options.fxRates,
					options.balanceText,
				)
			: options.balanceText;

	return {
		...getRunStatsFields(runStats, options.costCurrency, options.fxRates),
		cwd: formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
		gitBranch: branch || "",
		sessionName: sessionName || "",
		latestCacheHitRate: latestCacheHitRate === undefined ? "" : latestCacheHitRate.toFixed(1),
		cost: formatCost(totals.cost, options.costCurrency, options.fxRates),
		// Overrides the run-stats totalTokens: in footer templates {totalTokens}
		// is the cumulative session total, so it can sit next to {tokenStats}.
		totalTokens: formatCount(totals.totalTokens),
		percent,
		contextWindow: formatTokens(contextWindow),
		tokenStats,
		contextUsage: `${percent}%/${formatTokens(contextWindow)}${options.autoCompactionEnabled ? " (auto)" : ""}`,
		contextTokens,
		modelInfo: formatModelInfo(ctx, footerData),
		extensionStatuses: formatExtensionStatuses(footerData),
		balance: balanceField,
		xp: process.env.PI_EXPERIMENTAL === "1" ? "xp" : "",
	};
}

/** The default footer template, mirroring pi's built-in footer layout plus the cumulative total-token count and the right-aligned account balance. */
export const DEFAULT_FOOTER_TEMPLATE =
	"{cwd}[ ({gitBranch})][ • {sessionName}]{balance:right}\n" +
	"{tokenStats} Σ{totalTokens} {contextUsage}[ ({contextTokens})][ • {xp}]{modelInfo:right}\n" +
	"{extensionStatuses}";

/** The notification format used when no custom template is configured; `{cost}` carries its own currency symbol. */
export const DEFAULT_RUN_NOTIFICATION_TEMPLATE =
	"{time} ({elapsedTime} elapsed/{idleTime} idle) — {tokensPerSecond} tok/s, {cost}, {output} out, {input} in, cache r/w {cacheRead}/{cacheWrite}, Σ{totalTokens}";

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
	return expandOptionalGroups(template, fields).replace(FIELD_PATTERN, (placeholder, fieldName: string) => {
		return Object.prototype.hasOwnProperty.call(fields, fieldName) ? fields[fieldName] || "" : placeholder;
	});
}

/**
 * Expand one template line. A `{field:right}` placeholder splits the line into
 * a left part and a right part, so the field can be right-aligned on render.
 */
function expandLine(
	line: string,
	fields: Record<string, string>,
): { text: string; right: { left: string; right: string } | undefined } {
	// Resolve optional groups before looking for a right-aligned field. This
	// also allows an optional group to contain a :right placeholder.
	const expandedOptionalGroups = expandOptionalGroups(line, fields);
	const rightMatch = RIGHT_ALIGN_PATTERN.exec(expandedOptionalGroups);
	if (!rightMatch || !Object.prototype.hasOwnProperty.call(fields, rightMatch[1])) {
		return { text: expandTemplate(expandedOptionalGroups, fields), right: undefined };
	}
	const left = expandTemplate(expandedOptionalGroups.slice(0, rightMatch.index), fields);
	const right =
		fields[rightMatch[1]] +
		expandTemplate(expandedOptionalGroups.slice(rightMatch.index + rightMatch[0].length), fields);
	// An empty right-aligned field (e.g. `{balance}` with no balance) leaves
	// the line as its left part instead of padding it with trailing spaces.
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
