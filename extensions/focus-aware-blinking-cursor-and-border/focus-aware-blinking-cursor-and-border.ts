import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import {
	CURSOR_MARKER,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const BLINK_MS = 530; // classic ~2 Hz terminal cursor blink

// Terminal focus reporting (CSI ?1004h, enabled by pi's fullscreen TUI):
// the terminal emits `CSI I` on focus gain and `CSI O` on focus loss.
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

// The cursor cell pi-tui's editor draws. pi-tui >= 1.2.0 wraps it in zero-width
// APC markers (also not re-exported from the package index) and converts them
// to reverse video *after* extension render hooks run (`resolveFakeCursors`);
// earlier releases emitted the reverse-video SGR directly. Handle both.
const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
const SGR_REVERSE_VIDEO =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b is the ANSI ESC byte; this matches SGR reverse-video, which pi-tui used for the cursor cell before 1.2.0
	/\x1b\[7m([\s\S]*?)\x1b\[(?:0|27)m/g;

/**
 * Whether pi-tui resolves the fake cursor cell itself (>= 1.2.0, which exports
 * `renderFakeCursor`). Those releases drop their cell whenever the hardware
 * cursor is shown and park the terminal's cursor on the caret, so the terminal
 * blinks natively; older releases paint a static reverse-video cell no matter
 * what, and the blink stays ours.
 */
const NATIVE_HARDWARE_CURSOR = "renderFakeCursor" in piTui;

/**
 * Hide the editor's cursor cell while keeping the rendered layout identical:
 * drop the hardware-cursor marker and the fake-cursor markers (or, on pi-tui
 * releases before 1.2.0, the reverse-video SGR they used instead), leaving the
 * bare grapheme in place. Without the hardware-cursor marker the TUI finds no
 * cursor position and hides the terminal's own cursor for the rest of the
 * frame.
 */
export function hideCursorCells(lines: string[]): string[] {
	for (let i = 0; i < lines.length; i++) {
		lines[i] = (lines[i] ?? "")
			.replaceAll(CURSOR_MARKER, "")
			.replaceAll(FAKE_CURSOR_START, "")
			.replaceAll(FAKE_CURSOR_END, "")
			.replace(SGR_REVERSE_VIDEO, "$1");
	}
	return lines;
}

/**
 * When the cursor cell has to be hidden. Both focus signals are required to
 * show a cursor, and the blink only applies while this extension owns the
 * cursor — when pi-tui shows the terminal's own cursor it blinks by itself and
 * touching the frame would break it: stripping the marker there keeps
 * `resolveFakeCursors` from dropping its cell, painting a static reverse-video
 * block instead.
 */
export function shouldHideCursor({
	focused,
	terminalFocused,
	hardwareCursor,
	cursorVisible,
}: {
	/** TUI focus: the editor is the active component (no selector/overlay). */
	focused: boolean;
	/** Terminal-window focus. */
	terminalFocused: boolean;
	/** pi's `showHardwareCursor` setting: the terminal draws the cursor. */
	hardwareCursor: boolean;
	/** Blink phase, only meaningful while this extension owns the cursor. */
	cursorVisible: boolean;
}): boolean {
	if (!focused || !terminalFocused) return true;
	return !hardwareCursor && !cursorVisible;
}

/**
 * Blinking cursor + focused/unfocused distinction for the pi TUI.
 *
 * "Focused" is two independent signals, both required for the blink: TUI
 * focus (`Editor.focused`) and terminal-window focus. The blink phase is
 * derived from elapsed time at render time and resets on cursor movement
 * or refocus, so the cursor reappears immediately instead of waiting out
 * the current "off" half of the cycle.
 *
 * The blinking itself is only supplied when pi draws the cursor: with the
 * `showHardwareCursor` setting on (and a pi-tui that resolves its own fake
 * cursor cell), pi shows the terminal's own cursor at the caret, which blinks
 * natively — there the extension adds just the focused/unfocused distinction
 * (hidden cursor while unfocused, dimmed border).
 */
export default function (pi: ExtensionAPI) {
	let blinkTimer: ReturnType<typeof setInterval> | undefined;
	let currentEditor: BlinkingCursorEditor | undefined;
	let activeTui: TUI | undefined;
	// Terminal window focus, assumed true until the terminal reports
	// otherwise (focus events are only sent on transitions, not at startup).
	let terminalFocused = true;
	let stdinHandler: ((data: string) => void) | undefined;
	let pendingFocus = "";

	const setTerminalFocused = (focused: boolean) => {
		if (terminalFocused === focused) return;
		terminalFocused = focused;
		if (focused) {
			currentEditor?.poke();
		}
		activeTui?.requestRender();
	};

	// The TUI's viewport handler consumes focus sequences before extension
	// input listeners run, so raw stdin is the only way to observe them.
	const attachFocusMonitor = () => {
		if (stdinHandler || !process.stdin.isTTY) return;
		stdinHandler = (chunk: string) => {
			pendingFocus += chunk;
			let processed = 0;
			while (true) {
				const inIdx = pendingFocus.indexOf(FOCUS_IN, processed);
				const outIdx = pendingFocus.indexOf(FOCUS_OUT, processed);
				const first =
					inIdx === -1
						? outIdx
						: outIdx === -1
							? inIdx
							: Math.min(inIdx, outIdx);
				if (first === -1) break;
				setTerminalFocused(pendingFocus.startsWith(FOCUS_IN, first));
				processed = first + FOCUS_IN.length;
			}
			// Keep a trailing partial sequence (`ESC` or `ESC [`) for the
			// next chunk; the rest of the buffer is irrelevant to us.
			const tail = pendingFocus.slice(processed);
			pendingFocus =
				tail.endsWith("\x1b") || tail.endsWith("\x1b[") ? tail : "";
		};
		process.stdin.on("data", stdinHandler);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		terminalFocused = true;
		attachFocusMonitor();

		// Other extensions (e.g. scroll-speed) may have registered their own
		// editor factory; capture and delegate to it instead of replacing it.
		const previousFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// Keep the side effects of previously registered factories alive.
			previousFactory?.(tui, theme, keybindings);
			activeTui = tui;
			currentEditor = new BlinkingCursorEditor(
				tui,
				theme,
				keybindings,
				ctx,
				() => terminalFocused,
			);

			// Single interval for the process lifetime; unref so it never
			// keeps the process alive on its own. It stays installed so a
			// `showHardwareCursor` change takes effect on the next tick, but
			// only re-renders while this extension owns the cursor.
			if (!blinkTimer) {
				blinkTimer = setInterval(() => {
					if (!currentEditor?.wantsBlinkTicks()) return;
					activeTui?.requestRender();
				}, BLINK_MS);
				blinkTimer.unref?.();
			}

			return currentEditor;
		});
	});

	pi.on("session_shutdown", () => {
		if (blinkTimer) {
			clearInterval(blinkTimer);
			blinkTimer = undefined;
		}
		if (stdinHandler && process.stdin.isTTY) {
			process.stdin.removeListener("data", stdinHandler);
			stdinHandler = undefined;
		}
		pendingFocus = "";
		terminalFocused = true;
		currentEditor = undefined;
		activeTui = undefined;
	});
}

export class BlinkingCursorEditor extends CustomEditor {
	private dimBorder: (s: string) => string;
	private getTerminalFocused: () => boolean;
	private tuiRef: TUI;
	// Blink phase, reset to "now" by render() and poke() so the cursor
	// reappears immediately (see cursorVisibleAt for the half-cycle split).
	private phaseStart: number;
	private lastCursor = { line: -1, col: -1 };
	private lastTextLength = -1;
	private lastFocused = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ctx: ExtensionContext,
		getTerminalFocused: () => boolean,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.dimBorder = (s: string) => ctx.ui.theme.fg("dim", s);
		this.getTerminalFocused = getTerminalFocused;
		this.tuiRef = tui;
		this.phaseStart = performance.now();
	}

	/** Reset the blink phase so the cursor is visible immediately. */
	poke() {
		this.phaseStart = performance.now();
	}

	/** True while the periodic re-render is worth running (see shouldHideCursor). */
	wantsBlinkTicks(): boolean {
		return (
			this.focused && this.getTerminalFocused() && !this.nativeHardwareCursor()
		);
	}

	/**
	 * Is the terminal drawing (and natively blinking) the cursor? Only when pi
	 * asks for it *and* pi-tui drops its own cell — see NATIVE_HARDWARE_CURSOR.
	 */
	private nativeHardwareCursor(): boolean {
		return NATIVE_HARDWARE_CURSOR && this.tuiRef.getShowHardwareCursor();
	}

	private cursorVisibleAt(now: number): boolean {
		return Math.floor((now - this.phaseStart) / BLINK_MS) % 2 === 0;
	}

	override render(width: number): string[] {
		const terminalFocused = this.getTerminalFocused();
		const focused = this.focused && terminalFocused;
		const hardwareCursor = this.nativeHardwareCursor();

		const cursor = this.getCursor();
		const textLength = this.getText().length;
		if (
			cursor.line !== this.lastCursor.line ||
			cursor.col !== this.lastCursor.col ||
			textLength !== this.lastTextLength
		) {
			this.lastCursor = cursor;
			this.lastTextLength = textLength;
			this.phaseStart = performance.now();
		}
		// TUI focus returned (e.g. a selector/overlay closed): same reset.
		if (this.focused && !this.lastFocused) {
			this.phaseStart = performance.now();
		}
		this.lastFocused = this.focused;

		// pi sets borderColor dynamically (thinking level, bash mode) via
		// updateEditorBorderColor(); overriding it here would flatten every
		// mode to the same color. Only swap in the dim border while
		// unfocused, then restore so the mode/thinking color returns.
		const savedBorder = this.borderColor;
		if (!focused) {
			this.borderColor = this.dimBorder;
		}
		const lines = super.render(width);
		this.borderColor = savedBorder;

		// Hide the cursor cell when unfocused, or on the "off" half of the
		// blink — but never while pi-tui is showing the terminal's own
		// (natively blinking) cursor, see shouldHideCursor.
		if (
			shouldHideCursor({
				focused: this.focused,
				terminalFocused,
				hardwareCursor,
				cursorVisible: this.cursorVisibleAt(performance.now()),
			})
		) {
			hideCursorCells(lines);
		}
		return lines;
	}
}
