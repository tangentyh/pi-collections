import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface SettingsObject {
	[key: string]: unknown;
}

export interface FooterConfiguration {
	/**
	 * Footer template: undefined when not configured (the extension then uses
	 * its built-in-shaped default), or "" to leave pi's built-in footer in place.
	 */
	template: string | undefined;
	/** Per-message throughput notification template, or undefined for the built-in format. */
	notificationTemplate: string | undefined;
	autoCompactionEnabled: boolean;
}

function isRecord(value: unknown): value is SettingsObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a settings file. Invalid or missing files are treated as unset. */
function readSettingsFile(file: string): SettingsObject | undefined {
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
 * string) replaces the global value wholesale. A project-level `footerTemplate`
 * therefore shadows the global one entirely instead of falling back into it
 * piecewise; only when both sides are objects do their keys merge.
 */
function mergeSettings(
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

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * The configured footer template. Undefined when no template is configured,
 * so the extension falls back to its built-in-shaped default. An empty or
 * whitespace-only template is returned as "" and leaves pi's built-in footer
 * in place.
 */
function getFooterTemplate(settings: SettingsObject): string | undefined {
	const value = settings.footerTemplate;
	if (typeof value === "string") return value.trim() === "" ? "" : value;
	if (isRecord(value) && typeof value.template === "string") {
		return value.template.trim() === "" ? "" : value.template;
	}
	return undefined;
}

/** The per-message notification template, only available in object form. */
function getNotificationTemplate(settings: SettingsObject): string | undefined {
	const value = settings.footerTemplate;
	if (!isRecord(value) || typeof value.notificationTemplate !== "string") return undefined;
	return nonEmpty(value.notificationTemplate);
}

function getCompactionEnabled(settings: SettingsObject): boolean | undefined {
	const compaction = settings.compaction;
	if (!isRecord(compaction) || typeof compaction.enabled !== "boolean") return undefined;
	return compaction.enabled;
}

export function resolveFooterConfiguration(ctx: ExtensionContext): FooterConfiguration {
	const globalSettings = readSettingsFile(join(getAgentDir(), "settings.json"));
	const projectSettings = ctx.isProjectTrusted()
		? readSettingsFile(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
		: undefined;
	const settings = mergeSettings(globalSettings, projectSettings);

	return {
		template: getFooterTemplate(settings),
		notificationTemplate: getNotificationTemplate(settings),
		autoCompactionEnabled: getCompactionEnabled(settings) ?? true,
	};
}
