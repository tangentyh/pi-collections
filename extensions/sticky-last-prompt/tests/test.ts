// Smoke test for sticky-last-prompt, run against the REAL TuiAltScreen and
// ScrollView from the installed pi-tui (no mocks of pi internals).
//
// Node ≥ 23.6 strips this file's (erasable-only) TypeScript natively. It
// compiles sticky-last-prompt.ts itself into a temp dir inside the repo
// (parameter properties need real TS; the location keeps `@earendil-works/*`
// bare imports resolving against the workspace node_modules), installs the
// extension's patches exactly the way pi's widget registration would, then
// drives raw SGR mouse sequences through handleViewportInput and asserts the
// bar's scroll-aware pin at several viewport positions.
//
// Run: npm test -w pi-sticky-last-prompt   (or: node extensions/sticky-last-prompt/tests/test.ts)

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
	SkillInvocationMessageComponent,
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

	// ── transcript fixture: spacer(5) · msgA · fillerA(30) · msgB · tail(25)
	const lines = (n: number, label: string): Component => ({
		render: () => Array.from({ length: n }, (_, i) => `${label} ${i}`),
		invalidate() {},
	});
	const spacer = lines(5, "pad");
	const fillerA = lines(30, "filler-a");
	const tail = lines(25, "tail");
	const msgA = new UserMessageComponent("first question");
	const msgB = new UserMessageComponent("second question");
	const document_ = new Container();
	document_.addChild(spacer);
	document_.addChild(msgA);
	document_.addChild(fillerA);
	document_.addChild(msgB);
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
	};
	await handlers["session_start"]({}, ctx);
	widgetFactory!(tui, fakeTheme); // pi invokes the factory once at setWidget time
	tui.start(); // sets altScreenActive
	tui.renderNow(true);

	assert.equal(tui.hasOverlayEntries, true, "bar overlay should be present");
	assert.equal(tui.hasOverlay(), false, "patched hasOverlay: bar alone is not an overlay");

	// ── expected document geometry, measured through the same render path
	// the extension uses (inner width excludes the scrollbar column) ────
	const innerWidth = scrollView.getContentWidth(80);
	const linesOf = (c: Component) => c.render(innerWidth).length;
	const startA = linesOf(spacer);
	const startB = startA + linesOf(msgA) + linesOf(fillerA);
	assert.equal(
		scroll.contentHeight,
		startB + linesOf(msgB) + linesOf(tail),
		"offset math must match the laid-out content height",
	);
	const trackHeight = scrollView.viewportHeight;
	assert.ok(scroll.contentHeight > trackHeight, "fixture must overflow the viewport");
	// UserMessageComponent renders multiline even for one-liners (Box padding);
	// guard it so the boundary asserts below prove multiline semantics.
	assert.ok(linesOf(msgA) >= 2 && linesOf(msgB) >= 2, "fixture messages render multiline");

	// ── read what the bar currently pins ───────────────────────────
	interface BarLike {
		renderedRows: number;
		render(width: number): string[];
	}
	const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const findBar = (): BarLike | undefined => {
		const stack = (tui as unknown as { overlayStack?: readonly { component?: unknown }[] })
			.overlayStack;
		return stack
			?.map((entry) => entry.component)
			.find((c): c is BarLike => !!c && typeof (c as BarLike).renderedRows === "number");
	};
	const barText = (): string => {
		const bar = findBar();
		assert.ok(bar, "bar overlay component present");
		return stripAnsi(bar.render(innerWidth).join(""));
	};
	const contentHeightOf = (view: ScrollView) =>
		(view as unknown as { contentHeight: number }).contentHeight;
	const scrollTo = (view: ScrollView, top: number) => {
		view.scrollTo(top, { disableFollow: true });
		tui.renderNow(true);
	};

	// ── selection tracks what has scrolled out of view ──────────────────────────────
	scrollTo(scrollView, 0);
	assert.equal(findBar()!.renderedRows, 0, "top of transcript: nothing scrolled away, zero rows");
	assert.equal(barText(), "", "top of transcript pins nothing");

	scrollTo(scrollView, startA);
	assert.doesNotMatch(barText(), /first|second/, "message at the very top row isn't pinned");

	scrollTo(scrollView, startA + 1);
	assert.equal(findBar()!.renderedRows, 0, "straddling message: bar hides instead of duplicating it");
	scrollTo(scrollView, startA + linesOf(msgA)); // entirely above the top now
	assert.match(barText(), /first question/, "fully scrolled-past message gets pinned");
	assert.doesNotMatch(barText(), /second question/);
	screen.handleViewportInput("\x1b[<0;11;1M"); // left press at x=10, y=0 (bar row)
	assert.equal(scrollView.scrollTop, Math.max(0, startA - 1), "bar click lands the shown message below the bar");

	scrollTo(scrollView, startB + 1);
	assert.equal(findBar()!.renderedRows, 0, "straddling multiline message blanks the bar");
	assert.doesNotMatch(barText(), /second question/, "no duplication while its tail is still painted");
	scrollTo(scrollView, startB + linesOf(msgB)); // entirely above the top now
	assert.match(barText(), /second question/, "fully-above multiline message pins");

	const maxScrollTop = scroll.contentHeight - trackHeight;
	scrollTo(scrollView, maxScrollTop);
	assert.match(barText(), /second question/, "bottom of transcript pins the latest message");

	screen.handleViewportInput("\x1b[<0;11;1M"); // click → jump to msgB - 1
	assert.equal(scrollView.scrollTop, Math.max(0, startB - 1), "click at bottom jumps to the latest message");

	scrollTo(scrollView, startB);
	assert.doesNotMatch(barText(), /second question/, "message at the top row still counts as visible");
	assert.match(barText(), /first question/, "…so the previous prompt keeps the pin");
	scrollTo(scrollView, startB + 1);
	assert.equal(findBar()!.renderedRows, 0, "one row down, msgB straddles and blanks the bar (no fallback)");
	scrollTo(scrollView, startB + linesOf(msgB));
	assert.match(barText(), /second question/, "once fully out of view, msgB takes the pin");

	// ── /tree-style rebuild ─────────────────────────────────────────
	// pi navigates branches with chatContainer.clear() + re-render, which
	// swaps the document's children array; the anchor cache keys on that
	// identity, so the bar follows the new tree immediately — even if the
	// rebuilt branch had the exact same rendered height.
	const branchedDoc = new Container();
	branchedDoc.addChild(lines(40, "lead-b")); // long preamble above its message
	branchedDoc.addChild(new UserMessageComponent("branched question"));
	branchedDoc.addChild(lines(25, "tail-b"));
	const branchedView = new ScrollView(branchedDoc, { primary: true, scrollbar: "always" });
	tui.setLayoutRoot(branchedView);
	tui.renderNow(true);

	// Above all messages → nothing pinned yet.
	scrollTo(branchedView, 0);
	assert.equal(findBar()!.renderedRows, 0, "above all messages the bar paints zero rows");
	assert.equal(barText(), "", "above all messages nothing is pinned");
	screen.handleViewportInput("\x1b[<0;11;1M"); // press on the covered top row
	assert.equal(branchedView.scrollTop, 0, "click falls through while nothing is pinned");

	scrollTo(branchedView, contentHeightOf(branchedView) - trackHeight);
	assert.match(barText(), /branched question/, "bar follows the rebuilt transcript");
	assert.doesNotMatch(barText(), /first question|second question/);

	// Restoring the original layout root restores its state too — including
	// its own scrollTop, left just past msgB's last row by the flip-point
	// test above.
	tui.setLayoutRoot(scrollView);
	tui.renderNow(true);
	assert.match(barText(), /second question/, "original transcript re-pins after layout restore");

	// ── scrollbar dragging works while only the bar overlay shows ──
	// Press exactly at thumbTop + 1 so grabOffset is deterministically 1.
	const thumbHeight = Math.max(
		Math.min(2, trackHeight),
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / scroll.contentHeight)),
	);
	const maxThumbOffset = trackHeight - thumbHeight;
	const thumbOffsetAt = (scrollTop: number) =>
		maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * maxThumbOffset);
	const initialThumbOffset = thumbOffsetAt(scrollView.scrollTop);
	const pressY = initialThumbOffset + 1;
	const target = screen.getScrollbarTargetAt(79, pressY);
	assert.ok(target, "getScrollbarTargetAt must find the thumb while only the bar is shown");
	assert.equal(target!.scrollView, scrollView);

	const sgrPress = (col: number, row: number) => `\x1b[<0;${col};${row}M`;
	const sgrMotion = (col: number, row: number) => `\x1b[<32;${col};${row}M`;
	const sgrRelease = (col: number, row: number) => `\x1b[<0;${col};${row}m`;
	screen.handleViewportInput(sgrPress(80, pressY));
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

	// ── resume lifecycle (the "always pins the last message" bug) ──
	// pi replaces the AgentSession on /resume and --continue: the old runner
	// gets session_shutdown, a NEW runtime re-invokes the extension factory,
	// and the transcript is rebuilt (chatContainer.clear + renderSessionEntries)
	// BEFORE session_start(resume) fires via bindExtensions. Each instance must
	// end up with a scroll-aware bar over the rebuilt transcript — not a static
	// seed of the last message.
	{
		const makeRegistry = () => {
			const reg: Record<string, (...args: any[]) => unknown> = {};
			return {
				reg,
				ctx: {
					mode: "tui",
					hasUI: true,
					ui: { setWidget: (_id: string, fn?: WidgetFactory) => {
						resumeFactory = fn;
					} },
				},
			};
		};
		let resumeFactory: WidgetFactory | undefined;

		// Isolated renderer + transcript so this scenario can't lean on state
		// from the earlier sections.
		const resumeTui = new TuiAltScreen(fakeTerminal);
		interface ResumeInternals {
			handleViewportInput(data: string): unknown;
		}
		const resumeScreen = resumeTui as unknown as ResumeInternals;
		const resumeDoc = new Container();
		const resumeView = new ScrollView(resumeDoc, { primary: true, scrollbar: "always" });
		resumeTui.setLayoutRoot(resumeView);
		resumeTui.start();

		const resumeBarText = (): string => {
			const stack = (resumeTui as unknown as { overlayStack?: readonly { component?: unknown }[] })
				.overlayStack;
			const bar = stack
				?.map((entry) => entry.component)
				.find((c): c is BarLike => !!c && typeof (c as BarLike).renderedRows === "number");
			assert.ok(bar, "resume scenario: bar overlay present");
			return stripAnsi(bar.render(innerWidth).join(""));
		};
		const resumeScrollTo = (top: number) => {
			resumeView.scrollTo(top, { disableFollow: true });
			resumeTui.renderNow(true);
		};

		// Instance A: live session grows a transcript.
		const a = makeRegistry();
		stickyLastPrompt({ on: (event: string, handler: (...args: any[]) => unknown) => {
			a.reg[event] = handler;
		} } as unknown as ExtensionAPI);
		await a.reg["session_start"]({ type: "session_start", reason: "startup" }, a.ctx);
		assert.ok(resumeFactory, "instance A registered its widget");
		resumeFactory!(resumeTui, fakeTheme);
		resumeDoc.addChild(new UserMessageComponent("live question"));
		resumeDoc.addChild(lines(40, "live-filler"));
		resumeTui.renderNow(true);
		resumeScrollTo(contentHeightOf(resumeView)); // clamps to the bottom
		assert.match(resumeBarText(), /live question/, "instance A tracks the live transcript");

		// Teardown: instance A must fully uninstall its renderer patches…
		await a.reg["session_shutdown"]({ type: "session_shutdown", reason: "resume" }, a.ctx);
		assert.equal(
			Object.hasOwn(resumeTui, "hasOverlay"),
			false,
			"instance A removed its hasOverlay override",
		);

		// …pi re-runs the same module factory for the new runtime (fresh closure
		// state: fresh cache, fresh WeakSet, fresh bar)…
		const b = makeRegistry();
		stickyLastPrompt({ on: (event: string, handler: (...args: any[]) => unknown) => {
			b.reg[event] = handler;
		} } as unknown as ExtensionAPI);

		// …rebuilds the transcript FIRST (renderCurrentSessionState order)…
		resumeDoc.clear();
		resumeDoc.addChild(new UserMessageComponent("resumed question one"));
		resumeDoc.addChild(lines(30, "resumed-filler-one"));
		resumeDoc.addChild(new UserMessageComponent("resumed question two"));
		resumeDoc.addChild(lines(30, "resumed-filler-two"));
		resumeDoc.addChild(new UserMessageComponent("resumed question three"));
		resumeDoc.addChild(lines(25, "resumed-tail"));

		// …and only then emits session_start for the resumed session.
		await b.reg["session_start"]({ type: "session_start", reason: "resume" }, b.ctx);
		assert.ok(resumeFactory, "instance B registered its widget");
		resumeFactory!(resumeTui, fakeTheme); // setWidget invokes the factory synchronously
		resumeTui.renderNow(true);

		assert.equal(
			Object.hasOwn(resumeTui, "handleSelectionMouseEvent"),
			true,
			"instance B reinstalled the click patch",
		);
		assert.equal(resumeTui.hasOverlay(), false, "instance B bar alone is still overlay-free");

		// Scroll-aware over the RESUMED transcript — never a stale/static seed.
		const startThree =
			linesOf(new UserMessageComponent("resumed question one")) +
			30 +
			linesOf(new UserMessageComponent("resumed question two")) +
			30;
		resumeScrollTo(contentHeightOf(resumeView)); // clamps to bottom
		assert.match(resumeBarText(), /resumed question three/, "bottom pins the latest message");
		resumeScreen.handleViewportInput("\x1b[<0;11;1M"); // click bar at bottom
		assert.equal(
			resumeView.scrollTop,
			Math.max(0, startThree - 1),
			"click after resume jumps to the pinned message",
		);
		resumeScrollTo(0);
		assert.equal(resumeBarText(), "", "top of the resumed transcript pins nothing yet");
		resumeScreen.handleViewportInput("\x1b[<0;11;1M");
		assert.equal(resumeView.scrollTop, 0, "click falls through while nothing is pinned");
		resumeScrollTo(
			linesOf(new UserMessageComponent("resumed question one")) +
				30 +
				linesOf(new UserMessageComponent("resumed question two")),
		); // entirely past question two
		assert.match(resumeBarText(), /resumed question two/, "resumed transcript pins per scroll too");
		assert.doesNotMatch(resumeBarText(), /three/, "no static last-message seed survives resume");

		await b.reg["session_shutdown"]({ type: "session_shutdown", reason: "shutdown" }, b.ctx);
	}

	// ── skill invocations are prompts too ──────────────────────────
	// pi renders `/skill` invocations as collapsible `[skill] name` blocks,
	// not UserMessageComponents — they must pin like any other prompt.
	{
		const skillTui = new TuiAltScreen(fakeTerminal);
		interface SkillInternals {
			handleViewportInput(data: string): unknown;
		}
		const skillScreen = skillTui as unknown as SkillInternals;
		const skillHandlers: Record<string, (...args: any[]) => unknown> = {};
		const skillDoc = new Container();
		const skillView = new ScrollView(skillDoc, { primary: true, scrollbar: "always" });
		skillTui.setLayoutRoot(skillView);
		skillTui.start();
		const skillSpacer = lines(5, "pad-s");
		const skillBlock = new SkillInvocationMessageComponent({
			name: "commit",
			location: "/skills/commit/SKILL.md",
			content: "commit body",
			userMessage: undefined,
		}); // userMessage absent → no UserMessageComponent rendered at all
		const skillFiller = lines(30, "filler-s");
		const afterSkill = new UserMessageComponent("plain question after skill");
		skillDoc.addChild(skillSpacer);
		skillDoc.addChild(skillBlock);
		skillDoc.addChild(skillFiller);
		skillDoc.addChild(afterSkill);
		skillDoc.addChild(lines(25, "tail-s"));
		// Fresh extension instance (a live /reload-style binding), wired to THIS
		// renderer — reusing an earlier instance's factory would keep its
		// existing overlay on the old renderer and never show the bar here.
		let skillFactory: WidgetFactory | undefined;
		stickyLastPrompt({
			on: (event: string, handler: (...args: any[]) => unknown) => {
				skillHandlers[event] = handler;
			},
		} as unknown as ExtensionAPI);
		await skillHandlers["session_start"]({ type: "session_start", reason: "startup" }, {
			mode: "tui",
			hasUI: true,
			ui: { setWidget: (_id: string, fn?: WidgetFactory) => {
				skillFactory = fn;
			} },
		});
		skillFactory!(skillTui, fakeTheme);
		skillTui.renderNow(true);

		const skillBarText = (): string => {
			const stack = (skillTui as unknown as { overlayStack?: readonly { component?: unknown }[] })
				.overlayStack;
			const bar = stack
				?.map((entry) => entry.component)
				.find((c): c is BarLike => !!c && typeof (c as BarLike).renderedRows === "number");
			assert.ok(bar, "skill scenario: bar overlay present");
			return stripAnsi(bar.render(innerWidth).join(""));
		};
		const skillScrollTo = (top: number) => {
			skillView.scrollTo(top, { disableFollow: true });
			skillTui.renderNow(true);
		};

		const startSkill = linesOf(skillSpacer); // skill block right after the spacer
		const startAfter = startSkill + linesOf(skillBlock) + linesOf(skillFiller);

		// Bottom: the later plain prompt governs.
		skillScrollTo(contentHeightOf(skillView)); // clamps to bottom
		assert.match(skillBarText(), /plain question after skill/, "bottom pins the latest plain prompt");
		skillScreen.handleViewportInput("\x1b[<0;11;1M");
		assert.equal(
			skillView.scrollTop,
			Math.max(0, startAfter - 1),
			"click jumps to the plain prompt below the skill block",
		);

		// Entirely past the skill block: it becomes the pin, labeled exactly
		// like pi's own collapsed rendering.
		skillScrollTo(startSkill + linesOf(skillBlock));
		assert.match(skillBarText(), /\[skill\] commit/, "scrolled-past skill invocation pins as [skill] name");
		assert.doesNotMatch(skillBarText(), /plain question/, "skill pin doesn't leak the later prompt");
		skillScreen.handleViewportInput("\x1b[<0;11;1M"); // left press on the bar row
		assert.equal(skillView.scrollTop, Math.max(0, startSkill - 1), "click on a pinned skill jumps back to it");

		// Above everything → nothing pinned (the skill block alone must not
		// resurrect a stale selection).
		skillScrollTo(0);
		assert.equal(skillBarText(), "", "top of transcript with only a skill block pins nothing");

		await skillHandlers["session_shutdown"]({ type: "session_shutdown", reason: "shutdown" }, {
			ui: { setWidget: () => {} },
		});
		skillTui.stop();
	}

	// ── uninstall (session_shutdown) removes instance overrides ────
	await handlers["session_shutdown"]({}, ctx);
	assert.equal(Object.hasOwn(tui, "hasOverlay"), false, "own-property hasOverlay removed");
	assert.equal(
		Object.hasOwn(tui, "handleSelectionMouseEvent"),
		false,
		"own-property click patch removed",
	);
	assert.equal(typeof TuiAltScreen.prototype.hasOverlay.call(tui), "boolean", "prototype method intact");

	console.log(
		"✓ sticky-last-prompt smoke tests passed (scroll-aware pin, tree rebuild, jump, drag, suppression, cleanup)",
	);
}
