import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const BLINK_MS = 530; // classic ~2 Hz terminal cursor blink

// Terminal focus reporting (CSI ?1004h, enabled by pi's fullscreen TUI):
// the terminal emits `CSI I` on focus gain and `CSI O` on focus loss.
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/**
 * Blinking cursor + focused/unfocused distinction for the pi TUI.
 *
 * - Focused: fake cursor cell blinks on/off at ~2 Hz; border keeps pi's
 *   dynamic color (thinking level / bash mode).
 * - Unfocused: cursor hidden entirely; border dimmed.
 *
 * The blink phase is computed from elapsed time at render time, and resets
 * on cursor movement (typing, arrows, word jumps like option+f, scrolling)
 * or refocus, so the cursor reappears immediately instead of waiting out
 * the current "off" half of the cycle.
 *
 * "Focused" is two independent signals, both required for the blink:
 * - TUI focus (`Editor.focused`): the input editor is the active component
 *   (loses focus while selectors/overlays are open).
 * - Terminal focus: the terminal window itself. pi's TUI consumes the
 *   terminal's focus-in/focus-out sequences internally before extension
 *   input listeners run, so this extension watches raw stdin for them.
 *   In regular (non-fullscreen) mode focus reporting is off and the cursor
 *   blinks regardless of window focus.
 *
 * Install: this directory is a pi package (see package.json) — install it
 * with `pi install ./extensions/focus-aware-blinking-cursor-and-border`,
 * via `pi install git:...`/npm, or by adding it to the "packages" array in
 * settings.json. For development, the repo root's `pi` manifest declares
 * this package's `focus-aware-blinking-cursor-and-border.ts` entry file
 * directly.
 *
 * Note: this extension delegates to a previously registered editor factory
 * (e.g. from scroll-speed.ts), so the two coexist in any load order.
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
			// Terminal window regained focus: show the cursor immediately
			// instead of waiting out the current blink phase.
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
				const first = inIdx === -1 ? outIdx : outIdx === -1 ? inIdx : Math.min(inIdx, outIdx);
				if (first === -1) break;
				setTerminalFocused(pendingFocus.startsWith(FOCUS_IN, first));
				processed = first + FOCUS_IN.length;
			}
			// Keep a trailing partial sequence (`ESC` or `ESC [`) for the
			// next chunk; the rest of the buffer is irrelevant to us.
			const tail = pendingFocus.slice(processed);
			pendingFocus = tail.endsWith("\x1b") || tail.endsWith("\x1b[") ? tail : "";
		};
		process.stdin.on("data", stdinHandler);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		terminalFocused = true;
		attachFocusMonitor();

		// Capture the previously registered editor factory BEFORE replacing
		// it. Other extensions (e.g. scroll-speed.ts) install their own
		// editor component; replacing it here would silently undo their
		// behavior, so delegate to it instead of creating a plain editor.
		const previousFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// Keep the side effects of previously registered factories alive.
			previousFactory?.(tui, theme, keybindings);
			activeTui = tui;
			currentEditor = new BlinkingCursorEditor(tui, theme, keybindings, ctx, () => terminalFocused);

			// Single interval for the process lifetime; unref so it never
			// keeps the process alive on its own. Ticks only while the
			// editor has TUI focus and the terminal window is focused.
			if (!blinkTimer) {
				blinkTimer = setInterval(() => {
					if (!currentEditor?.focused || !terminalFocused) return;
					// The blink phase is derived from elapsed time inside render;
					// this tick only drives the re-render.
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

class BlinkingCursorEditor extends CustomEditor {
	private dimBorder: (s: string) => string;
	private getTerminalFocused: () => boolean;
	// Blink phase: visible for BLINK_MS after phaseStart, hidden for
	// BLINK_MS, repeating. phaseStart is reset to "now" on cursor movement
	// or refocus so the cursor reappears immediately.
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
		this.phaseStart = performance.now();
	}

	/** Reset the blink phase so the cursor is visible immediately. */
	poke() {
		this.phaseStart = performance.now();
	}

	private cursorVisibleAt(now: number): boolean {
		return Math.floor((now - this.phaseStart) / BLINK_MS) % 2 === 0;
	}

	override render(width: number): string[] {
		const focused = this.focused && this.getTerminalFocused();

		// Cursor moved (typing, arrows, word jumps like option+f, scrolling)
		// or the text changed (backspace at line start, undo, paste): show
		// the cursor right away with a fresh blink phase, even mid-cycle.
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

		// Hide the fake cursor when unfocused, or on the "off" half of the
		// blink. The fake cursor is the only reverse-video segment the editor
		// emits (`\x1b[7m<grapheme>\x1b[0m`); replace it with the plain
		// character so the layout (width/padding) stays identical.
		if (!focused || !this.cursorVisibleAt(performance.now())) {
			for (let i = 0; i < lines.length; i++) {
				lines[i] = lines[i]!.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, (_m, ch) => ch);
			}
		}
		return lines;
	}
}
