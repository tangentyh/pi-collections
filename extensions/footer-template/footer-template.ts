import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_FOOTER_TEMPLATE,
	formatElapsedTime,
	formatTime,
	getFieldValues,
	renderRunNotification,
	renderTemplate,
} from "./format.js";
import { resolveFooterConfiguration } from "./io.js";
import type { RunStats, SessionUsage, UsageTotals } from "./types.js";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	return (message as { role?: unknown }).role === "assistant";
}

function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input || 0;
	totals.output += usage.output || 0;
	totals.cacheRead += usage.cacheRead || 0;
	totals.cacheWrite += usage.cacheWrite || 0;
	totals.totalTokens += usage.totalTokens || 0;
	totals.cost += usage.cost?.total || 0;
}

/** Match the built-in footer: cumulative usage includes every session entry. */
function computeSessionUsage(ctx: ExtensionContext): SessionUsage {
	const totals = createUsageTotals();
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				addUsage(totals, entry.message.usage);
				const promptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
			} else if (entry.message.role === "toolResult") {
				addUsage(totals, entry.message.usage);
			}
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addUsage(totals, entry.usage);
		}
	}

	return { totals, latestCacheHitRate };
}

function emptyRunStats(): RunStats {
	return {
		tokensPerSecond: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		elapsedTime: "0.0s",
		idleTime: "0.0s",
		time: "",
	};
}

function calculateRunStats(
	messages: readonly unknown[],
	elapsedMs: number,
	idleMs: number,
	endedAt: Date,
): RunStats | undefined {
	const usage = createUsageTotals();
	for (const message of messages) {
		if (isAssistantMessage(message)) addUsage(usage, message.usage);
	}
	if (usage.output <= 0 || elapsedMs <= 0) return undefined;

	const elapsedSeconds = elapsedMs / 1000;
	return {
		tokensPerSecond: usage.output / elapsedSeconds,
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: usage.cost,
		elapsedTime: formatElapsedTime(elapsedSeconds),
		idleTime: formatElapsedTime(idleMs / 1000),
		time: formatTime(endedAt),
	};
}

/** Render pi's footer from a configurable string template. */
export default function footerTemplate(pi: ExtensionAPI): void {
	let agentStartMs: number | null = null;
	let lastAgentEndMs: number | null = null;
	let idleTimeMs = 0;
	let runStats = emptyRunStats();
	let requestFooterRender: (() => void) | undefined;
	let customFooterInstalled = false;

	// Session entries are append-only, and every usage-bearing append is
	// accompanied by a message_end, session_compact, or session_tree event. So
	// the cumulative totals can be cached and invalidated on those events,
	// instead of rescanning the whole session on every render (i.e. every
	// keystroke, resize, and setStatus). message_update intentionally does not
	// invalidate: streaming never touches session entries.
	let sessionUsageCache: SessionUsage | undefined;

	const getSessionUsage = (ctx: ExtensionContext): SessionUsage => {
		if (!sessionUsageCache) sessionUsageCache = computeSessionUsage(ctx);
		return sessionUsageCache;
	};

	pi.on("agent_start", () => {
		const now = performance.now();
		idleTimeMs = lastAgentEndMs === null ? 0 : Math.max(0, now - lastAgentEndMs);
		agentStartMs = now;
	});

	pi.on("agent_end", (event, ctx) => {
		const endedAtMs = performance.now();
		lastAgentEndMs = endedAtMs;
		if (agentStartMs === null) return;

		const elapsedMs = endedAtMs - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		const nextRunStats = calculateRunStats(event.messages, elapsedMs, idleTimeMs, new Date());
		if (!nextRunStats) return;
		runStats = nextRunStats;
		requestFooterRender?.();

		if (!ctx.hasUI) return;
		const configuration = resolveFooterConfiguration(ctx);
		ctx.ui.notify(renderRunNotification(configuration.notificationTemplate, nextRunStats), "info");
	});

	// A custom footer is not automatically invalidated by every state change
	// that affects the built-in footer, so request a redraw for the dynamic
	// fields while keeping all values computed lazily in render().
	const requestRender = () => requestFooterRender?.();
	pi.on("message_update", requestRender);
	pi.on("session_info_changed", requestRender);
	pi.on("model_select", requestRender);
	pi.on("thinking_level_select", requestRender);

	const invalidateUsageCache = () => {
		sessionUsageCache = undefined;
	};
	pi.on("message_end", () => {
		invalidateUsageCache();
		requestRender();
	});
	pi.on("session_compact", () => {
		invalidateUsageCache();
		requestRender();
	});
	pi.on("session_tree", () => {
		invalidateUsageCache();
		requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		agentStartMs = null;
		lastAgentEndMs = performance.now();
		idleTimeMs = 0;
		runStats = emptyRunStats();
		requestFooterRender = undefined;
		sessionUsageCache = undefined;
		if (ctx.mode !== "tui") return;

		const configuration = resolveFooterConfiguration(ctx);
		// No configured template falls back to the built-in-shaped default; an
		// explicit empty template opts out and keeps pi's built-in footer.
		const footerTemplate = configuration.template ?? DEFAULT_FOOTER_TEMPLATE;
		if (!footerTemplate) {
			if (customFooterInstalled) {
				ctx.ui.setFooter(undefined);
				customFooterInstalled = false;
			}
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;
			const unsubscribeBranchChanges = footerData.onBranchChange(requestRender);

			return {
				invalidate() {},
				render(width: number): string[] {
					const fields = getFieldValues(
						ctx,
						footerData,
						getSessionUsage(ctx),
						runStats,
						configuration.autoCompactionEnabled,
					);
					return renderTemplate(footerTemplate, fields, width, theme);
				},
				dispose() {
					unsubscribeBranchChanges();
					if (requestFooterRender === requestRender) requestFooterRender = undefined;
				},
			};
		});
		customFooterInstalled = true;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (customFooterInstalled) {
			ctx.ui.setFooter(undefined);
			customFooterInstalled = false;
		}
		agentStartMs = null;
		lastAgentEndMs = null;
		requestFooterRender = undefined;
		sessionUsageCache = undefined;
	});
}
