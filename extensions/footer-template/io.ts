import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CURRENCIES } from "./currency.js";

interface SettingsObject {
	[key: string]: unknown;
}

export interface FooterConfiguration {
	/**
	 * Footer template: undefined when not configured (the extension then uses
	 * its built-in-shaped default), or "" to leave pi's built-in footer in place.
	 */
	template: string | undefined;
	/**
	 * Per-message throughput notification template: undefined when not
	 * configured (the extension then uses its default format), or "" to
	 * disable the notification entirely.
	 */
	notificationTemplate: string | undefined;
	/**
	 * Display currency for cost and balance figures: always a valid
	 * `CURRENCIES` key; "USD" when not configured. Set with `/set-currency`
	 * (which writes the global settings) or directly via the `costCurrency`
	 * key in the `footerTemplate` settings object; a project-level value
	 * shadows the global one like any other setting.
	 */
	costCurrency: string;
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

/**
 * The per-message notification template, only available in object form.
 * Undefined when not configured, so the extension uses its default format.
 * An empty or whitespace-only template is returned as "" and disables the
 * notification, matching the footer template's opt-out behavior.
 */
function getNotificationTemplate(settings: SettingsObject): string | undefined {
	const value = settings.footerTemplate;
	if (!isRecord(value) || typeof value.notificationTemplate !== "string") return undefined;
	return value.notificationTemplate.trim() === "" ? "" : value.notificationTemplate;
}

function getCompactionEnabled(settings: SettingsObject): boolean | undefined {
	const compaction = settings.compaction;
	if (!isRecord(compaction) || typeof compaction.enabled !== "boolean") return undefined;
	return compaction.enabled;
}

/**
 * The configured display currency. Always a valid `CURRENCIES` key; "USD"
 * when unset or invalid.
 */
function getCostCurrency(settings: SettingsObject): string {
	const footer = settings.footerTemplate;
	if (!isRecord(footer) || typeof footer.costCurrency !== "string") return "USD";
	return CURRENCIES[footer.costCurrency] ? footer.costCurrency : "USD";
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
		costCurrency: getCostCurrency(settings),
		autoCompactionEnabled: getCompactionEnabled(settings) ?? true,
	};
}

/**
 * Persist the display currency in global settings as
 * `footerTemplate.costCurrency`, preserving all other settings. The project
 * settings file is untouched; a project-level `costCurrency` still shadows
 * the global value through the usual merge. Failures are logged and ignored,
 * so the change just won't persist.
 */
export function writeGlobalCostCurrency(ccy: string): void {
	const settingsPath = join(getAgentDir(), "settings.json");
	try {
		const settings = readSettingsFile(settingsPath) ?? {};
		const footer = settings.footerTemplate;
		// Keep a string-form footerTemplate working: it only configures the
		// template, which the object form's `template` key preserves.
		settings.footerTemplate = isRecord(footer)
			? { ...footer, costCurrency: ccy }
			: typeof footer === "string"
				? { template: footer, costCurrency: ccy }
				: { costCurrency: ccy };
		mkdirSync(getAgentDir(), { recursive: true });
		const tmp = `${settingsPath}.tmp`;
		writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
		renameSync(tmp, settingsPath);
	} catch (error) {
		console.error("pi-footer-template: writeGlobalCostCurrency failed", error);
	}
}
