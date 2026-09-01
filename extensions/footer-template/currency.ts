/**
 * Multi-currency cost display (`/set-currency`).
 *
 * Ported from https://github.com/eriiic7z/pi-tidy-footer: costs are priced in
 * USD by the model registry, and are converted to the configured display
 * currency using daily exchange rates fetched from the free
 * `@fawazahmed0/currency-api` CDN build (USD base). Rates are cached for 24
 * hours and persisted in `~/.pi/agent/pi-footer-template-state.json` (the
 * agent dir, resolved via `getAgentDir()`, see
 * docs/extension-config-and-cache.md). The selected currency is user config
 * and lives in settings.json as `footerTemplate.costCurrency` (see io.ts).
 * USD needs no rates at all, so it always works offline.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Display currencies: symbol and decimal places, like pi-tidy-footer. */
export const CURRENCIES: Record<string, { symbol: string; decimals: number }> = {
	AUD: { symbol: "A$", decimals: 2 },
	CAD: { symbol: "C$", decimals: 2 },
	CNY: { symbol: "¥", decimals: 2 },
	EUR: { symbol: "€", decimals: 2 },
	GBP: { symbol: "£", decimals: 2 },
	HKD: { symbol: "HK$", decimals: 2 },
	JPY: { symbol: "¥", decimals: 0 },
	KRW: { symbol: "₩", decimals: 0 },
	TWD: { symbol: "NT$", decimals: 2 },
	USD: { symbol: "$", decimals: 3 },
};

/** Space-joined currency codes, for `/set-currency` help notifications. */
export const CURRENCY_LIST = Object.keys(CURRENCIES).join(" ");

/** The `auto` mode of the `costCurrency` setting: resolves per provider. */
export const AUTO_CURRENCY = "auto";

/**
 * Provider ids billed in CNY — the extension's Chinese providers, any other
 * provider defaults to USD.
 */
const CNY_PROVIDERS = new Set([
	"deepseek",
	"moonshotai-cn",
	"siliconflow",
	"zai-coding-cn",
	"zai-api-cn",
]);

/**
 * The currency `auto` resolves to for a provider (see CNY_PROVIDERS; every
 * other provider bills in USD). DeepSeek keeps its prefix match, like
 * resolveBalanceProvider.
 */
export function resolveAutoCurrency(provider: string | undefined): string {
	if (!provider) return "USD";
	const id = provider.toLowerCase();
	if (id.startsWith("deepseek")) return "CNY";
	return CNY_PROVIDERS.has(id) ? "CNY" : "USD";
}

/**
 * The effective display currency: `auto` resolves per provider, any other
 * configured value is used as-is.
 */
export function resolveDisplayCurrency(
	configured: string,
	provider: string | undefined,
): string {
	return configured === AUTO_CURRENCY ? resolveAutoCurrency(provider) : configured;
}

/** How long a fetched rate table stays usable (pi-tidy-footer: 24h). */
const FX_TTL_MS = 86_400_000;
const FX_FETCH_TIMEOUT_MS = 5000;
const FX_URL =
	"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";

/* ------------------------------------------------------------------ */
/*  persistence                                                        */
/* ------------------------------------------------------------------ */

/**
 * The FX-rate cache lives in the agent dir root — NOT in
 * `~/.pi/agent/extensions/`, which is pi's auto-discovery directory for
 * extension code and is managed (and wiped) by `pi install`. The agent dir
 * is resolved via `getAgentDir()` so `PI_CODING_AGENT_DIR` (and rebranded
 * distributions) are honored. See docs/extension-config-and-cache.md.
 */
const STATE_FILE = join(getAgentDir(), "pi-footer-template-state.json");

let stateCache: Record<string, unknown> | null = null;

/** Read a state file; missing or corrupt files are treated as "no state". */
function readStateFile(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Atomic write (temp file + rename): a crash never leaves a torn file. */
function writeStateFile(file: string, state: Record<string, unknown>): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), "utf8");
	renameSync(tmp, file);
}

function loadState(): Record<string, unknown> {
	if (stateCache) return stateCache;
	stateCache = readStateFile(STATE_FILE);
	return stateCache;
}

function mergeState(patch: Record<string, unknown>): void {
	const prev = loadState();
	const next = { ...prev, ...patch };
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeStateFile(STATE_FILE, next);
		Object.assign(prev, patch);
	} catch (error) {
		console.error("pi-footer-template: mergeState failed", error);
	}
}

/* ------------------------------------------------------------------ */
/*  exchange rates                                                     */
/* ------------------------------------------------------------------ */

interface FxCache {
	rates: Record<string, number>;
	fetchedAt: number;
}

function readFxCache(): FxCache | null {
	const cache = loadState().fxCache;
	if (
		cache &&
		typeof cache === "object" &&
		!Array.isArray(cache) &&
		typeof (cache as { rates?: unknown }).rates === "object" &&
		typeof (cache as { fetchedAt?: unknown }).fetchedAt === "number"
	) {
		return {
			rates: (cache as { rates: Record<string, number> }).rates,
			fetchedAt: (cache as { fetchedAt: number }).fetchedAt,
		};
	}
	return null;
}

function writeFxCache(cache: FxCache): void {
	mergeState({ fxCache: cache });
}

let fxCache: FxCache | null = readFxCache();
let fxFetching: Promise<void> | null = null;

/** The currently cached USD-based rate table, or null when unavailable. */
export function getFxRates(): Record<string, number> | null {
	return fxCache?.rates ?? null;
}

/**
 * Fetch fresh rates when the cache is missing or older than the TTL.
 * A fetch already in flight is reused; failures keep the old cache.
 * Resolves once rates are available (or the attempt finished).
 */
export function refreshFxIfStale(): Promise<void> {
	if (fxFetching) return fxFetching;
	if (fxCache && Date.now() - fxCache.fetchedAt <= FX_TTL_MS) {
		return Promise.resolve();
	}
	fxFetching = (async () => {
		try {
			const response = await fetch(FX_URL, {
				signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
			});
			const data = (await response.json()) as Record<string, unknown>;
			const usd = data?.usd;
			if (!usd || typeof usd !== "object") return;
			const rates: Record<string, number> = {};
			for (const [key, value] of Object.entries(usd)) {
				if (key === "date") continue;
				const rate = Number(value);
				if (Number.isFinite(rate) && rate > 0) rates[key] = rate;
			}
			if (Object.keys(rates).length === 0) return;
			fxCache = { rates, fetchedAt: Date.now() };
			writeFxCache(fxCache);
		} catch (error) {
			console.error("pi-footer-template: refreshFx failed", error);
			/* keep the old cache */
		} finally {
			fxFetching = null;
		}
	})();
	return fxFetching;
}

/* ------------------------------------------------------------------ */
/*  conversion helpers                                                 */
/* ------------------------------------------------------------------ */

/** The conversion factor from USD to `ccy`; USD is 1 without any cache. */
export function ccyRate(
	ccy: string,
	rates: Record<string, number> | null | undefined,
): number | undefined {
	if (ccy === "USD") return 1;
	return rates?.[ccy.toLowerCase()] ?? undefined;
}

/**
 * Format a USD amount in the display currency, e.g. `€12.34`. When the
 * currency is not USD and no rate is available, renders the currency symbol
 * with `--` (mirroring pi-tidy-footer); USD needs no rates and always works.
 */
export function formatCost(
	costUsd: number,
	ccy: string,
	rates: Record<string, number> | null | undefined,
): string {
	const info = CURRENCIES[ccy] ?? CURRENCIES.USD;
	const rate = ccyRate(ccy, rates);
	if (rate === undefined) return `${info.symbol}--`;
	return `${info.symbol}${(costUsd * rate).toFixed(info.decimals)}`;
}
