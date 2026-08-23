/**
 * sticky-last-prompt — Pin your last user message to the top of pi's
 * fullscreen TUI; click the pinned bar to jump to that message.
 *
 * Behavior:
 *   - After you send a prompt, a one-line bar pins to the very top of the
 *     screen showing it (whitespace collapsed, ellipsized to fit).
 *   - Left-clicking the bar scrolls the transcript so that message sits
 *     right below the bar. Everything else (wheel, selection, drag, other
 *     buttons) behaves exactly as stock pi.
 *
 * Why instance patches instead of a public mouse API (pi 0.84.x):
 *   TuiAltScreen registers its input listener at construction time — before
 *   any extension can — and consumes every parsed SGR click unconditionally
 *   (scrollbar first, then text selection). Neither `tui.addInputListener`
 *   nor `ctx.ui.onTerminalInput` ever sees clicks, and overlays receive
 *   keyboard only. The seams left are two internal methods, both wrapped on
 *   the renderer instance (restored on session_shutdown):
 *     - `handleSelectionMouseEvent` receives every non-scrollbar click with
 *       parsed coordinates; we swallow exactly one gesture: a left-button
 *       press inside the bar.
 *     - `hasOverlay()` gates scrollbar dragging and selection anchoring;
 *       pi bails out of both whenever ANY overlay is visible. While our
 *       non-capturing bar is the only visible overlay we report "none", so
 *       the scrollbar stays draggable; with any other overlay on top, stock
 *       suppression applies untouched.
 *
 * Caveats:
 *   - Depends on pi internals (renderer methods, overlay stack shape).
 *     All access is defensive; if pi renames things, clicking silently
 *     stops working but nothing else breaks.
 */

import {
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";

// ═══════════════════════════════════════════════════════════════
// Structural types for pi internals (defensively accessed)
// ═══════════════════════════════════════════════════════════════

/** Parsed SGR mouse event as delivered by pi's alt-screen renderer. */
interface MouseEventLike {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface ScrollViewLike {
	scrollTop: number;
	contentHeight?: number;
	child?: unknown;
	getContentWidth?(width: number): number;
	scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void;
}

/** One entry of TUI.overlayStack (private in pi-tui; read defensively). */
interface OverlayEntryLike {
	component?: unknown;
	hidden?: boolean;
}

/**
 * The fullscreen renderer (TuiAltScreen). Members beyond TUI are internal:
 * kept optional so a pi update degrades to "clicks don't work", not crashes.
 */
type AltScreen = TUI & {
	layoutRoot?: { entries?: readonly { component?: unknown }[] | null } | null;
	getPrimaryScrollView?: () => ScrollViewLike | undefined;
	handleSelectionMouseEvent?: (event: MouseEventLike) => unknown;
	overlayStack?: readonly unknown[];
	isOverlayVisible?: (entry: unknown) => boolean;
};

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

const WIDGET_ID = "sticky-last-prompt";
const PIN_ICON = "\uf007"; // nf-fa-thumb_tack, same glyph other pi pins use

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function padToWidth(text: string, width: number): string {
	const pad = width - visibleWidth(text);
	return pad > 0 ? text + " ".repeat(pad) : text;
}

function measureLines(component: unknown, width: number): number {
	try {
		const render = (component as { render?: (w: number) => string[] }).render;
		return typeof render === "function" ? (render.call(component, width)?.length ?? 0) : 0;
	} catch {
		return 0;
	}
}

/** Plain pi-tui Container check. UserMessageComponent extends Container —
 *  always test for the message component BEFORE recursing into containers. */
function isPlainContainer(value: unknown): value is { children: readonly unknown[] } {
	const name = (value as { constructor?: { name?: string } } | undefined)?.constructor?.name;
	return name === "Container" && Array.isArray((value as { children?: unknown }).children);
}

/**
 * Accumulate document line offsets down the transcript tree, remembering the
 * start of the last (bottom-most) UserMessageComponent. Recurses only into
 * plain Containers (pure concatenation of children) so offsets match exactly
 * what the transcript ScrollView paints.
 */
function walkForLastUserMessage(
	children: readonly unknown[],
	width: number,
	offset: number,
	found: { start?: number },
): number {
	for (const child of children) {
		if (child instanceof UserMessageComponent) {
			found.start = offset;
			offset += measureLines(child, width);
		} else if (isPlainContainer(child)) {
			offset = walkForLastUserMessage(child.children, width, offset, found);
		} else {
			offset += measureLines(child, width);
		}
	}
	return offset;
}

/** Pull plain text out of a stored user message content field. */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join("\n");
}

/** Renders nothing; the widget factory returning it is the per-frame hook. */
const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

// ═══════════════════════════════════════════════════════════════
// Pin bar — one full-width line pinned to the top of the screen
// ═══════════════════════════════════════════════════════════════

class PinBar implements Component {
	/** Rows currently painted by the bar — the click hit-test height. */
	renderedRows = 0;
	private theme: Theme | undefined;

	constructor(private readonly getText: () => string) {}

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	reset(): void {
		this.theme = undefined;
		this.renderedRows = 0;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const text = this.getText();
		if (!theme || !text) {
			this.renderedRows = 0;
			return [];
		}
		const label = truncateToWidth(text, Math.max(0, width - 4), "…");
		const line = ` ${theme.fg("accent", PIN_ICON)} ${theme.fg("text", label)}`;
		this.renderedRows = 1;
		return [theme.bg("selectedBg", padToWidth(line, width))];
	}

	invalidate(): void {}
}

// ═══════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════

export default function stickyLastPrompt(pi: ExtensionAPI): void {
	/** Collapsed text of the last user prompt this session. */
	let pinnedText = "";
	let altScreen: AltScreen | undefined;
	let overlay: OverlayHandle | null = null;
	const patchedRenderers = new WeakSet<AltScreen>();
	/** Offset cache keyed by the two things that move content: width + height. */
	let offsetCache: {
		width: number;
		contentHeight: number | undefined;
		start: number | undefined;
	} | null = null;

	const bar = new PinBar(() => pinnedText);

	// ─── Transcript access ────────────────────────────────────────

	function primaryScrollView(): ScrollViewLike | undefined {
		const screen = altScreen;
		if (!screen) return undefined;
		try {
			const direct = screen.getPrimaryScrollView?.();
			if (direct) return direct;
		} catch {
			/* fall through to layout scan */
		}
		const entries = screen.layoutRoot?.entries;
		const found = entries?.find((entry) => {
			const component = entry?.component as { primary?: unknown } | undefined;
			return !!component && component.primary === true;
		});
		return found?.component as ScrollViewLike | undefined;
	}

	function terminalWidth(): number {
		return Math.max(1, altScreen?.terminal.columns ?? 80);
	}

	/** Start offset (document rows) of the last user message; cached per
	 *  width + contentHeight — those are what streaming/resize move. */
	function lastUserMessageStart(sv: ScrollViewLike, width: number): number | undefined {
		const contentHeight = sv.contentHeight;
		if (
			offsetCache &&
			offsetCache.width === width &&
			offsetCache.contentHeight === contentHeight
		) {
			return offsetCache.start;
		}
		const found: { start?: number } = {};
		const doc = sv.child as { children?: unknown[] } | undefined;
		if (doc && Array.isArray(doc.children)) {
			walkForLastUserMessage(doc.children, width, 0, found);
		}
		offsetCache = { width, contentHeight, start: found.start };
		return found.start;
	}

	// ─── Click → jump ─────────────────────────────────────────────

	/** Swallow exactly one gesture: a left-button press inside the bar.
	 *  Motion (bit 32), other buttons, and releases pass through untouched,
	 *  matching pi's own scrollbar press test. */
	function tryConsumeClick(event: MouseEventLike): boolean {
		if (!overlay || overlay.isHidden()) return false;
		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		if (event.y < 0 || event.y >= bar.renderedRows) return false;
		jumpToPinnedMessage();
		return true;
	}

	function jumpToPinnedMessage(): void {
		const sv = primaryScrollView();
		if (!sv) return;
		const width =
			typeof sv.getContentWidth === "function" ? sv.getContentWidth(terminalWidth()) : terminalWidth();
		const start = lastUserMessageStart(sv, Math.max(1, width));
		if (start === undefined) return;
		// Land the message right below the bar; disableFollow keeps the view
		// there instead of live-tail yanking it back (same as pi's search jump).
		sv.scrollTo(Math.max(0, start - bar.renderedRows), { disableFollow: true });
		altScreen?.requestRender();
	}

	// ─── Renderer patches (the only seams that see clicks) ───────

	/** While the ONLY visible overlay is our non-capturing bar, report "no
	 *  overlay" so pi's `getScrollbarTargetAt` and selection anchor stop
	 *  bailing on `hasOverlay()` — scrollbar dragging/hover and mouse text
	 *  selection work as if the bar weren't there. Any other visible overlay
	 *  (search box, dialogs, other extensions) keeps stock suppression. */
	function installHasOverlayPatch(screen: AltScreen): boolean {
		if (typeof screen.hasOverlay !== "function") return false;
		const originalHasOverlay = screen.hasOverlay.bind(screen);
		const isVisible = (entry: OverlayEntryLike): boolean => {
			try {
				return typeof screen.isOverlayVisible === "function"
					? screen.isOverlayVisible(entry)
					: !entry.hidden;
			} catch {
				return true; // assume visible → conservative (keeps suppression)
			}
		};
		screen.hasOverlay = (): boolean => {
			const stack = screen.overlayStack;
			if (!Array.isArray(stack)) return originalHasOverlay();
			for (const raw of stack) {
				const entry = raw as OverlayEntryLike;
				if (!isVisible(entry)) continue;
				if (entry.component !== bar) return originalHasOverlay();
			}
			return false; // nothing but our bar → act overlay-free
		};
		return true;
	}

	function installRendererPatches(screen: AltScreen): void {
		if (patchedRenderers.has(screen)) return;
		let installed = false;
		if (typeof screen.handleSelectionMouseEvent === "function") {
			installed = true;
			const original = screen.handleSelectionMouseEvent.bind(screen);
			screen.handleSelectionMouseEvent = (event: MouseEventLike): unknown => {
				if (tryConsumeClick(event)) return undefined;
				return original(event);
			};
		}
		installed = installHasOverlayPatch(screen) || installed;
		if (installed) patchedRenderers.add(screen);
	}

	function uninstallRendererPatches(): void {
		const screen = altScreen;
		if (!screen || !patchedRenderers.has(screen)) return;
		// Remove the own-property overrides → prototype methods shine through.
		delete screen.handleSelectionMouseEvent;
		delete (screen as { hasOverlay?: () => boolean }).hasOverlay;
		patchedRenderers.delete(screen);
	}

	// ─── Overlay lifecycle ────────────────────────────────────────

	function syncOverlay(): void {
		const screen = altScreen;
		if (!screen) return;
		const want = screen.mode === "fullscreen" && pinnedText.length > 0;
		if (want && !overlay) {
			const options: OverlayOptions = {
				anchor: "top-left",
				row: 0,
				col: 0,
				width: "100%",
				nonCapturing: true,
			};
			overlay = screen.showOverlay(bar, options);
		} else if (!want && overlay) {
			overlay.hide(); // handle is permanent; recreated on demand
			overlay = null;
		}
	}

	// ─── Session state ────────────────────────────────────────────

	/** Seed the pin from the session tail so /reload or a fresh start on an
	 *  existing session still shows something. Best effort. */
	function restoreLastUserMessage(ctx: ExtensionContext): void {
		if (pinnedText) return; // live session already captured one
		try {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as {
					type?: string;
					message?: { role?: string; content?: unknown };
				};
				if (entry.type !== "message" || entry.message?.role !== "user") continue;
				const value = collapseWhitespace(extractUserText(entry.message.content));
				if (value) {
					pinnedText = value;
					return;
				}
			}
		} catch {
			/* best effort */
		}
	}

	// ─── Events ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		restoreLastUserMessage(ctx);
		// Persistent widget whose factory runs every frame: captures the tui
		// reference, keeps the bar themed, installs the click patch once, and
		// keeps the overlay in sync with mode/text — no polling timers.
		ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
			const screen = tui as AltScreen;
			altScreen = screen;
			bar.setTheme(theme);
			installRendererPatches(screen);
			syncOverlay();
			return EMPTY_COMPONENT;
		});
	});

	pi.on("before_agent_start", (event) => {
		if (typeof event.prompt !== "string") return;
		const collapsed = collapseWhitespace(event.prompt);
		if (!collapsed || collapsed === pinnedText) return;
		pinnedText = collapsed;
		altScreen?.requestRender(); // next frame's widget hook shows the bar
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		uninstallRendererPatches();
		overlay?.hide();
		overlay = null;
		altScreen = undefined;
		bar.reset();
		pinnedText = "";
		offsetCache = null;
	});
}
