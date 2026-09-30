// io.ts — resolve the extension's configuration from pi's own settings files.
//
// The `autoRename` key of pi's global (`<agent dir>/settings.json`) and project
// (`<cwd>/.pi/settings.json`, trusted projects only) settings is the only
// location read; the pre-fork `pi-auto-name` files are no longer consulted.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

export interface SettingsObject {
	[key: string]: unknown;
}

export interface AutoRenamePaths {
	globalSettingsPath?: string;
	projectSettingsPath?: string;
}

export interface ResolvedAutoRenameConfiguration {
	/** The effective `autoRename` object, or undefined when nothing is set. */
	raw: SettingsObject | undefined;
	globalSettingsPath: string;
	projectSettingsPath: string;
}

function isRecord(value: unknown): value is SettingsObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a settings file. Invalid or missing files are treated as unset. */
export function readSettingsFile(file: string): SettingsObject | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Merge settings the way pi does: project values override global values,
 * nested objects merge recursively, and any other value (including an empty
 * string) replaces the global value wholesale.
 */
export function mergeSettings(
	globalSettings: SettingsObject | undefined,
	projectSettings: SettingsObject | undefined,
): SettingsObject {
	const base = globalSettings ?? {};
	const overrides = projectSettings ?? {};
	const result: SettingsObject = { ...base };
	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) continue;
		const baseValue = base[key];
		result[key] =
			isRecord(baseValue) && isRecord(overrideValue)
				? mergeSettings(baseValue, overrideValue)
				: overrideValue;
	}
	return result;
}

/**
 * Resolve the effective config: the merged `autoRename` namespace when present,
 * else nothing. Always reports the two resolved settings paths, so callers can
 * name them in diagnostics.
 */
export function resolveAutoRenameConfiguration(
	ctx: ExtensionContext,
	paths?: AutoRenamePaths,
): ResolvedAutoRenameConfiguration {
	const globalSettingsPath =
		paths?.globalSettingsPath ?? join(getAgentDir(), "settings.json");
	const projectSettingsPath =
		paths?.projectSettingsPath ??
		join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
	const result = { globalSettingsPath, projectSettingsPath };

	const global = readSettingsFile(globalSettingsPath);
	const project = ctx.isProjectTrusted()
		? readSettingsFile(projectSettingsPath)
		: undefined;
	const namespaced = mergeSettings(global, project).autoRename;
	if (isRecord(namespaced)) {
		return { ...result, raw: namespaced };
	}

	return { ...result, raw: undefined };
}

/**
 * Persist the naming-model override in global settings as
 * `autoRename.namingModel`, preserving every other setting. The project
 * settings file is untouched; a project-level `namingModel` still shadows the
 * global value through the normal merge. `model` is a `provider/modelId`
 * string, or `""` to fall back to the session's current model.
 *
 * Writes atomically (temp file + rename) and returns whether it succeeded, so
 * the command can report a failure instead of claiming success.
 */
export function writeGlobalNamingModel(
	model: string,
	globalSettingsPath?: string,
): boolean {
	const settingsPath =
		globalSettingsPath ?? join(getAgentDir(), "settings.json");
	try {
		const settings = readSettingsFile(settingsPath) ?? {};
		const autoRename = settings.autoRename;
		settings.autoRename = isRecord(autoRename)
			? { ...autoRename, namingModel: model }
			: { namingModel: model };
		mkdirSync(dirname(settingsPath), { recursive: true });
		const tmp = `${settingsPath}.tmp`;
		writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
		renameSync(tmp, settingsPath);
		return true;
	} catch (error) {
		console.error("pi-auto-rename: writeGlobalNamingModel failed", error);
		return false;
	}
}
