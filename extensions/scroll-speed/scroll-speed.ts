import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Default lines scrolled per mouse-wheel notch in fullscreen mode (pi's built-in default is 1). */
const DEFAULT_WHEEL_LINES = 5;

/** The `scrollSpeed` key read from settings.json. */
interface ScrollSpeedSettings {
	wheelLines?: unknown;
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

/** Precedence: CLI flag > trusted project settings > global settings > default. */
function resolveWheelLines(pi: ExtensionAPI, ctx: ExtensionContext): number {
	const flag = pi.getFlag("wheel-lines");
	if (typeof flag === "string") {
		const fromFlag = parseWheelLines(Number(flag));
		if (fromFlag !== undefined) return fromFlag;
	}
	if (ctx.isProjectTrusted()) {
		const project = readScrollSpeedSettings(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
		const fromProject = project ? parseWheelLines(project.wheelLines) : undefined;
		if (fromProject !== undefined) return fromProject;
	}
	const global = readScrollSpeedSettings(join(getAgentDir(), "settings.json"));
	const fromGlobal = global ? parseWheelLines(global.wheelLines) : undefined;
	if (fromGlobal !== undefined) return fromGlobal;
	return DEFAULT_WHEEL_LINES;
}

/**
 * The alt-screen renderer (fullscreen mode) owns wheel input and exposes a
 * mutable `wheelScrollLines` field. This is an internal pi-tui field, not a
 * documented setting — it may change in future versions.
 */
interface AltScreenLike {
	wheelScrollLines?: number;
}

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("wheel-lines", {
		description: "Lines scrolled per mouse-wheel notch in pi fullscreen mode",
		type: "string",
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const wheelLines = resolveWheelLines(pi, ctx);

		// Other extensions (e.g. focus-aware-blinking-cursor-and-border) may
		// have registered their own editor factory; capture and delegate to
		// it instead of replacing it.
		const previousFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// Only the fullscreen alt-screen has this field; regular mode scrolls
			// via the terminal's own scrollback and is intentionally untouched.
			const altScreen = tui as AltScreenLike;
			if (typeof altScreen.wheelScrollLines === "number") {
				altScreen.wheelScrollLines = wheelLines;
			}
			if (previousFactory) {
				return previousFactory(tui, theme, keybindings);
			}
			return new CustomEditor(tui, theme, keybindings);
		});
	});
}
