/**
 * Multi-currency cost display (`/set-currency`).
 *
 * Ported from https://github.com/eriiic7z/pi-tidy-footer: costs are priced in
 * USD by the model registry, and are converted to the configured display
 * currency using daily exchange rates fetched from the free
 * `@fawazahmed0/currency-api` CDN build (USD base). Rates are cached for 24
 * hours and persisted next to the settings in
 * `~/.pi/agent/extensions/pi-footer-template-state.json`, together with the
 * selected currency. USD needs no rates at all, so it always works offline.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** How long a fetched rate table stays usable (pi-tidy-footer: 24h). */
const FX_TTL_MS = 86_400_000;
const FX_FETCH_TIMEOUT_MS = 5000;
const FX_URL =
	"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";

/* ------------------------------------------------------------------ */
/*  persistence                                                        */
/* ------------------------------------------------------------------ */

const STATE_DIR = join(homedir(), ".pi", "agent", "extensions");
const STATE_FILE = join(STATE_DIR, "pi-footer-template-state.json");

let stateCache: Record<string, unknown> | null = null;

function loadState(): Record<string, unknown> {
	if (stateCache) return stateCache;
	try {
		const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		stateCache =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
	} catch {
		stateCache = {};
	}
	return stateCache;
}

function mergeState(patch: Record<string, unknown>): void {
	const prev = loadState();
	const next = { ...prev, ...patch };
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(next), "utf8");
		Object.assign(prev, patch);
	} catch (error) {
		console.error("pi-footer-template: mergeState failed", error);
	}
}

/** The configured display currency; always a valid `CURRENCIES` key. */
export function readCostCurrency(): string {
	const value = loadState().costCurrency;
	return typeof value === "string" && CURRENCIES[value] ? value : "USD";
}

export function writeCostCurrency(ccy: string): void {
	mergeState({ costCurrency: ccy });
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
