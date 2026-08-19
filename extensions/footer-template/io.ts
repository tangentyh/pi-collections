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
	template: string;
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

/** An empty or whitespace-only template is treated as unset, leaving pi's built-in footer in place. */
function getFooterTemplate(settings: SettingsObject | undefined): string | undefined {
	const value = settings?.footerTemplate;
	if (typeof value === "string") return value.trim() === "" ? undefined : value;
	if (isRecord(value) && typeof value.template === "string") {
		return value.template.trim() === "" ? undefined : value.template;
	}
	return undefined;
}

function getCompactionEnabled(settings: SettingsObject | undefined): boolean | undefined {
	const compaction = settings?.compaction;
	if (!isRecord(compaction) || typeof compaction.enabled !== "boolean") return undefined;
	return compaction.enabled;
}

export function resolveFooterConfiguration(ctx: ExtensionContext): FooterConfiguration | undefined {
	const globalSettings = readSettingsFile(join(getAgentDir(), "settings.json"));
	const projectSettings = ctx.isProjectTrusted()
		? readSettingsFile(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"))
		: undefined;
	const template = getFooterTemplate(projectSettings) ?? getFooterTemplate(globalSettings);

	// With no template configured, leave pi's native footer in place instead of
	// replacing it with a second approximation of the built-in layout.
	if (template === undefined) return undefined;

	return {
		template,
		autoCompactionEnabled:
			getCompactionEnabled(projectSettings) ?? getCompactionEnabled(globalSettings) ?? true,
	};
}
