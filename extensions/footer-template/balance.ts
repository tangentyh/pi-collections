/**
 * Multi-provider account-balance fields (`{balanceLabel}`/`{balanceStatus}`).
 *
 * Ported from https://github.com/eriiic7z/pi-tidy-footer: queries each
 * supported provider's balance endpoint (DeepSeek, Moonshot, OpenRouter,
 * SiliconFlow, and bigmodel.cn/Z.ai) and renders the result as
 * `<Label>: $17.35`. bigmodel.cn retired its PaaS monetary-balance endpoint
 * (`account/billing` answers 404 for every key), so the BigModel and Z.AI
 * balances come from the undocumented console account-report endpoint
 * (`query-customer-account-report`, see makeAccountReportParse below). The
 * DeepSeek handling keeps the richer semantics of
 * https://github.com/shaftoe/pi-deepseek-usage: USD is preferred, otherwise
 * the first reported currency is used. Auth goes through pi's model registry
 * (`getApiKeyForProvider`), which is sandbox-aware like pi's own fetch path:
 * a real API key is sent as a Bearer token, the `proxy-managed` sentinel
 * means the Docker sandbox proxy injects the header itself, and a missing
 * key leaves the request unauthenticated so the API answers 401 (rendered
 * as `<Label>: <err:http401>`).
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Cache fetched balances for this long (pi-deepseek-usage uses 30s too). */
export const BALANCE_CACHE_MS = 30_000;

/** Sentinel injected by the Docker Sandbox proxy for environment variables
 * listed under `environment.proxyManaged` in spec.yaml: the proxy injects the
 * real Authorization header, so the extension must not send one itself. */
const PROXY_MANAGED_SENTINEL = "proxy-managed";

/** A numeric balance plus its source currency. */
export interface BalanceValue {
	amount: number;
	currency: string;
}

interface BalanceProviderConfig {
	/** Balance endpoint, called with `Authorization: Bearer <key>`. */
	url: string;
	/** Display name used as the field label, e.g. `DeepSeek: $17.35`. */
	label: string;
	/** Extract `{ amount, currency }` from a 200 response; undefined = no balance reported. */
	parse: (data: any) => BalanceValue | undefined;
}

/**
 * Supported balance providers, keyed by pi provider id. Endpoints and parse
 * logic mirror pi-tidy-footer; the native currency of each endpoint is used
 * for FX conversion into the configured display currency.
 */
export const BALANCE_PROVIDERS: Record<string, BalanceProviderConfig> = {
	deepseek: {
		url: "https://api.deepseek.com/user/balance",
		label: "DeepSeek",
		parse: (data) => {
			const balances = data?.balance_infos;
			if (!Array.isArray(balances) || balances.length === 0) return undefined;
			const preferred = balances.find((b) => b?.currency === "USD") ?? balances[0];
			return toBalanceValue(preferred?.total_balance, preferred?.currency);
		},
	},
	"moonshotai-cn": {
		url: "https://api.moonshot.cn/v1/users/me/balance",
		label: "Moonshot",
		parse: (data) => {
			const bal = data?.data;
			const cash = Number.parseFloat(bal?.cash_balance ?? "");
			const voucher = Number.parseFloat(bal?.voucher_balance ?? "");
			const available = Number.parseFloat(bal?.available_balance ?? "");
			const raw =
				Number.isNaN(cash) || Number.isNaN(voucher)
					? Number.isNaN(available)
						? undefined
						: available
					: cash + voucher;
			return raw === undefined ? undefined : { amount: raw, currency: "CNY" };
		},
	},
	openrouter: {
		url: "https://openrouter.ai/api/v1/credits",
		label: "OpenRouter",
		parse: (data) => {
			const amount = toAmount(data?.data?.total_credits);
			return Number.isFinite(amount) ? { amount, currency: "USD" } : undefined;
		},
	},
	siliconflow: {
		url: "https://api.siliconflow.cn/v1/user/info",
		label: "SiliconFlow",
		parse: (data) => {
			const amount = toAmount(data?.data?.balance);
			return Number.isFinite(amount) ? { amount, currency: "CNY" } : undefined;
		},
	},
	"zai-coding-cn": {
		url: "https://open.bigmodel.cn/api/biz/account/query-customer-account-report",
		label: "BigModel",
		parse: makeAccountReportParse("CNY"),
	},
	zai: {
		url: "https://api.z.ai/api/biz/account/query-customer-account-report",
		label: "Z.AI",
		parse: makeAccountReportParse("USD"),
	},
};

function toAmount(value: unknown): number {
	// Number(null) is 0 and Number("") is 0; treat nullish/empty as missing.
	if (value === null || value === undefined || value === "") return NaN;
	return Number(value);
}

function toBalanceValue(amount: unknown, currency: unknown): BalanceValue | undefined {
	const value = toAmount(amount);
	const ccy = typeof currency === "string" && currency ? currency : undefined;
	return Number.isFinite(value) && ccy ? { amount: value, currency: ccy } : undefined;
}

/**
 * Parser for the bigmodel.cn / Z.ai console account-report endpoint
 * (`/api/biz/account/query-customer-account-report`), keyed by host because
 * `open.bigmodel.cn`/`bigmodel.cn` bill in CNY while `api.z.ai` serves USD.
 * Undocumented console API that replaces bigmodel.cn's retired PaaS
 * `account/billing`; it answers HTTP 200 with application-level failures in
 * its JSON envelope (`success: false`, code 1001 = no Authorization header
 * received, 401 = invalid or expired token), so failures throw
 * `BalanceError`: credential problems keep the familiar `http401` code,
 * anything else becomes `api{code}`. On success, `data.balance` holds the
 * account balance; exponent-notation numbers (`0E-9`) parse via Number()
 * like any other JSON number.
 */
function makeAccountReportParse(currency: string) {
	return (data: any): BalanceValue | undefined => {
		if (data && typeof data === "object" && !Array.isArray(data)) {
			const code = typeof data.code === "number" && data.code >= 400 ? data.code : undefined;
			if (data.success === false || code !== undefined) {
				const msg = typeof data.msg === "string" ? data.msg : "";
				throw new BalanceError(
					`Balance request failed: ${msg || "application-level failure"}`,
					code !== undefined ? (code === 401 || code === 1001 ? "http401" : `api${code}`) : "api",
				);
			}
		}
		const amount = toAmount(data?.data?.balance);
		return Number.isFinite(amount) ? { amount, currency } : undefined;
	};
}

/**
 * Resolve an active provider id to a supported balance-provider key, or
 * undefined when the provider has no balance endpoint. Matching is
 * case-insensitive; DeepSeek keeps its prefix match (like pi-deepseek-usage).
 */
export function resolveBalanceProvider(provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	const id = provider.toLowerCase();
	if (id.startsWith("deepseek")) return "deepseek";
	return BALANCE_PROVIDERS[id] ? id : undefined;
}

/** Error thrown by balance requests; carries a short code for footer display. */
export class BalanceError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "BalanceError";
		this.code = code;
	}
}

/**
 * Fetch the account balance for a supported provider. Resolves undefined when
 * the account reports no balance. Throws `BalanceError` with a short code:
 * `fetch` for network errors, `http{status}` for HTTP errors, and `badjson`
 * for empty or malformed responses.
 */
export async function fetchBalance(
	provider: string,
	modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">,
): Promise<BalanceValue | undefined> {
	const config = BALANCE_PROVIDERS[provider];
	if (!config) {
		throw new BalanceError(`Unsupported balance provider: ${provider}`, "provider");
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
		response = await fetch(config.url, { headers });
	} catch (error) {
		throw new BalanceError(
			`Balance request failed: ${error instanceof Error ? error.message : String(error)}`,
			"fetch",
		);
	}
	if (!response.ok) {
		throw new BalanceError(`Balance request failed with status ${response.status}`, `http${response.status}`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new BalanceError("Balance response was empty or malformed", "badjson");
	}

	return config.parse(data);
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

/**
 * Render the balance the way pi-deepseek-usage's footer status does, e.g.
 * `DeepSeek: $17.35`; `<Label>: No balance` when none is reported.
 */
export function formatBalanceText(label: string, value: BalanceValue | undefined): string {
	if (!value) return `${label}: No balance`;
	return `${label}: ${formatMoney(value.amount, value.currency)}`;
}
