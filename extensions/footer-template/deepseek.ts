/**
 * DeepSeek account-balance field (`{deepseekBalance}`).
 *
 * Ported from https://github.com/shaftoe/pi-deepseek-usage: queries the
 * DeepSeek balance endpoint and renders the result as `DeepSeek: $17.35`.
 * USD is preferred, otherwise the first reported currency is used. Auth is
 * sandbox-aware like pi's own fetch path: a real API key is sent as a Bearer
 * token, the `proxy-managed` sentinel means the Docker sandbox proxy injects
 * the header itself, and a missing key leaves the request unauthenticated so
 * the API answers 401 (rendered as `DeepSeek: <err:http401>`).
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const DEEPSEEK_BALANCE_API_URL = "https://api.deepseek.com/user/balance";

/** Cache fetched balances for this long (pi-deepseek-usage uses 30s too). */
export const DEEPSEEK_BALANCE_CACHE_MS = 30_000;

/** Sentinel injected by the Docker Sandbox proxy for environment variables
 * listed under `environment.proxyManaged` in spec.yaml: the proxy injects the
 * real Authorization header, so the extension must not send one itself. */
const PROXY_MANAGED_SENTINEL = "proxy-managed";

export interface DeepSeekBalanceResponse {
	is_available: boolean;
	balance_infos: Array<{
		currency: string;
		total_balance: string;
		granted_balance: string;
		topped_up_balance: string;
	}>;
}

export interface DeepSeekBalanceData {
	isAvailable: boolean;
	balances: Array<{
		currency: string;
		totalBalance: string;
		grantedBalance: string;
		toppedUpBalance: string;
	}>;
}

/** Error thrown by balance requests; carries a short code for footer display. */
export class DeepSeekBalanceError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "DeepSeekBalanceError";
		this.code = code;
	}
}

/** Match the active model's provider, case-insensitively (like pi-deepseek-usage). */
export function isDeepSeekProvider(provider: string | undefined): boolean {
	return provider?.toLowerCase().startsWith("deepseek") ?? false;
}

/**
 * Fetch the DeepSeek account balance. Throws `DeepSeekBalanceError` with a
 * short code: `fetch` for network errors, `http{status}` for HTTP errors, and
 * `badjson` for empty or malformed responses.
 */
export async function fetchDeepSeekBalance(
	modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">,
): Promise<DeepSeekBalanceData> {
	const apiKey = await modelRegistry.getApiKeyForProvider("deepseek");
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
		response = await fetch(DEEPSEEK_BALANCE_API_URL, { headers });
	} catch (error) {
		throw new DeepSeekBalanceError(
			`DeepSeek balance request failed: ${error instanceof Error ? error.message : String(error)}`,
			"fetch",
		);
	}
	if (!response.ok) {
		throw new DeepSeekBalanceError(
			`DeepSeek balance request failed with status ${response.status}`,
			`http${response.status}`,
		);
	}

	let data: DeepSeekBalanceResponse;
	try {
		data = (await response.json()) as DeepSeekBalanceResponse;
	} catch {
		throw new DeepSeekBalanceError("DeepSeek balance response was empty or malformed", "badjson");
	}

	return {
		isAvailable: data.is_available,
		balances: data.balance_infos.map((info) => ({
			currency: info.currency,
			totalBalance: info.total_balance,
			grantedBalance: info.granted_balance,
			toppedUpBalance: info.topped_up_balance,
		})),
	};
}

/** Resolve the preferred balance entry: USD first, then the first reported. */
export function resolveBalance(data: DeepSeekBalanceData): DeepSeekBalanceData["balances"][number] | undefined {
	return data.balances.find((balance) => balance.currency === "USD") ?? data.balances[0];
}

/** The currency symbol used by pi-deepseek-usage: $ for USD, ¥ for CNY, otherwise the code. */
export function currencySymbol(currency: string): string {
	if (currency === "USD") return "$";
	if (currency === "CNY") return "¥";
	return `${currency} `;
}

/** Format a monetary value with its currency symbol, e.g. `$17.35`. */
export function formatMoney(amount: number, currency: string): string {
	const symbol = currencySymbol(currency);
	const abs = Math.abs(amount).toFixed(2);
	return amount < 0 ? `-${symbol}${abs}` : `${symbol}${abs}`;
}

/** Render the balance the way pi-deepseek-usage's footer status does. */
export function formatDeepSeekBalance(data: DeepSeekBalanceData): string {
	const balance = resolveBalance(data);
	if (!balance) return "DeepSeek: No balance";
	return `DeepSeek: ${formatMoney(parseFloat(balance.totalBalance), balance.currency)}`;
}
