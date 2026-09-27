// config.ts — schema, defaults, and load/merge of the `autoRename` settings key.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, type TObject, Type } from "typebox";
import { Value } from "typebox/value";
import { debug } from "./debug.js";
import { type AutoRenamePaths, resolveAutoRenameConfiguration } from "./io.js";

export const ConfigSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	surfaces: Type.Object({
		renamePiSession: Type.Boolean({ default: true }),
		renameHerdrPane: Type.Boolean({ default: true }),
		renameHerdrTab: Type.Boolean({ default: true }),
		renameTmuxWindow: Type.Boolean({ default: true }),
		renameZellijPane: Type.Boolean({ default: true }),
		renameZellijTab: Type.Boolean({ default: true }),
		// Two independent mode gates for non-TUI sessions (subagent children run in
		// "print"): the per-session pi name is safe to grant, the process-global
		// terminal surfaces are not — a child writing those relabels the parent's
		// tmux/herdr/zellij pane. Both default off.
		renamePiSessionInNonTuiModes: Type.Boolean({ default: false }),
		renameMultiplexersInNonTuiModes: Type.Boolean({ default: false }),
	}),
	initialRenameTrigger: Type.Union(
		[Type.Literal("first-input"), Type.Literal("first-agent-settled")],
		{
			default: "first-input",
		},
	),
	reRenameEveryNTurns: Type.Integer({ minimum: 0, default: 0 }),
	replaceExistingName: Type.Union(
		[Type.Literal("always"), Type.Literal("never")],
		{
			default: "always",
		},
	),
	respectExternalRenames: Type.Boolean({ default: true }),
	namingStyle: Type.Union(
		[
			Type.Literal("natural"),
			Type.Literal("slug"),
			Type.Literal("topic-project"),
		],
		{ default: "natural" },
	),
	namingContextDepth: Type.Union(
		[
			Type.Literal("first-user-message"),
			Type.Literal("recent-user-messages"),
			Type.Literal("full-conversation"),
		],
		{ default: "recent-user-messages" },
	),
	skipSessionNameDedup: Type.Boolean({ default: false }),
	namingModel: Type.String({ default: "" }),
	// Thinking/reasoning effort for the naming call. "off" sends no explicit
	// level, leaving effort at the provider/model default (usually off; some
	// OpenAI reasoning models still reason at their own default). Any other
	// value is forwarded as pi-ai's provider-neutral `reasoning` on the
	// `*Simple` stream path.
	namingThinking: Type.Union(
		[
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		],
		{ default: "off" },
	),
	// BCP-47 language tag only ("en", "zh-CN", "pt-BR")
	language: Type.String({ default: "en" }),
	// Per-name limits, override semantics: when set, windowNameMaxLength applies
	// to every window surface (herdr pane/tab, tmux window, zellij pane/tab) and
	// sessionNameMaxLength to the Pi session name and session list. Each replaces
	// a single fixed default (DEFAULT_MAX_WINDOW_NAME_CHARS / DEFAULT_MAX_SESSION_NAME_CHARS
	// in naming.ts) — tightening OR relaxing it, identically for every style.
	// These are the only two length knobs.
	windowNameMaxLength: Type.Optional(Type.Integer({ minimum: 1 })),
	sessionNameMaxLength: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type Config = Static<typeof ConfigSchema>;

/**
 * Schema validation with rpiv-config's `validateConfig` semantics, inlined
 * after dropping the dependency: non-object input yields `{}`; Value.Clean
 * strips unknown keys; Value.Create applies defaults, which are then merged
 * under (and so overridden by) the cleaned value. Any failure yields `{}`.
 */
export function validateConfig<T extends TObject>(
	schema: T,
	value: unknown,
): Static<T> {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value))
			return {} as Static<T>;
		const cleaned = Value.Clean(schema, Value.Clone(value));
		const defaults = Value.Create(schema);
		return {
			...(defaults as Record<string, unknown>),
			...(cleaned as Record<string, unknown>),
		} as Static<T>;
	} catch {
		return {} as Static<T>;
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge; `over` wins per field. Arrays and scalars are replaced, not merged. */
function deepMerge(
	base: Record<string, unknown>,
	over: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(over)) {
		if (isPlainObject(value) && isPlainObject(out[key])) {
			out[key] = deepMerge(out[key] as Record<string, unknown>, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Load: global settings base ← project override (per-field, project wins).
 * Configuration comes ONLY from the `autoRename` key of pi's own settings
 * files; there are no env-var overrides or legacy-file fallbacks.
 */
export function loadConfig(
	ctx: ExtensionContext,
	paths?: AutoRenamePaths,
): Config {
	const resolved = resolveAutoRenameConfiguration(ctx, paths);
	const validated = validateConfig(ConfigSchema, resolved.raw ?? {});
	// validateConfig's merge is shallow (`{...defaults, ...cleaned}`) and TypeBox
	// Value.Create honors an object's own default over nested property defaults.
	// Deep-merge the full schema defaults so a partial `surfaces`
	// override keeps every untouched field.
	const fullDefaults = validateConfig(ConfigSchema, {});
	const cfg = deepMerge(fullDefaults, validated) as Config;
	debug("loadConfig", {
		globalSettingsPath: resolved.globalSettingsPath,
		projectSettingsPath: resolved.projectSettingsPath,
		enabled: cfg.enabled,
		namingStyle: cfg.namingStyle,
		namingThinking: cfg.namingThinking,
		initialRenameTrigger: cfg.initialRenameTrigger,
		reRenameEveryNTurns: cfg.reRenameEveryNTurns,
		replaceExistingName: cfg.replaceExistingName,
		respectExternalRenames: cfg.respectExternalRenames,
		language: cfg.language,
		surfaces: cfg.surfaces,
	});
	return cfg;
}
