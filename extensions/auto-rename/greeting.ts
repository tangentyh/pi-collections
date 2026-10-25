// greeting.ts — the startup line naming the effective naming model.
//
// Why a custom transcript entry and not the greeting header: `ctx.ui.setHeader`
// replaces the single header child in place (no append API), so appending one
// line would mean reproducing pi's whole greeting — version-dependent and
// silently dropping pi's branding, the startup-help toggle and, in some
// versions, the logo animation. A custom entry instead lands directly below
// pi's greeting block at startup, is replayed on resume, never reaches the
// LLM, and stays additive. Same mechanism as the debug trail.

import type {
	EntryRenderer,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { Config } from "./config.js";
import { effectiveNamingModel, type NamingSession } from "./naming.js";

/** Custom entry type for the startup greeting line. */
export const GREETING_ENTRY_TYPE = "pi-auto-name:greeting";

/** The effective naming target, as the startup line renders it. */
export interface GreetingData {
	at: string;
	/** Effective model the next naming call will use. */
	model: string;
	/**
	 * The configured `namingThinking`, verbatim. `off` is rendered as "off", not
	 * as "no effort": `off` sends no explicit level and leaves effort at the
	 * provider/model default, which for some OpenAI reasoning models is not zero.
	 */
	effort: Config["namingThinking"];
	/** True when the model comes from `namingModel`, not the session model. */
	override: boolean;
}

/**
 * The api instance the renderer was registered on. Reload and session
 * replacement create a fresh Extension with an empty renderer map while this
 * module may stay cached (jiti), so registration is keyed by object identity —
 * never by a module-level boolean alone. Same pattern as debug.ts.
 */
let registeredPi: ExtensionAPI | undefined;

/**
 * Append the one-line startup greeting. Idempotent across resume: the caller
 * passes what `restoreTranscriptState` found, so a session that already has a
 * greeting entry writes nothing and a new session appends exactly one.
 *
 * Registration is lazy and happens here rather than at load time: during
 * extension loading pi's runtime actions are throwing stubs. Like the debug
 * trail, the renderer is registered on the api instance that is about to
 * append.
 *
 * The renderer is registered even when the append is skipped because the
 * session already carries a greeting: a resumed session replays that entry, and
 * it needs its renderer to draw at all.
 */
export function appendNamingGreeting(
	pi: ExtensionAPI,
	session: NamingSession,
	cfg: Config,
	hasGreeting: boolean,
): void {
	if (registeredPi !== pi) {
		pi.registerEntryRenderer<GreetingData>(
			GREETING_ENTRY_TYPE,
			renderGreetingEntry,
		);
		registeredPi = pi;
	}
	if (hasGreeting) return;
	const { label, override } = effectiveNamingModel(
		session.modelRegistry,
		session.model,
		cfg,
	);
	pi.appendEntry<GreetingData>(GREETING_ENTRY_TYPE, {
		at: new Date().toISOString(),
		model: label,
		effort: cfg.namingThinking,
		override,
	});
}

/**
 * One dim line, no message-box background — a greeting is not a message. It is
 * intentionally allowed to go stale after `/auto-rename model …`: this is a
 * startup line, and that command stays authoritative.
 */
export const renderGreetingEntry: EntryRenderer<GreetingData> = (
	entry,
	_options,
	theme,
): Component => {
	const data = entry.data;
	const model = data?.model ?? "unknown";
	const effort = data?.effort ?? "off";
	const override = data?.override ?? false;
	const label = theme.fg("accent", "[pi-auto-rename]");
	const detail = `naming: ${model} • effort: ${effort}${override ? " (override)" : ""}`;
	return new Text(`${label} ${theme.fg("dim", detail)}`, 0, 0);
};
