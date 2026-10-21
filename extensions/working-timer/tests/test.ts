// Test suite for working-timer, run against the real installed
// pi-coding-agent types — but with an injected clock and scheduler, so every
// assertion is about *this* extension's state machine and event wiring, not
// about pi's rendering or about elapsed wall-clock time.
//
// Node ≥ 23.6 strips this file's (erasable-only) TypeScript natively, and the
// extension module next to it is erasable too, so it is imported directly.
//
// Run: node extensions/working-timer/tests/test.ts
//  or: npm test -w pi-working-timer

import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	formatElapsed,
	formatWorkingMessage,
	registerWorkingTimer,
	WorkingTimer,
} from "../working-timer.ts";

// ── tiny labelled-check harness ───────────────────────────────────────
const failures: string[] = [];
function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
		console.log(`  FAIL ${name}`);
	}
}

// ── fakes ─────────────────────────────────────────────────────────────

interface RecordedCtx {
	ctx: ExtensionContext;
	/** Every `setWorkingMessage` argument, in call order (`undefined` = clear). */
	messages: (string | undefined)[];
}

function fakeCtx(mode: "tui" | "rpc" | "print" = "tui"): RecordedCtx {
	const messages: (string | undefined)[] = [];
	const ctx = {
		mode,
		ui: {
			setWorkingMessage: (message?: string) => messages.push(message),
		},
	} as unknown as ExtensionContext;
	return { ctx, messages };
}

type Handler = (event: unknown, ctx: ExtensionContext) => void;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		emit(event: string, payload: unknown, ctx: ExtensionContext) {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

/** Scheduler stand-in: records the interval, and lets a test fire a tick. */
function fakeScheduler() {
	let tick: (() => void) | undefined;
	const intervals: number[] = [];
	let cancels = 0;
	return {
		schedule: (fn: () => void, ms: number) => {
			tick = fn;
			intervals.push(ms);
			return () => {
				cancels++;
				tick = undefined;
			};
		},
		fire: () => tick?.(),
		intervals,
		get cancels() {
			return cancels;
		},
		get active() {
			return tick !== undefined;
		},
	};
}

/** A movable clock plus a scheduler, wired to the extension's own register(). */
function harness(mode: "tui" | "rpc" | "print" = "tui") {
	let now = 1_000_000;
	const scheduler = fakeScheduler();
	const recorded = fakeCtx(mode);
	const api = fakePi();
	registerWorkingTimer(api.pi, {
		now: () => now,
		schedule: scheduler.schedule,
	});
	return {
		...recorded,
		...api,
		scheduler,
		advance(ms: number) {
			now += ms;
		},
		get lastMessage() {
			return recorded.messages.at(-1);
		},
	};
}

// ── formatting ────────────────────────────────────────────────────────

check("formatElapsed: sub-second and seconds", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(999), "0s");
	assert.equal(formatElapsed(1000), "1s");
	assert.equal(formatElapsed(12_400), "12s");
	assert.equal(formatElapsed(59_999), "59s");
});

check("formatElapsed: minutes zero-pad the seconds", () => {
	assert.equal(formatElapsed(60_000), "1m 00s");
	assert.equal(formatElapsed(64_400), "1m 04s");
	assert.equal(formatElapsed(599_000), "9m 59s");
	assert.equal(formatElapsed(3_599_000), "59m 59s");
});

check("formatElapsed: hours replace the seconds field", () => {
	assert.equal(formatElapsed(3_600_000), "1h 00m");
	assert.equal(formatElapsed(3_723_000), "1h 02m");
	assert.equal(formatElapsed(86_400_000), "24h 00m");
});

check("formatElapsed: a negative delta (clock skew) clamps to 0s", () => {
	assert.equal(formatElapsed(-5_000), "0s");
});

check("formatWorkingMessage: appends to pi's label", () => {
	assert.equal(formatWorkingMessage(0), "Working · 0s");
	assert.equal(formatWorkingMessage(64_000), "Working · 1m 04s");
	assert.equal(formatWorkingMessage(64_000, "Thinking"), "Thinking · 1m 04s");
});

// ── state machine ─────────────────────────────────────────────────────

check("WorkingTimer: paints on start, then once per tick", () => {
	let now = 0;
	const painted: (string | undefined)[] = [];
	const scheduler = fakeScheduler();
	const timer = new WorkingTimer((message) => painted.push(message), {
		now: () => now,
		schedule: scheduler.schedule,
	});

	timer.start();
	assert.deepEqual(painted, ["Working · 0s"]);
	// The cadence is the product (one repaint per second), so the literal is
	// asserted — not the exported constant, which the implementation feeds in
	// and which would make this assertion a restatement of the code.
	assert.deepEqual(scheduler.intervals, [1000]);

	now = 3_000;
	scheduler.fire();
	assert.deepEqual(painted, ["Working · 0s", "Working · 3s"]);
});

check("WorkingTimer: a recorded submission precedes agent_start", () => {
	let now = 0;
	const painted: (string | undefined)[] = [];
	const scheduler = fakeScheduler();
	const timer = new WorkingTimer((message) => painted.push(message), {
		now: () => now,
		schedule: scheduler.schedule,
	});

	timer.noteInput();
	now = 700; // prompt expansion / queue flush before agent_start
	timer.start();
	now = 1_300;
	scheduler.fire();
	// Counted from the keystroke (1.3s → "1s"), not from agent_start (0.6s →
	// "0s"); the two straddle a second boundary, so rounding cannot hide a
	// regression here.
	assert.equal(painted.at(-1), "Working · 1s");
});

check("WorkingTimer: submissions during a run keep the existing clock", () => {
	let now = 0;
	const painted: (string | undefined)[] = [];
	const scheduler = fakeScheduler();
	const timer = new WorkingTimer((message) => painted.push(message), {
		now: () => now,
		schedule: scheduler.schedule,
	});

	timer.start();
	now = 1_000;
	timer.noteInput(); // steer / follow-up while streaming
	timer.start(); // a further agent loop iteration, if pi emits one
	now = 2_000;
	scheduler.fire();
	assert.deepEqual(painted, ["Working · 0s", "Working · 2s"]);
	assert.equal(scheduler.intervals.length, 1, "ticker was scheduled twice");
});

check("WorkingTimer: stop clears, cancels, and stays silent afterwards", () => {
	const now = 0;
	const painted: (string | undefined)[] = [];
	const scheduler = fakeScheduler();
	const timer = new WorkingTimer((message) => painted.push(message), {
		now: () => now,
		schedule: scheduler.schedule,
	});

	timer.start();
	timer.stop();
	assert.deepEqual(painted, ["Working · 0s", undefined]);
	assert.equal(scheduler.cancels, 1);
	assert.equal(scheduler.active, false);
	assert.equal(timer.running, false);

	scheduler.fire(); // nothing is scheduled any more
	assert.equal(painted.length, 2);
});

check("WorkingTimer: stop is idempotent and silent when nothing ran", () => {
	const painted: (string | undefined)[] = [];
	const timer = new WorkingTimer((message) => painted.push(message), {
		schedule: fakeScheduler().schedule,
	});

	timer.stop();
	timer.stop();
	assert.deepEqual(painted, [], "cleared a message it never set");

	timer.start();
	timer.stop();
	timer.stop();
	assert.deepEqual(painted, ["Working · 0s", undefined]);
});

check("WorkingTimer: a submission that never became a run is dropped", () => {
	let now = 0;
	const painted: (string | undefined)[] = [];
	const timer = new WorkingTimer((message) => painted.push(message), {
		now: () => now,
		schedule: fakeScheduler().schedule,
	});

	timer.noteInput();
	timer.stop(); // run never started (input was handled by another extension)
	now = 10_000;
	timer.start(); // unrelated run, e.g. extension-injected
	assert.deepEqual(painted, ["Working · 0s"]);
});

// ── event wiring ──────────────────────────────────────────────────────

check("wiring: input alone paints nothing and schedules nothing", () => {
	const h = harness();
	h.emit("input", { type: "input", text: "hi", source: "interactive" }, h.ctx);
	assert.deepEqual(h.messages, []);
	assert.equal(h.scheduler.intervals.length, 0);
});

check("wiring: a run times from the submitted prompt", () => {
	const h = harness();
	h.emit("input", { type: "input", text: "hi", source: "interactive" }, h.ctx);
	h.advance(300);
	h.emit("agent_start", { type: "agent_start" }, h.ctx);
	assert.equal(h.lastMessage, "Working · 0s");

	h.advance(1_700);
	h.scheduler.fire();
	assert.equal(h.lastMessage, "Working · 2s");
});

check("wiring: an extension-injected run times from agent_start", () => {
	const h = harness();
	h.emit("input", { type: "input", text: "hi", source: "extension" }, h.ctx);
	h.advance(5_000);
	h.emit("agent_start", { type: "agent_start" }, h.ctx);
	assert.equal(h.lastMessage, "Working · 0s");

	h.advance(1_000);
	h.scheduler.fire();
	assert.equal(h.lastMessage, "Working · 1s");
});

check("wiring: agent_settled hands the working message back", () => {
	const h = harness();
	const run = [
		["input", { type: "input", text: "hi", source: "interactive" }],
		["agent_start", { type: "agent_start" }],
	] as const;
	for (const [event, payload] of run) h.emit(event, payload, h.ctx);
	h.emit("agent_settled", { type: "agent_settled" }, h.ctx);

	assert.deepEqual(h.messages, ["Working · 0s", undefined]);
	assert.equal(h.scheduler.cancels, 1);

	// The next run starts from zero.
	h.advance(60_000);
	h.emit(
		"input",
		{ type: "input", text: "again", source: "interactive" },
		h.ctx,
	);
	h.emit("agent_start", { type: "agent_start" }, h.ctx);
	assert.equal(h.lastMessage, "Working · 0s");
});

check(
	"wiring: session_shutdown stops a live run and clears the message",
	() => {
		const h = harness();
		h.emit("agent_start", { type: "agent_start" }, h.ctx);
		assert.equal(h.lastMessage, "Working · 0s");

		h.emit("session_shutdown", { type: "session_shutdown" }, h.ctx);
		assert.equal(h.lastMessage, undefined);
		assert.equal(h.scheduler.active, false);
	},
);

check("wiring: session_shutdown while idle clears nothing", () => {
	const h = harness();
	// Handle an event first: shutdown alone would leave the paint target unset
	// in this fake, so the assertion would pass without testing anything.
	h.emit("input", { type: "input", text: "hi", source: "interactive" }, h.ctx);
	h.emit("session_shutdown", { type: "session_shutdown" }, h.ctx);
	assert.deepEqual(h.messages, []);
});

check("wiring: non-TUI modes never paint or schedule", () => {
	for (const mode of ["rpc", "print"] as const) {
		const h = harness(mode);
		h.emit(
			"input",
			{ type: "input", text: "hi", source: "interactive" },
			h.ctx,
		);
		h.emit("agent_start", { type: "agent_start" }, h.ctx);
		h.emit("agent_settled", { type: "agent_settled" }, h.ctx);
		assert.deepEqual(h.messages, [], `${mode}: painted`);
		assert.equal(
			h.scheduler.intervals.length,
			0,
			`${mode}: scheduled a ticker`,
		);
	}
});

// ── result ────────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("\nall checks passed");
