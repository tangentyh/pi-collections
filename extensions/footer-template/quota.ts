/**
 * Provider quota status for the `{balanceLabel}/{balanceStatus}` fields.
 *
 * Ported from pi-fancy-footer's provider-status widget and pi-usage: the
 * OAuth subscription providers (OpenAI Codex, Anthropic) report rolling quota
 * windows on their usage endpoints, rendered as `<Label>: 5h:23% 7d:41%` —
 * window length plus used percentage — with a reset countdown appended to
 * windows at or above 75% used, and the Codex credit balance when the account
 * reports one. Auth goes through pi's model registry like the account
 * balance: for these providers `getApiKeyForProvider` resolves the OAuth
 * access token, with pi-managed token refresh and the same sandbox-aware
 * proxy handling.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Cache fetched quota status for this long (pi-usage uses a 3-minute TTL too). */
export const QUOTA_CACHE_MS = 3 * 60_000;

/** Request timeout for quota endpoints (pi-usage's default is 15 s). */
const QUOTA_TIMEOUT_MS = 15_000;

/** Sentinel injected by the Docker Sandbox proxy for environment variables
 * listed under `environment.proxyManaged` in spec.yaml: the proxy injects the
 * real Authorization header, so the extension must not send one itself. */
const PROXY_MANAGED_SENTINEL = "proxy-managed";

/** A rolling quota window: the used percentage of a provider limit. */
export interface QuotaWindow {
	/** Window-length label, e.g. `5h` or `7d`. */
	label: string;
	/** Used percentage, 0-100. */
	usedPercent: number;
	/** True when the provider reports the window without a usage value. */
	usageUnknown: boolean;
	/** Unix-seconds timestamp of the window reset, when reported. */
	resetAt?: number;
}

/** Quota status of a provider: its rolling windows plus an optional credit balance. */
export interface QuotaValue {
	windows: QuotaWindow[];
	/** Raw credit-balance string (e.g. `12.34`) when the account reports one. */
	credits?: string;
}

interface QuotaProviderConfig {
	/** Usage endpoint, called with `Authorization: Bearer <access token>`. */
	url: string;
	/** Display name used as the field label, e.g. `Claude: 5h:23% 7d:41%`. */
	label: string;
	/** Extract a `QuotaValue` from a 200 response; undefined = no quota reported. */
	parse: (data: any) => QuotaValue | undefined;
}

/**
 * Supported quota providers, keyed by pi provider id. Endpoints mirror
 * pi-fancy-footer and pi-usage: Codex's WHAM usage endpoint and Anthropic's
 * OAuth usage endpoint both report rolling utilization windows (5h and 7d).
 */
export const QUOTA_PROVIDERS: Record<string, QuotaProviderConfig> = {
	"openai-codex": {
		url: "https://chatgpt.com/backend-api/wham/usage",
		label: "Codex",
		parse: parseCodexUsage,
	},
	anthropic: {
		url: "https://api.anthropic.com/api/oauth/usage",
		label: "Claude",
		parse: parseClaudeUsage,
	},
};

/**
 * Resolve an active provider id to a supported quota-provider key, or
 * undefined when the provider has no quota endpoint. Matching is
 * case-insensitive.
 */
export function resolveQuotaProvider(provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	const id = provider.toLowerCase();
	return QUOTA_PROVIDERS[id] ? id : undefined;
}

/** Error thrown by quota requests; carries a short code for footer display. */
export class QuotaError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "QuotaError";
		this.code = code;
	}
}

/**
 * Fetch the provider quota status. Resolves undefined when the provider
 * reports no quota windows. Throws `QuotaError` with a short code: `fetch`
 * for network errors, `timeout` for a timed-out request, `http{status}` for
 * HTTP errors, and `badjson` for empty or malformed responses.
 */
export async function fetchQuota(
	provider: string,
	modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">,
): Promise<QuotaValue | undefined> {
	const config = QUOTA_PROVIDERS[provider];
	if (!config) {
		throw new QuotaError(`Unsupported quota provider: ${provider}`, "provider");
	}

	const apiKey = await modelRegistry.getApiKeyForProvider(provider);
	const headers: Record<string, string> = {
		// Pi routes fetch() through undici's EnvHttpProxyAgent, which fails to
		// decompress gzip responses; request identity encoding to avoid that.
		"Accept-Encoding": "identity",
	};
	if (apiKey && apiKey !== PROXY_MANAGED_SENTINEL) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	let response: Response;
	try {
		response = await fetch(config.url, {
			headers,
			signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		throw new QuotaError(
			`Quota request failed: ${error instanceof Error ? error.message : String(error)}`,
			timedOut ? "timeout" : "fetch",
		);
	}
	if (!response.ok) {
		throw new QuotaError(`Quota request failed with status ${response.status}`, `http${response.status}`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new QuotaError("Quota response was empty or malformed", "badjson");
	}

	return config.parse(data);
}

/** Show a reset countdown once a window reaches this used percentage (pi-fancy-footer's default). */
const RESET_COUNTDOWN_MIN_PERCENT = 75;

/**
 * Render the quota status like pi-fancy-footer's provider-status text, e.g.
 * `Codex: 5h:12% 7d:34%`; a window at or above 75% used gets a reset
 * countdown (`7d:86% ~2h`), and the Codex credit balance appends as
 * `cr:12.34` when the account reports one. `<Label>: No quota` when the
 * provider reports neither windows nor credits.
 */
export function formatQuotaText(label: string, value: QuotaValue | undefined, nowMs = Date.now()): string {
	if (!value) return `${label}: No quota`;
	const parts = value.windows.map((window) => {
		let part = window.usageUnknown
			? `${window.label}:—`
			: `${window.label}:${formatPercent(window.usedPercent)}`;
		if (
			!window.usageUnknown &&
			window.resetAt !== undefined &&
			window.usedPercent >= RESET_COUNTDOWN_MIN_PERCENT
		) {
			const reset = formatResetCountdown(window.resetAt, nowMs);
			if (reset) part += ` ${reset}`;
		}
		return part;
	});
	if (value.credits !== undefined) parts.push(`cr:${value.credits}`);
	if (parts.length === 0) return `${label}: No quota`;
	return `${label}: ${parts.join(" ")}`;
}

function formatPercent(value: number): string {
	return `${Math.round(value)}%`;
}

/** `~2h30m`, `~45m`, `~3d5h`, `~now` — ported from pi-fancy-footer. */
export function formatResetCountdown(resetAt: number, nowMs = Date.now()): string {
	if (!Number.isFinite(resetAt) || !Number.isFinite(nowMs) || resetAt <= 0) return "";

	const remainingMs = resetAt * 1000 - nowMs;
	if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "";

	const minuteMs = 60_000;
	const hourMs = 60 * minuteMs;
	const dayMs = 24 * hourMs;
	if (remainingMs >= dayMs) {
		const days = Math.floor(remainingMs / dayMs);
		const hours = Math.floor((remainingMs % dayMs) / hourMs);
		return `~${days}d${hours > 0 ? `${hours}h` : ""}`;
	}
	if (remainingMs >= hourMs) {
		const hours = Math.floor(remainingMs / hourMs);
		const minutes = Math.floor((remainingMs % hourMs) / minuteMs);
		return `~${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	}
	if (remainingMs >= minuteMs) {
		return `~${Math.floor(remainingMs / minuteMs)}m`;
	}
	return "~now";
}

function parseCodexUsage(data: any): QuotaValue | undefined {
	const rateLimit = data?.rate_limit;
	const primary = parseCodexWindow(rateLimit?.primary_window, "5h");
	const secondary = parseCodexWindow(rateLimit?.secondary_window, "7d");
	const credits = toStringValue(data?.credits?.balance);
	const windows = [primary, secondary].filter((w): w is QuotaWindow => w !== undefined);
	if (windows.length === 0 && credits === undefined) return undefined;
	return { windows, ...(credits !== undefined ? { credits } : {}) };
}

function parseCodexWindow(value: unknown, fallbackLabel: string): QuotaWindow | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const window = value as Record<string, unknown>;
	const usedPercent = toNumber(window.used_percent);
	const resetAt = normalizeResetAt(toNumber(window.reset_at));
	const label = windowLabelFromSeconds(toNumber(window.limit_window_seconds)) ?? fallbackLabel;
	if (usedPercent === undefined && resetAt === undefined) return undefined;
	return {
		label,
		usedPercent: clampPercent(usedPercent ?? 0),
		usageUnknown: usedPercent === undefined,
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function parseClaudeUsage(data: any): QuotaValue | undefined {
	const fiveHour = parseClaudeWindow(data?.five_hour, "5h");
	const sevenDay = parseClaudeWindow(data?.seven_day, "7d");
	const windows = [fiveHour, sevenDay].filter((w): w is QuotaWindow => w !== undefined);
	if (windows.length === 0) return undefined;
	return { windows };
}

function parseClaudeWindow(value: unknown, label: string): QuotaWindow | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const window = value as Record<string, unknown>;
	const usedPercent = toNumber(window.utilization);
	if (usedPercent === undefined) return undefined;
	const resetAt = resetAtFromTimestamp(toStringValue(window.resets_at));
	return {
		label,
		usedPercent: clampPercent(usedPercent),
		usageUnknown: false,
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

/** Map a window length in seconds to a compact label: 18000 -> `5h`, 604800 -> `7d`. */
function windowLabelFromSeconds(seconds: number | undefined): string | undefined {
	if (seconds === undefined || seconds <= 0) return undefined;
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return undefined;
}

/** Reset timestamps arrive in seconds or milliseconds; normalize to seconds. */
function normalizeResetAt(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return value > 10_000_000_000 ? Math.round(value / 1000) : value;
}

function resetAtFromTimestamp(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function toNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toStringValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}
