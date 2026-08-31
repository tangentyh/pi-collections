import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Default lines scrolled per mouse-wheel notch in fullscreen mode (pi's built-in default is 1). */
const DEFAULT_WHEEL_LINES = 5;

/** The `scrollSpeed` key read from settings.json. */
interface ScrollSpeedSettings {
	wheelLines?: unknown;
	enabled?: unknown;
}

/** Accepts positive integers only; anything else is treated as unset. */
function parseWheelLines(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		return undefined;
	}
	return value;
}

/** Read the `scrollSpeed` block from a settings.json file; unset on any error. */
function readScrollSpeedSettings(file: string): ScrollSpeedSettings | undefined {
	try {
		const settings = JSON.parse(readFileSync(file, "utf8")) as { scrollSpeed?: unknown };
		if (
			settings &&
			typeof settings === "object" &&
			settings.scrollSpeed &&
			typeof settings.scrollSpeed === "object"
		) {
			return settings.scrollSpeed as ScrollSpeedSettings;
		}
	} catch {
		// Missing file or invalid JSON: treat as unset.
	}
	return undefined;
}

/**
 * The value resolved from flag/settings/default: either a wheel-lines number
 * or the extension disabled (pi's built-in wheel behavior is left untouched).
 */
type ConfiguredWheelLines =
	| { state: "value"; value: number; source: string }
	| { state: "off"; source: string };

/** Runtime override from `/scroll-speed`: a number, "off" (disabled), or unset. */
type WheelLinesOverride = number | "off" | undefined;

/** Precedence: CLI flag > trusted project settings > global settings > default. */
function resolveWheelLines(pi: ExtensionAPI, ctx: ExtensionContext): ConfiguredWheelLines {
	const flag = pi.getFlag("wheel-lines");
	if (typeof flag === "string") {
		if (flag.trim().toLowerCase() === "off") {
			return { state: "off", source: "--wheel-lines flag" };
		}
		const fromFlag = parseWheelLines(Number(flag));
		if (fromFlag !== undefined) return { state: "value", value: fromFlag, source: "--wheel-lines flag" };
	}
	if (ctx.isProjectTrusted()) {
		const project = readScrollSpeedSettings(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
		if (project?.enabled === false) return { state: "off", source: "project settings" };
		const fromProject = parseWheelLines(project?.wheelLines);
		if (fromProject !== undefined) {
			return { state: "value", value: fromProject, source: "project settings" };
		}
	}
	const global = readScrollSpeedSettings(join(getAgentDir(), "settings.json"));
	if (global?.enabled === false) return { state: "off", source: "global settings" };
	const fromGlobal = parseWheelLines(global?.wheelLines);
	if (fromGlobal !== undefined) return { state: "value", value: fromGlobal, source: "global settings" };
	return { state: "value", value: DEFAULT_WHEEL_LINES, source: "default" };
}

/**
 * The alt-screen renderer (fullscreen mode) owns wheel input. Its
 * `wheelScrollLines` field is an internal pi-tui field, not a documented
 * setting — it may change in future versions.
 */
interface AltScreenLike {
	wheelScrollLines?: number;
}

/** Values offered for `/scroll-speed <TAB>`; `reset` reverts to the configured value. */
const SUGGESTED_WHEEL_LINES = [1, 2, 3, 5, 10];

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("wheel-lines", {
		description: "Lines scrolled per mouse-wheel notch in pi fullscreen mode (number, or \"off\" to disable)",
		type: "string",
	});

	// Value resolved from flag/settings/default on session start, plus an
	// optional runtime override set via /scroll-speed (session-only, wins
	// until /scroll-speed reset or an extension reload).
	let configured: ConfiguredWheelLines = { state: "value", value: DEFAULT_WHEEL_LINES, source: "default" };
	let override: WheelLinesOverride;
	let activeTui: AltScreenLike | undefined;
	// pi's own value before we first touched the current TUI, so that
	// disabling can restore the built-in behavior exactly.
	let originalWheelLines: number | undefined;

	const currentIsOff = () => override === "off" || (override === undefined && configured.state === "off");
	const currentWheelLines = () =>
		override !== undefined && override !== "off" ? override : configured.state === "value" ? configured.value : DEFAULT_WHEEL_LINES;
	const currentSource = () => (override !== undefined ? "runtime override (/scroll-speed)" : configured.source);
	const describeCurrent = () =>
		currentIsOff()
			? `disabled (pi built-in: ${originalWheelLines ?? 1} line(s) per notch; ${currentSource()})`
			: `${currentWheelLines()} line(s) per wheel notch (${currentSource()})`;

	/** Push the current value onto the live alt-screen TUI, if there is one. */
	const applyWheelLines = (): void => {
		const tui = activeTui;
		// Only the fullscreen alt-screen has this field; regular mode scrolls
		// via the terminal's own scrollback and is intentionally untouched.
		if (!tui || typeof tui.wheelScrollLines !== "number") return;
		tui.wheelScrollLines = currentIsOff() ? (originalWheelLines ?? 1) : currentWheelLines();
	};

	pi.registerCommand("scroll-speed", {
		description:
			"Lines scrolled per mouse-wheel notch (fullscreen): /scroll-speed <N> = set, off = disable, reset = revert, no args = show",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim();
			const items: AutocompleteItem[] = [
				...SUGGESTED_WHEEL_LINES.map((n) => ({
					value: String(n),
					label: String(n),
					description: `${n} line${n === 1 ? "" : "s"} per wheel notch`,
				})),
				{
					value: "off",
					label: "off",
					description: "disable: restore pi's built-in wheel scrolling",
				},
				{
					value: "reset",
					label: "reset",
					description: "revert to the value from flag/settings/default",
				},
			];
			const filtered = items.filter((item) => item.value.startsWith(needle));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg) {
				ctx.ui.notify(
					`Scroll speed: ${describeCurrent()}. ` +
						"Use /scroll-speed <N> to change it, /scroll-speed off to disable, /scroll-speed reset to revert.",
					"info",
				);
				return;
			}
			if (arg === "off") {
				override = "off";
				applyWheelLines();
				ctx.ui.notify(
					`Scroll speed disabled for this session — pi's built-in ${originalWheelLines ?? 1} ` +
						"line(s) per notch restored. Re-enable with /scroll-speed <N>.",
					"info",
				);
				return;
			}
			if (arg === "reset") {
				override = undefined;
				applyWheelLines();
				ctx.ui.notify(
					configured.state === "off"
						? `Scroll speed restored to disabled (${configured.source}).`
						: `Scroll speed restored to ${configured.value} (${configured.source}).`,
					"info",
				);
				return;
			}
			const value = parseWheelLines(Number(arg));
			if (value === undefined) {
				ctx.ui.notify(
					`Invalid scroll speed: "${arg}". Use a positive integer, "off", or "reset".`,
					"error",
				);
				return;
			}
			override = value;
			applyWheelLines();
			ctx.ui.notify(
				`Scroll speed set to ${value} line(s) per wheel notch (this session; ` +
					"persist with scrollSpeed.wheelLines in settings.json).",
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Re-resolve the configured value on every session start; a runtime
		// override set via /scroll-speed survives session switches until reset.
		configured = resolveWheelLines(pi, ctx);
		applyWheelLines();

		// Other extensions (e.g. focus-aware-blinking-cursor-and-border) may
		// have registered their own editor factory; capture and delegate to
		// it instead of replacing it.
		const previousFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const altScreen = tui as AltScreenLike;
			// Remember pi's own value per TUI instance so "off" can restore it.
			if (activeTui !== altScreen) {
				originalWheelLines =
					typeof altScreen.wheelScrollLines === "number" ? altScreen.wheelScrollLines : undefined;
			}
			activeTui = altScreen;
			applyWheelLines();
			if (previousFactory) {
				return previousFactory(tui, theme, keybindings);
			}
			return new CustomEditor(tui, theme, keybindings);
		});
	});
}
