// Test suite for focus-aware-blinking-cursor-and-border, run against the REAL
// editor classes from the installed pi-tui / pi-coding-agent (no mocks of pi
// internals) — the rendered lines under test are ones the real editor emits.
//
// Node ≥ 23.6 strips this file's (erasable-only) TypeScript natively, and the
// extension module next to it is erasable too, so it is imported directly.
//
// Run: node extensions/focus-aware-blinking-cursor-and-border/tests/test.ts
//  or: npm test -w pi-focus-aware-blinking-cursor
//
// The cursor cell has been encoded two ways across pi-tui releases — reverse
// video SGR before 1.2.0, zero-width APC markers from 1.2.0 on, resolved to
// reverse video by the TUI *after* extension render hooks run. Both forms are
// asserted explicitly, so the suite pins the fix even when the installed
// pi-tui only produces one of them.

import assert from "node:assert/strict";
import {
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import {
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	getKeybindings,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	BlinkingCursorEditor,
	default as blinkingCursor,
	hideCursorCells,
	shouldHideCursor,
} from "../focus-aware-blinking-cursor-and-border.ts";

initTheme("dark"); // CustomEditor.render reaches pi's global theme

// The sequences pi-tui wraps the cursor cell in from 1.2.0 on (not exported
// from the package index, which is why the extension carries its own copies).
const FC_START = "\x1b_pi:fc\x07";
const FC_END = "\x1b_pi:/fc\x07";
const SGR_REVERSE = "\x1b[7m";
const DIM = "\x1b[2m"; // what the fake theme's `dim` fg returns

// Same probe the extension uses: pi-tui >= 1.2.0 resolves the fake cursor cell
// itself and lets the terminal's cursor blink; older releases always paint
// their own reverse-video cell, so the extension keeps blinking there. The
// check below pins the probe against what the installed editor really emits.
const NATIVE_HARDWARE_CURSOR = "renderFakeCursor" in piTui;

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

/** Does this rendered frame show the cursor cell at all? */
function hasCursorCell(lines: string[]): boolean {
	const frame = lines.join("\n");
	return (
		frame.includes(CURSOR_MARKER) ||
		frame.includes(FC_START) ||
		frame.includes(SGR_REVERSE)
	);
}

/** Does anything in this frame still draw a cursor cell? */
function hasCursorHighlight(lines: string[]): boolean {
	const frame = lines.join("\n");
	return (
		frame.includes(CURSOR_MARKER) ||
		frame.includes(FC_START) ||
		frame.includes(FC_END) ||
		frame.includes(SGR_REVERSE)
	);
}

// ── real editor instances ─────────────────────────────────────────────

/** A TUI stand-in carrying only what the editor and the extension read. */
function fakeTui(hardwareCursor: boolean): TUI {
	return {
		getShowHardwareCursor: () => hardwareCursor,
		requestRender: () => {},
		terminal: { rows: 40, columns: 100 },
	} as unknown as TUI;
}

/** EditorTheme stand-in: borders unpainted, `dim` painted with a real SGR. */
function fakeEditorTheme(): EditorTheme {
	const dim = (s: string) => `${DIM}${s}\x1b[22m`;
	return {
		borderColor: (s: string) => s,
		selectList: {},
		dim,
	} as unknown as EditorTheme;
}

function fakeCtx(): ExtensionContext {
	return {
		ui: {
			theme: {
				fg: (color: string, s: string) =>
					color === "dim" ? `${DIM}${s}\x1b[22m` : s,
			},
		},
	} as unknown as ExtensionContext;
}

function makeEditor({
	hardwareCursor,
	terminalFocused = true,
}: {
	hardwareCursor: boolean;
	terminalFocused?: boolean;
}): BlinkingCursorEditor {
	return new BlinkingCursorEditor(
		fakeTui(hardwareCursor),
		fakeEditorTheme(),
		// pi-tui's manager is the one pi hands over; newer pi releases type a
		// wider subclass of it, so cast through unknown.
		getKeybindings() as unknown as KeybindingsManager,
		fakeCtx(),
		() => terminalFocused,
	);
}

const TEXT = "hi";

// ── shouldHideCursor: the whole focus/blink matrix ────────────────────
console.log("shouldHideCursor");
const matrix: Array<{
	name: string;
	input: Parameters<typeof shouldHideCursor>[0];
	expected: boolean;
}> = [
	{
		name: "TUI focus + window focus + hardware cursor → untouched (terminal blinks)",
		input: {
			focused: true,
			terminalFocused: true,
			hardwareCursor: true,
			cursorVisible: false,
		},
		expected: false,
	},
	{
		name: "TUI focus + window focus + pi's own cursor, blink on → visible",
		input: {
			focused: true,
			terminalFocused: true,
			hardwareCursor: false,
			cursorVisible: true,
		},
		expected: false,
	},
	{
		name: "TUI focus + window focus + pi's own cursor, blink off → hidden",
		input: {
			focused: true,
			terminalFocused: true,
			hardwareCursor: false,
			cursorVisible: false,
		},
		expected: true,
	},
	{
		name: "editor unfocused (selector/overlay open) → hidden",
		input: {
			focused: false,
			terminalFocused: true,
			hardwareCursor: true,
			cursorVisible: true,
		},
		expected: true,
	},
	{
		name: "terminal window unfocused → hidden",
		input: {
			focused: true,
			terminalFocused: false,
			hardwareCursor: true,
			cursorVisible: true,
		},
		expected: true,
	},
];
for (const { name, input, expected } of matrix) {
	check(name, () => assert.equal(shouldHideCursor(input), expected));
}

// ── hideCursorCells: both encodings, layout intact ────────────────────
console.log("hideCursorCells");
check("strips zero-width fake-cursor markers (pi-tui >= 1.2.0)", () => {
	const lines = [`hi${CURSOR_MARKER}${FC_START}o${FC_END} there`];
	const hidden = hideCursorCells(lines);
	assert.equal(hidden[0], "hio there");
	assert.equal(hasCursorHighlight(hidden), false);
});

check("strips reverse-video SGR (pi-tui < 1.2.0, SGR 0 reset)", () => {
	const hidden = hideCursorCells([`hi${SGR_REVERSE}o\x1b[0m there`]);
	assert.equal(hidden[0], "hio there");
	assert.equal(hasCursorHighlight(hidden), false);
});

check("strips reverse-video SGR (pi-tui < 1.2.0, SGR 27 reset)", () => {
	const hidden = hideCursorCells([`hi${SGR_REVERSE}o\x1b[27m there`]);
	assert.equal(hidden[0], "hio there");
	assert.equal(hasCursorHighlight(hidden), false);
});

check("cursor at end of line keeps its width", () => {
	const lines = [
		`hi${SGR_REVERSE} \x1b[0m`,
		`hi${CURSOR_MARKER}${FC_START} ${FC_END}`,
	];
	const before = lines.map(visibleWidth);
	const hidden = hideCursorCells(lines);
	assert.deepEqual(hidden, ["hi ", "hi "]);
	assert.deepEqual(hidden.map(visibleWidth), before);
});

check("leaves cursor-free lines alone", () => {
	const lines = ["plain", "", "\x1b[1mbold\x1b[0m"];
	assert.deepEqual(hideCursorCells([...lines]), lines);
});

// ── against the installed pi-tui's own editor output ──────────────────
console.log("real pi-tui editor output");

/** Lines the installed pi-tui's editor emits for a focused, "hi"-typed prompt. */
function realEditorFrame(): string[] {
	const editor = new Editor(fakeTui(true), fakeEditorTheme(), { paddingX: 0 });
	editor.focused = true;
	editor.setText(TEXT);
	return editor.render(40);
}

check("the >= 1.2.0 capability probe matches what the editor emits", () => {
	// The extension decides whether the terminal blinks by itself from this
	// probe, so it must agree with the installed editor's cursor encoding.
	const frame = realEditorFrame();
	assert.equal(
		frame.join("\n").includes(FC_START),
		NATIVE_HARDWARE_CURSOR,
		`pi-tui ${NATIVE_HARDWARE_CURSOR ? "emits" : "does not emit"} fake-cursor markers`,
	);
	assert.equal(hasCursorCell(frame), true, "pi-tui drew no cursor cell at all");
});

check(
	"whatever pi-tui draws for the cursor gets hidden, width preserved",
	() => {
		const lines = realEditorFrame();
		const before = lines.map(visibleWidth);
		const hidden = hideCursorCells([...lines]);
		assert.equal(hasCursorHighlight(hidden), false);
		assert.deepEqual(hidden.map(visibleWidth), before);
		assert.match(hidden.join("\n"), /hi/);
	},
);

// ── the editor class: focus state decides, hardware cursor wins ───────
console.log("BlinkingCursorEditor");
check("hardware cursor on + focused: frame reported consistently", () => {
	const editor = makeEditor({ hardwareCursor: true });
	editor.focused = true;
	editor.setText(TEXT);
	const frame = editor.render(40).join("\n");
	if (NATIVE_HARDWARE_CURSOR) {
		// pi-tui drops its own cell and parks the terminal cursor: the marker and
		// the cell must survive untouched so the terminal blinks natively.
		assert.equal(frame.includes(CURSOR_MARKER), true);
		assert.equal(hasCursorHighlight([frame]), true);
		assert.equal(editor.wantsBlinkTicks(), false, "blink ticks while native");
	} else {
		// Older pi-tui paints its own cell regardless, so the blink stays ours:
		// a second blink would only fight a permanently visible block.
		assert.equal(
			editor.wantsBlinkTicks(),
			true,
			"no blink ticks, cursor frozen",
		);
		assert.equal(hasCursorHighlight([frame]), true, "blink lost its cell");
	}
});

check(
	"pi's own cursor + focused: blink phase starts visible, ticks are requested",
	() => {
		const editor = makeEditor({ hardwareCursor: false });
		editor.focused = true;
		editor.setText(TEXT);
		editor.poke();
		const lines = editor.render(40);
		assert.equal(editor.wantsBlinkTicks(), true);
		assert.equal(lines.join("\n").includes(CURSOR_MARKER), true);
		assert.equal(hasCursorHighlight(lines), true);
	},
);

check("editor unfocused: cursor hidden and no blink ticks", () => {
	const editor = makeEditor({ hardwareCursor: false });
	editor.focused = false;
	editor.setText(TEXT);
	const lines = editor.render(40);
	assert.equal(hasCursorHighlight(lines), false, "cursor cell still drawn");
	assert.equal(editor.wantsBlinkTicks(), false);
});

check(
	"terminal window unfocused: cursor hidden even with hardware cursor on",
	() => {
		const editor = makeEditor({ hardwareCursor: true, terminalFocused: false });
		editor.focused = true;
		editor.setText(TEXT);
		const lines = editor.render(40);
		assert.equal(hasCursorHighlight(lines), false, "cursor cell still drawn");
		assert.equal(editor.wantsBlinkTicks(), false);
	},
);

check("border dims while unfocused and keeps pi's color while focused", () => {
	const unfocused = makeEditor({ hardwareCursor: true });
	unfocused.focused = false;
	unfocused.setText(TEXT);
	assert.equal(unfocused.render(40).join("\n").includes(DIM), true);

	const focused = makeEditor({ hardwareCursor: true });
	focused.focused = true;
	focused.setText(TEXT);
	assert.equal(focused.render(40).join("\n").includes(DIM), false);
});

check(
	"dimmed border equals the fake theme's `dim` paint, not a hardcoded SGR",
	() => {
		const editor = makeEditor({ hardwareCursor: true });
		editor.focused = false;
		editor.setText(TEXT);
		const frame = editor.render(40).join("\n");
		assert.equal(frame.includes(`${DIM}╭`) || frame.includes(`${DIM}─`), true);
	},
);

// ── registration wiring ───────────────────────────────────────────────
console.log("registration");
check(
	"session_start installs an editor that delegates to the previous factory",
	() => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const pi = {
			on: (event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;

		const installed: Array<(...args: unknown[]) => unknown> = [];
		let delegated = 0;
		const ctx = {
			mode: "tui",
			ui: {
				theme: { fg: (_color: string, s: string) => s },
				getEditorComponent: () => () => {
					delegated += 1;
				},
				setEditorComponent: (factory: (...args: unknown[]) => unknown) => {
					installed.push(factory);
				},
			},
		} as unknown as ExtensionContext;

		blinkingCursor(pi);
		const start = handlers.get("session_start");
		assert.ok(start, "no session_start handler registered");
		start({}, ctx);
		assert.equal(installed.length, 1, "no editor factory installed");
		const factory = installed[0];
		if (!factory) throw new Error("no editor factory installed");

		const editor = factory(
			fakeTui(true),
			fakeEditorTheme(),
			getKeybindings() as unknown as KeybindingsManager,
		);
		assert.equal(editor instanceof BlinkingCursorEditor, true);
		assert.equal(delegated, 1, "previous editor factory was not delegated to");

		assert.doesNotThrow(() => handlers.get("session_shutdown")?.({}, ctx));
	},
);

// ── result ────────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("\nall checks passed");
