// Test suite for deepseek-pricing-by-time, run against the REAL extension
// module (no mocks of the rate tables): the module resolves
// `@earendil-works/*` from the workspace node_modules, and Node's native
// TypeScript stripping executes it directly.
//
// Run: node extensions/deepseek-pricing-by-time/tests/test.ts
//  or: npm test -w pi-deepseek-pricing-by-time
//
// Every expected number below is a hardcoded literal copied from DeepSeek's
// published schedule — never derived from the implementation's tables, so the
// assertions cannot be satisfied by a table that agrees with itself.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import deepseekPricingByTime, {
	type DeepSeekRates,
	periodAt,
	type RatePeriod,
	ratesAt,
	reprice,
	type Tier,
	tierAt,
} from "../deepseek-pricing-by-time.ts";

// Every pricing assertion below is expressed in UTC; forcing a non-UTC zone
// makes a stray local-time accessor (getDay/getHours) fail rather than pass.
process.env.TZ = "Etc/GMT+12";

// ── tiny labelled-check harness ───────────────────────────────────────
// Collects failures instead of aborting on the first one; any failure sets a
// non-zero exit code. A module-level import error still fails the run hard.

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
	} catch (error) {
		failed++;
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`FAIL ${name}`);
		console.error(`     ${detail}`);
	}
}

/** Floating-point-tolerant comparison (< 1e-12), for re-priced costs. */
function close(actual: number, expected: number, label?: string): void {
	assert.ok(
		Math.abs(actual - expected) < 1e-12,
		`${label ? `${label}: ` : ""}expected ${actual} to be within 1e-12 of ${expected}`,
	);
}

const utc = (
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
	ms = 0,
): Date => new Date(Date.UTC(year, month, day, hour, minute, second, ms));

// ── hardcoded fixtures from the published schedule ────────────────────

const CANCELLED_PRO_RETIREMENT_MS = Date.UTC(2026, 8, 14, 4); // 2026-09-14T04:00:00Z: the announced-then-cancelled Pro retirement instant

const FLASH_PEAK: DeepSeekRates = {
	input: 0.3,
	output: 1.2,
	cacheRead: 0.006,
	cacheWrite: 0,
};
const FLASH_OFF_PEAK: DeepSeekRates = {
	input: 0.15,
	output: 0.6,
	cacheRead: 0.003,
	cacheWrite: 0,
};
const V4_PRO_PEAK: DeepSeekRates = {
	input: 1.32,
	output: 3.96,
	cacheRead: 0.044,
	cacheWrite: 0,
};
const V4_PRO_OFF_PEAK: DeepSeekRates = {
	input: 0.66,
	output: 1.98,
	cacheRead: 0.022,
	cacheWrite: 0,
};
// Pre-2026-09-10 flash prices plus the old off-peak half: these must be gone.
const LEGACY_FLASH_PRE_SEPT10: DeepSeekRates[] = [
	{ input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
	{ input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
];

const PEAK_AT = utc(2026, 8, 10, 7); // Thu 2026-09-10 07:00Z
const OFF_PEAK_AT = utc(2026, 8, 10, 12); // Thu 2026-09-10 12:00Z

const LEGACY_IDS = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];

// ── fixture weekday assumptions ─────────────────────────────────────────

check(
	"fixture weekday assumptions: 09-09 Wed, 09-12 Sat, 09-13 Sun, 09-14 Mon",
	() => {
		assert.equal(
			utc(2026, 8, 9).getUTCDay(),
			3,
			"2026-09-09 must be Wednesday",
		);
		assert.equal(
			utc(2026, 8, 12).getUTCDay(),
			6,
			"2026-09-12 must be Saturday",
		);
		assert.equal(utc(2026, 8, 13).getUTCDay(), 0, "2026-09-13 must be Sunday");
		assert.equal(utc(2026, 8, 14).getUTCDay(), 1, "2026-09-14 must be Monday");
	},
);

// ── 1. tierAt: peak windows and weekend edges ─────────────────────────
// Peak = 01:00-04:00 & 06:00-10:00 UTC, Mon-Fri (half-open hours).

const tierCases: Array<[string, Date, Tier]> = [
	["Wed 2026-09-09 00:59 -> offPeak", utc(2026, 8, 9, 0, 59), "offPeak"],
	["Wed 2026-09-09 01:00 -> peak", utc(2026, 8, 9, 1, 0), "peak"],
	["Wed 2026-09-09 03:59 -> peak", utc(2026, 8, 9, 3, 59), "peak"],
	["Wed 2026-09-09 04:00 -> offPeak", utc(2026, 8, 9, 4, 0), "offPeak"],
	["Wed 2026-09-09 05:59 -> offPeak", utc(2026, 8, 9, 5, 59), "offPeak"],
	["Wed 2026-09-09 06:00 -> peak", utc(2026, 8, 9, 6, 0), "peak"],
	["Wed 2026-09-09 09:59 -> peak", utc(2026, 8, 9, 9, 59), "peak"],
	["Wed 2026-09-09 10:00 -> offPeak", utc(2026, 8, 9, 10, 0), "offPeak"],
	["Wed 2026-09-09 23:59 -> offPeak", utc(2026, 8, 9, 23, 59), "offPeak"],
	["Sat 2026-09-12 02:00 -> offPeak", utc(2026, 8, 12, 2, 0), "offPeak"],
	["Sat 2026-09-12 07:00 -> offPeak", utc(2026, 8, 12, 7, 0), "offPeak"],
	["Sun 2026-09-13 02:00 -> offPeak", utc(2026, 8, 13, 2, 0), "offPeak"],
];

for (const [name, date, expected] of tierCases) {
	check(`tierAt ${name}`, () => {
		assert.equal(tierAt(date), expected);
	});
}

// ── 2. ratesAt: V4.1-Flash values, legacy routing, pro (no retirement) ──

check("ratesAt deepseek-flash at peak = V4.1 Flash peak", () => {
	assert.deepEqual(ratesAt("deepseek-flash", PEAK_AT), FLASH_PEAK);
});

check("ratesAt deepseek-flash at off-peak = V4.1 Flash off-peak", () => {
	assert.deepEqual(ratesAt("deepseek-flash", OFF_PEAK_AT), FLASH_OFF_PEAK);
});

check("ratesAt accepts an epoch-ms instant as well as a Date", () => {
	assert.deepEqual(ratesAt("deepseek-flash", PEAK_AT.getTime()), FLASH_PEAK);
	assert.deepEqual(
		ratesAt("deepseek-flash", OFF_PEAK_AT.getTime()),
		FLASH_OFF_PEAK,
	);
});

for (const legacy of LEGACY_IDS) {
	check(`ratesAt ${legacy} at peak = V4.1 Flash peak`, () => {
		assert.deepEqual(ratesAt(legacy, PEAK_AT), FLASH_PEAK);
	});
	check(`ratesAt ${legacy} at off-peak = V4.1 Flash off-peak`, () => {
		assert.deepEqual(ratesAt(legacy, OFF_PEAK_AT), FLASH_OFF_PEAK);
	});
	check(`ratesAt ${legacy} never returns pre-2026-09-10 rates`, () => {
		for (const stale of LEGACY_FLASH_PRE_SEPT10) {
			assert.notDeepEqual(ratesAt(legacy, PEAK_AT), stale);
			assert.notDeepEqual(ratesAt(legacy, OFF_PEAK_AT), stale);
		}
	});
}

check(
	"ratesAt deepseek-v4-pro just before the cancelled retirement = Pro peak",
	() => {
		// 2026-09-14T03:59:59.999Z is a Monday inside [01:00, 04:00) -> peak.
		assert.equal(tierAt(new Date(CANCELLED_PRO_RETIREMENT_MS - 1)), "peak");
		assert.deepEqual(
			ratesAt("deepseek-v4-pro", CANCELLED_PRO_RETIREMENT_MS - 1),
			V4_PRO_PEAK,
		);
	},
);

check(
	"ratesAt deepseek-v4-pro at the cancelled retirement instant = Pro off-peak",
	() => {
		// 2026-09-14T04:00:00Z is Monday but outside every peak window ->
		// off-peak. The announced retirement was reversed, so Pro rates apply.
		assert.equal(tierAt(new Date(CANCELLED_PRO_RETIREMENT_MS)), "offPeak");
		assert.deepEqual(
			ratesAt("deepseek-v4-pro", CANCELLED_PRO_RETIREMENT_MS),
			V4_PRO_OFF_PEAK,
		);
	},
);

check(
	"ratesAt deepseek-v4-pro at a post-cancellation peak instant = Pro peak",
	() => {
		// Mon 2026-09-14 07:00Z, inside [06:00, 10:00): tier is peak, model is Pro.
		assert.deepEqual(
			ratesAt("deepseek-v4-pro", utc(2026, 8, 14, 7)),
			V4_PRO_PEAK,
		);
	},
);

check(
	"ratesAt deepseek-v4-pro off-peak before the cancelled retirement = Pro off-peak",
	() => {
		// Sun 2026-09-13 12:00Z: weekend off-peak, pro still served by Pro.
		assert.deepEqual(
			ratesAt("deepseek-v4-pro", utc(2026, 8, 13, 12)),
			V4_PRO_OFF_PEAK,
		);
	},
);

check(
	"ratesAt deepseek-v4-pro off-peak after the cancelled retirement = Pro off-peak",
	() => {
		// Mon 2026-09-14 12:00Z: off-peak, past the cancelled retirement instant.
		assert.deepEqual(
			ratesAt("deepseek-v4-pro", utc(2026, 8, 14, 12)),
			V4_PRO_OFF_PEAK,
		);
	},
);

check("ratesAt unknown / undefined model ids -> undefined", () => {
	assert.equal(ratesAt("gpt-5", PEAK_AT), undefined);
	assert.equal(ratesAt(undefined, PEAK_AT), undefined);
});

check(
	"ratesAt has no 2026-09-10 boundary: ancient deepseek-flash still bills V4.1 Flash",
	() => {
		// Pins the plan's design decision: the 2026-09-10 Flash price change is not
		// a schedule boundary (corrections are persisted per-message; history is
		// never re-priced), so even 2020-01-01 uses the current V4.1 Flash table.
		// 2020-01-01 07:00Z is a Wednesday inside a peak window.
		assert.deepEqual(ratesAt("deepseek-flash", utc(2020, 0, 1, 7)), FLASH_PEAK);
		assert.deepEqual(
			ratesAt("deepseek-flash", utc(2020, 0, 1, 12)),
			FLASH_OFF_PEAK,
		);
	},
);

for (const legacy of LEGACY_IDS) {
	check(
		`ratesAt ${legacy} at an ancient instant still bills V4.1 Flash`,
		() => {
			assert.deepEqual(ratesAt(legacy, utc(2020, 0, 1, 7)), FLASH_PEAK);
			assert.deepEqual(ratesAt(legacy, utc(2020, 0, 1, 12)), FLASH_OFF_PEAK);
		},
	);
}

// ── 3. periodAt: effective-dated schedule lookup ─────────────────────

check("periodAt returns the first period for a from-less schedule", () => {
	const period: RatePeriod | undefined = periodAt("deepseek-flash", PEAK_AT);
	assert.ok(period, "deepseek-flash must have a period");
	assert.deepEqual(period.rates, { peak: FLASH_PEAK, offPeak: FLASH_OFF_PEAK });
});

check("periodAt pro has a single note-less period at every instant", () => {
	for (const at of [
		utc(2020, 0, 1),
		utc(2026, 8, 13, 12),
		new Date(CANCELLED_PRO_RETIREMENT_MS),
		utc(2026, 8, 14, 7),
	]) {
		const period: RatePeriod | undefined = periodAt("deepseek-v4-pro", at);
		assert.ok(period, `pro must have a period at ${at.toISOString()}`);
		assert.deepEqual(period.rates, {
			peak: V4_PRO_PEAK,
			offPeak: V4_PRO_OFF_PEAK,
		});
		assert.equal(period.note, undefined, "pro must carry no routing note");
	}
});

check("periodAt unknown / undefined model ids -> undefined", () => {
	assert.equal(periodAt("gpt-5", PEAK_AT), undefined);
	assert.equal(periodAt(undefined, PEAK_AT), undefined);
});

// ── 4. reprice: per-field math, free cache writes ────────────────────

const REPRICE_USAGE: Usage = {
	input: 1_000_000,
	output: 500_000,
	cacheRead: 2_000_000,
	cacheWrite: 3_000_000,
	totalTokens: 6_500_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

check("reprice multiplies each token class by its literal rate", () => {
	const cost = reprice(REPRICE_USAGE, {
		input: 2.5,
		output: 8,
		cacheRead: 0.5,
		cacheWrite: 0,
	});
	close(cost.input, 2.5, "input");
	close(cost.output, 4, "output");
	close(cost.cacheRead, 1, "cacheRead");
	close(cost.cacheWrite, 0, "cacheWrite");
	close(cost.total, 7.5, "total");
});

check(
	"reprice charges nothing for cache writes despite 3M cacheWrite tokens",
	() => {
		assert.ok(
			REPRICE_USAGE.cacheWrite > 0,
			"fixture must have non-zero cacheWrite",
		);
		const cost = reprice(REPRICE_USAGE, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		close(
			cost.cacheWrite,
			0,
			"cacheWrite with non-zero tokens and a zero rate",
		);
		close(cost.total, 0, "total");
	},
);

// ── 5. handler integration through the real default export ───────────

const ZERO_COST: Usage["cost"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
};

// Cost fixtures for a usage of 1M input + 1M output (cacheRead/cacheWrite 0):
// peak/off-peak rates land on easily checked round numbers.
const FLASH_PEAK_COST: Usage["cost"] = {
	input: 0.3,
	output: 1.2,
	cacheRead: 0,
	cacheWrite: 0,
	total: 1.5,
};
const FLASH_OFF_PEAK_COST: Usage["cost"] = {
	input: 0.15,
	output: 0.6,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0.75,
};
const V4_PRO_PEAK_COST: Usage["cost"] = {
	input: 1.32,
	output: 3.96,
	cacheRead: 0,
	cacheWrite: 0,
	total: 5.28,
};
const V4_PRO_OFF_PEAK_COST: Usage["cost"] = {
	input: 0.66,
	output: 1.98,
	cacheRead: 0,
	cacheWrite: 0,
	total: 2.64,
};

/** Independently of the extension: the tier in effect at this instant. */
function expectedStatusNow(): string {
	const now = new Date();
	const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
	const peakHour = [1, 2, 3, 6, 7, 8, 9].includes(now.getUTCHours());
	return weekday && peakHour ? "peak ⚠️" : "off-peak";
}

/**
 * Flash cost for the tier in effect now. The timestamp-fallback checks are
 * wall-clock dependent, so this is the strongest assertion available: a
 * fallback that leaks a bad timestamp reads as off-peak, which is only
 * distinguishable while the clock says peak.
 */
function flashCostAtNow(): Usage["cost"] {
	return expectedStatusNow() === "peak ⚠️"
		? FLASH_PEAK_COST
		: FLASH_OFF_PEAK_COST;
}

const COST_FIELDS: Array<keyof Usage["cost"]> = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"total",
];

type MessageEndHandler = (...args: unknown[]) => unknown;

interface FakePi {
	handlers: Map<string, MessageEndHandler>;
	commands: Map<string, unknown>;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, MessageEndHandler>();
	const commands = new Map<string, unknown>();
	const pi = {
		on: (event: string, handler: MessageEndHandler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, definition: unknown) => {
			commands.set(name, definition);
		},
	} as unknown as ExtensionAPI;
	deepseekPricingByTime(pi);
	return { handlers, commands };
}

const fake = makeFakePi();

function endEvent(message: unknown): MessageEndEvent {
	return { type: "message_end", message } as unknown as MessageEndEvent;
}

function runMessageEnd(message: unknown): unknown {
	const handler = fake.handlers.get("message_end");
	assert.ok(handler, "extension must register a message_end handler");
	return handler(endEvent(message));
}

function usageOf(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2_000_000,
		cost: { ...ZERO_COST },
		...overrides,
	};
}

function assistantMessage(
	overrides: Record<string, unknown> = {},
): AssistantMessage {
	return {
		id: "msg-1",
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		responseModel: "deepseek-flash",
		usage: usageOf(),
		stopReason: "stop",
		timestamp: Date.UTC(2026, 8, 10, 7), // Thu 07:00Z = peak
		...overrides,
	} as unknown as AssistantMessage;
}

function returnedMessage(result: unknown): AssistantMessage {
	assert.ok(
		result && typeof result === "object",
		"handler must return a result",
	);
	const message = (result as { message?: unknown }).message;
	assert.ok(message, "handler result must carry a message");
	return message as AssistantMessage;
}

function costFrom(result: unknown): Usage["cost"] {
	const usage = returnedMessage(result).usage;
	assert.ok(usage, "re-priced message must keep usage");
	assert.ok(usage.cost, "re-priced message must carry usage.cost");
	return usage.cost;
}

function closeCost(
	actual: Usage["cost"],
	expected: Usage["cost"],
	label: string,
): void {
	for (const field of COST_FIELDS) {
		close(actual[field], expected[field], `${label} cost.${field}`);
	}
}

check(
	"message_end re-prices legacy deepseek-v4-flash echoed as deepseek-flash at peak",
	() => {
		const original = assistantMessage();
		const result = runMessageEnd(original);
		closeCost(costFrom(result), FLASH_PEAK_COST, "flash peak");

		const returned = returnedMessage(result);
		assert.equal(returned.role, original.role);
		assert.equal((returned as unknown as { id?: string }).id, "msg-1");
		assert.equal(returned.timestamp, original.timestamp);
		assert.equal(returned.model, "deepseek-v4-flash");
		assert.equal(returned.responseModel, "deepseek-flash");
		assert.equal(returned.usage.input, original.usage.input);
		assert.equal(returned.usage.output, original.usage.output);
		assert.equal(returned.usage.cacheRead, original.usage.cacheRead);
		assert.equal(returned.usage.cacheWrite, original.usage.cacheWrite);
		assert.equal(returned.usage.totalTokens, original.usage.totalTokens);
	},
);

check(
	"message_end falls back to message.model when responseModel is an unknown echo",
	() => {
		// The silent-no-op bug this change fixes: pi ships deepseek-v4-flash, but
		// DeepSeek echoes deepseek-flash; an unknown echo must not disable pricing.
		const result = runMessageEnd(
			assistantMessage({ responseModel: "deepseek-flash-latest" }),
		);
		closeCost(
			costFrom(result),
			FLASH_PEAK_COST,
			"flash peak via model fallback",
		);
	},
);

check("ratesAt rejects Object.prototype member ids instead of throwing", () => {
	// A truthy `SCHEDULES[id]` lookup would return Object.prototype members
	// (constructor, __proto__, …) and blow up in periodAt's loop.
	for (const id of ["constructor", "__proto__", "hasOwnProperty"]) {
		assert.equal(ratesAt(id, PEAK_AT), undefined, `id ${id}`);
	}
});

check(
	"message_end re-prices through the fallback when responseModel is a prototype member",
	() => {
		const result = runMessageEnd(
			assistantMessage({ responseModel: "constructor" }),
		);
		closeCost(costFrom(result), FLASH_PEAK_COST, "flash peak via fallback");
	},
);

check("message_end trusts a known responseModel over message.model", () => {
	// model says pro, echoed responseModel says flash, post-cancellation peak.
	const result = runMessageEnd(
		assistantMessage({
			model: "deepseek-v4-pro",
			responseModel: "deepseek-flash",
			timestamp: Date.UTC(2026, 8, 14, 7), // Mon 07:00Z = peak
		}),
	);
	closeCost(costFrom(result), FLASH_PEAK_COST, "flash peak");
});

check(
	"message_end bills deepseek-v4-pro at Pro peak (pre-cancellation instant)",
	() => {
		const result = runMessageEnd(
			assistantMessage({
				model: "deepseek-v4-pro",
				responseModel: "deepseek-v4-pro",
				timestamp: Date.UTC(2026, 8, 11, 7), // Fri 07:00Z = peak, pre-cancellation
			}),
		);
		closeCost(costFrom(result), V4_PRO_PEAK_COST, "pro peak");
	},
);

check(
	"message_end bills deepseek-v4-pro at Pro peak after the cancelled retirement",
	() => {
		const result = runMessageEnd(
			assistantMessage({
				model: "deepseek-v4-pro",
				responseModel: "deepseek-v4-pro",
				timestamp: Date.UTC(2026, 8, 14, 7), // Mon 07:00Z = peak, post-cancellation
			}),
		);
		closeCost(
			costFrom(result),
			V4_PRO_PEAK_COST,
			"pro peak after cancellation",
		);
	},
);

check(
	"message_end pro off-peak before vs after the cancelled retirement",
	() => {
		const before = runMessageEnd(
			assistantMessage({
				model: "deepseek-v4-pro",
				responseModel: "deepseek-v4-pro",
				timestamp: Date.UTC(2026, 8, 13, 12), // Sun 12:00Z = off-peak
			}),
		);
		closeCost(costFrom(before), V4_PRO_OFF_PEAK_COST, "pro off-peak");

		const after = runMessageEnd(
			assistantMessage({
				model: "deepseek-v4-pro",
				responseModel: "deepseek-v4-pro",
				timestamp: Date.UTC(2026, 8, 14, 12), // Mon 12:00Z = off-peak
			}),
		);
		closeCost(costFrom(after), V4_PRO_OFF_PEAK_COST, "pro off-peak");
	},
);

check(
	"message_end ignores messages whose model and responseModel are both unknown",
	() => {
		const result = runMessageEnd(
			assistantMessage({ model: "gpt-5", responseModel: "gpt-5" }),
		);
		assert.ok(!result, "no re-pricing when neither id is known");
	},
);

check("message_end ignores non-deepseek providers", () => {
	const result = runMessageEnd(assistantMessage({ provider: "openai" }));
	assert.ok(!result, "no re-pricing for a non-deepseek provider");
});

check("message_end ignores non-assistant messages", () => {
	const result = runMessageEnd(assistantMessage({ role: "user" }));
	assert.ok(!result, "no re-pricing for a non-assistant message");
});

check("message_end ignores messages without usage", () => {
	const result = runMessageEnd(assistantMessage({ usage: undefined }));
	assert.ok(!result, "no re-pricing without usage");
});

check(
	"message_end with an undefined timestamp falls back to now() without throwing",
	() => {
		// The fallback is wall-clock dependent, so accept either tier of the model.
		const result = runMessageEnd(
			assistantMessage({
				model: "deepseek-v4-flash",
				responseModel: "deepseek-flash",
				timestamp: undefined,
			}),
		);
		const cost = costFrom(result);
		closeCost(cost, flashCostAtNow(), "flash at the current tier");
	},
);

check(
	"message_end with a NaN timestamp falls back to now() without throwing",
	() => {
		const result = runMessageEnd(
			assistantMessage({
				model: "deepseek-v4-flash",
				responseModel: "deepseek-flash",
				timestamp: Number.NaN,
			}),
		);
		closeCost(costFrom(result), flashCostAtNow(), "flash at the current tier");
	},
);

check("extension registers the /deepseek-tier command", () => {
	assert.ok(fake.commands.has("deepseek-tier"), "command must be registered");
});

check(
	"/deepseek-tier reports the legacy routing note and a legal V4.1 Flash rate",
	() => {
		// The handler notifies synchronously (nothing is awaited before
		// `ctx.ui.notify`), so the sync harness can drive the captured definition
		// with a fake ctx: the wall clock still picks the tier, so accept either
		// legal Flash rate pair. A legacy id makes the routing note deterministic.
		const definition = fake.commands.get("deepseek-tier") as
			| { handler: (args: unknown, ctx: unknown) => unknown }
			| undefined;
		assert.ok(definition, "command definition must be registered");
		const notifications: Array<{ text: string; kind?: string }> = [];
		void definition.handler("", {
			model: { id: "deepseek-v4-flash" },
			ui: {
				notify: (text: string, kind?: string) =>
					notifications.push({ text, kind }),
			},
		});
		assert.equal(notifications.length, 1, "handler must notify exactly once");
		const { text } = notifications[0];
		assert.match(
			text,
			/\[legacy id, routed to V4\.1 Flash\]/,
			`routing note missing from: ${text}`,
		);
		const flashPeak = "input $0.3/M, output $1.2/M, cacheRead $0.006/M";
		const flashOffPeak = "input $0.15/M, output $0.6/M, cacheRead $0.003/M";
		assert.ok(
			text.includes(flashPeak) || text.includes(flashOffPeak),
			`no V4.1 Flash rate in: ${text}`,
		);
	},
);

// ── 7. footer tier status ─────────────────────────────────────────────
// A throwaway agent dir makes the settings lookup deterministic instead of
// reading the developer's real ~/.pi/agent/settings.json.
const agentDir = mkdtempSync(join(tmpdir(), "deepseek-pricing-test-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const statusCalls: Array<[string, string | undefined]> = [];
const statusCtx = {
	cwd: agentDir,
	isProjectTrusted: () => false,
	ui: {
		setStatus: (key: string, value: string | undefined) => {
			statusCalls.push([key, value]);
		},
	},
} as unknown as ExtensionContext;

function fireEvent(name: string): void {
	const handler = fake.handlers.get(name);
	assert.ok(handler, `extension must register a ${name} handler`);
	handler({}, statusCtx);
}

process.env.PI_CODING_AGENT_DIR = agentDir;
try {
	check("footer status shows the current tier once, and only on change", () => {
		fireEvent("session_start");
		assert.deepEqual(statusCalls, [["deepseek-tier", expectedStatusNow()]]);
		fireEvent("session_start");
		assert.equal(statusCalls.length, 1, "unchanged status must not refresh");
	});

	check("footer status honors showTierStatus=false", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ deepseekPricingByTime: { showTierStatus: false } }),
		);
		fireEvent("turn_end");
		assert.deepEqual(statusCalls[1], ["deepseek-tier", undefined]);
	});

	check("footer status re-enables from the boolean setting form", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ deepseekPricingByTime: true }),
		);
		fireEvent("model_select");
		assert.deepEqual(statusCalls[2], ["deepseek-tier", expectedStatusNow()]);
	});
} finally {
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
}

// ── summary ───────────────────────────────────────────────────────────

console.log(
	`\n${failed === 0 ? "✓" : "✗"} deepseek-pricing-by-time: ${passed} passed, ${failed} failed`,
);
if (failed > 0) process.exitCode = 1;
