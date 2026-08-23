// Smoke test for sticky-last-prompt, run against the REAL TuiAltScreen and
// ScrollView from the installed pi-tui (no mocks of pi internals).
//
// Node ≥ 23.6 strips this file's (erasable-only) TypeScript natively. It
// compiles sticky-last-prompt.ts itself into a temp dir inside the repo
// (parameter properties need real TS; the location keeps `@earendil-works/*`
// bare imports resolving against the workspace node_modules), installs the
// extension's patches exactly the way pi's per-frame widget hook would, then
// drives raw SGR mouse sequences through handleViewportInput.
//
// Run: npm run test:sticky-last-prompt   (or: node extensions/sticky-last-prompt/tests/test.ts)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	Container,
	ScrollView,
	TuiAltScreen,
	type Component,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	UserMessageComponent,
	initTheme,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
initTheme("dark"); // UserMessageComponent.render needs pi's global theme

// ── compile the extension (parameter properties need real TS) ─────────
const tmpDir = join(root, ".tmp-slp-test");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
try {
	const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.CMD" : "tsc");
	execFileSync(tsc, [
		join(here, "..", "sticky-last-prompt.ts"),
		"--outDir", tmpDir,
		"--module", "nodenext",
		"--target", "es2022",
		"--moduleResolution", "nodenext",
		"--skipLibCheck",
	], { cwd: root });
	const { default: stickyLastPrompt } = (await import(
		pathToFileURL(join(tmpDir, "sticky-last-prompt.js")).href
	)) as { default: (pi: ExtensionAPI) => void };
	await runTests(stickyLastPrompt);
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}

async function runTests(stickyLastPrompt: (pi: ExtensionAPI) => void): Promise<void> {
	// ── fake terminal (80×24) ─────────────────────────────────────
	const fakeTerminal: Terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return 80; }, get rows() { return 24; },
		get kittyProtocolActive() { return false; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
		clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};

	// ── transcript: 5 lines, a real user message at offset 5, then scroll
	// room so the jump target isn't clamped and the thumb is draggable ──
	const spacer: Component = { render: () => Array.from({ length: 5 }, (_, i) => `pad ${i}`), invalidate() {} };
	const tail: Component = { render: () => Array.from({ length: 25 }, (_, i) => `tail ${i}`), invalidate() {} };
	const message = new UserMessageComponent("hello world");
	const document_ = new Container();
	document_.addChild(spacer);
	document_.addChild(message);
	document_.addChild(tail);
	const scrollView = new ScrollView(document_, {
		primary: true,
		scrollbar: "always",
	});
	const tui = new TuiAltScreen(fakeTerminal);
	tui.setLayoutRoot(scrollView);

	// Runtime internals of TuiAltScreen that assertions need (private upstream;
	// accessed through a structural cast like the extension itself does).
	interface AltScreenInternals {
		scrollbarDrag?: { scrollView: ScrollView; grabOffset: number } | undefined;
		handleViewportInput(data: string): unknown;
		getScrollbarTargetAt(x: number, y: number): { scrollView: ScrollView } | undefined;
	}
	const screen = tui as unknown as AltScreenInternals;
	// contentHeight is private upstream too.
	const scroll = scrollView as unknown as Omit<ScrollView, "contentHeight"> & {
		contentHeight: number;
	};

	// ── minimal ExtensionAPI / context harness ────────────────────
	type WidgetFactory = (tui: TUI, theme: Theme) => Component;
	const handlers: Record<string, (...args: any[]) => unknown> = {};
	stickyLastPrompt({
		on: (event: string, handler: (...args: any[]) => unknown) => {
			handlers[event] = handler;
		},
	} as unknown as ExtensionAPI);
	let widgetFactory: WidgetFactory | undefined;
	const fakeTheme = {
		fg: (_kind: string, text: string) => text,
		bg: (_kind: string, text: string) => text,
	} as unknown as Theme;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { setWidget: (_id: string, fn?: WidgetFactory) => { widgetFactory = fn; } },
		sessionManager: { getEntries: () => [] as unknown[] },
	};
	await handlers["session_start"]({}, ctx);
	widgetFactory!(tui, fakeTheme); // pi calls the widget hook every frame
	tui.start(); // sets altScreenActive
	tui.renderNow(true);

	handlers["before_agent_start"]({ prompt: "hello world" }); // pins the bar
	widgetFactory!(tui, fakeTheme);
	tui.renderNow(true);

	assert.equal(tui.hasOverlayEntries, true, "bar overlay should be present");
	assert.equal(tui.hasOverlay(), false, "patched hasOverlay: bar alone is not an overlay");

	// ── scrollbar math (mirrors pi's getScrollbarGeometry) ─────────
	const trackHeight = 24;
	const contentHeight = scroll.contentHeight;
	assert.ok(contentHeight > trackHeight, "fixture must overflow the viewport");
	const thumbHeight = Math.max(
		Math.min(2, trackHeight),
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = contentHeight - trackHeight;
	const maxThumbOffset = trackHeight - thumbHeight;
	const thumbOffsetAt = (scrollTop: number) =>
		maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * maxThumbOffset);

	// ── click-to-jump works while the scrollbar is live ────────────
	// Last user message starts at document row 5; landing just below the
	// one-row bar → scrollTop 4.
	screen.handleViewportInput("\x1b[<0;11;1M"); // left press at x=10, y=0 (bar row)
	assert.equal(scrollView.scrollTop, 4, "bar click scrolls the message below the bar");

	// ── scrollbar dragging works while only the bar overlay shows ──
	// Press exactly at thumbTop + 1 so grabOffset is deterministically 1.
	const initialThumbOffset = thumbOffsetAt(scrollView.scrollTop);
	const pressY = initialThumbOffset + 1;
	const target = screen.getScrollbarTargetAt(79, pressY);
	assert.ok(target, "getScrollbarTargetAt must find the thumb while only the bar is shown");
	assert.equal(target!.scrollView, scrollView);

	const sgrPress = (col: number, row: number) => `\x1b[<0;${col};${row}M`;
	const sgrMotion = (col: number, row: number) => `\x1b[<32;${col};${row}M`;
	const sgrRelease = (col: number, row: number) => `\x1b[<0;${col};${row}m`;
	screen.handleViewportInput(sgrPress(80, pressY)); // grabOffset = 1
	assert.ok(screen.scrollbarDrag, "press on thumb starts a drag");
	const motionY = pressY + 5;
	screen.handleViewportInput(sgrMotion(80, motionY));
	const newThumbOffset = Math.min(maxThumbOffset, motionY - 1);
	assert.equal(
		scrollView.scrollTop,
		Math.round((newThumbOffset / maxThumbOffset) * maxScrollTop),
		"drag moves scrollTop per pi's thumb math",
	);
	screen.handleViewportInput(sgrRelease(80, motionY));
	assert.equal(screen.scrollbarDrag, undefined, "release stops drag");

	// ── stock suppression returns when a foreign overlay shows ─────
	const dialog: Component = { render: () => ["dialog"], invalidate() {} };
	const handle = tui.showOverlay(dialog); // capturing overlay
	tui.renderNow(true);
	assert.equal(tui.hasOverlay(), true, "foreign overlay restores hasOverlay");
	assert.equal(screen.getScrollbarTargetAt(79, pressY), undefined, "suppressed under foreign overlay");
	handle.hide();
	widgetFactory!(tui, fakeTheme);
	tui.renderNow(true);
	assert.ok(
		screen.getScrollbarTargetAt(79, thumbOffsetAt(scrollView.scrollTop) + 1),
		"draggable again after foreign overlay hides",
	);

	// ── uninstall (session_shutdown) removes instance overrides ────
	await handlers["session_shutdown"]({}, ctx);
	assert.equal(Object.hasOwn(tui, "hasOverlay"), false, "own-property hasOverlay removed");
	assert.equal(
		Object.hasOwn(tui, "handleSelectionMouseEvent"),
		false,
		"own-property click patch removed",
	);
	assert.equal(typeof TuiAltScreen.prototype.hasOverlay.call(tui), "boolean", "prototype method intact");

	console.log("✓ sticky-last-prompt smoke tests passed (jump, drag, suppression, cleanup)");
}
