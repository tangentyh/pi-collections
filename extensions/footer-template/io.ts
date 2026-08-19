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
	/** Footer template, or undefined to leave pi's built-in footer in place. */
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

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** An empty or whitespace-only template is treated as unset, leaving pi's built-in footer in place. */
function getFooterTemplate(settings: SettingsObject | undefined): string | undefined {
	const value = settings?.footerTemplate;
	if (typeof value === "string") return nonEmpty(value);
	if (isRecord(value) && typeof value.template === "string") return nonEmpty(value.template);
	return undefined;
}

/** The per-message notification template, only available in object form. */
function getNotificationTemplate(settings: SettingsObject | undefined): string | undefined {
	const value = settings?.footerTemplate;
	if (!isRecord(value) || typeof value.notificationTemplate !== "string") return undefined;
	return nonEmpty(value.notificationTemplate);
}

function getCompactionEnabled(settings: SettingsObject | undefined): boolean | undefined {
	const compaction = settings?.compaction;
	if (!isRecord(compaction) || typeof compaction.enabled !== "boolean") return undefined;
	return compaction.enabled;
}

export function resolveFooterConfiguration(ctx: ExtensionContext): FooterConfiguration {
	const globalSettings = readSettingsFile(join(getAgentDir(), "settings.json"));
	const projectSettings = ctx.isProjectTrusted()
		? readSettingsFile(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
		: undefined;

	return {
		template: getFooterTemplate(projectSettings) ?? getFooterTemplate(globalSettings),
		notificationTemplate:
			getNotificationTemplate(projectSettings) ?? getNotificationTemplate(globalSettings),
		autoCompactionEnabled:
			getCompactionEnabled(projectSettings) ?? getCompactionEnabled(globalSettings) ?? true,
	};
}
