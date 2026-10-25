// state.ts — per-session state + transcript provenance / naming-spend ledger.
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { GREETING_ENTRY_TYPE } from "./greeting.js";
import type { NamingUsage } from "./naming.js";

export const ENTRY_TYPE = "pi-auto-name";

/**
 * Custom entry type for this session's naming spend: one entry per billed
 * naming run. Durable on purpose — it is what lets the footer figure survive
 * /reload and resume, and it is the only record in the session file that a
 * naming call happened (pi's own session cost sums assistant/usage entries,
 * and an extension cannot append those).
 */
export const USAGE_ENTRY_TYPE = "pi-auto-name:usage";

/** Data of one usage entry: the billed usage of one naming run, plus its time. */
export interface UsageEntryData extends NamingUsage {
	at: string;
}

export interface RenameState {
	done: boolean; // initial rename completed or skipped
	inflight: boolean; // generation in progress
	lastAutoName: string | undefined; // last STORED session name set by this extension (echo suppression)
	lastAutoWindowName: string | undefined; // last STORED window name set by this extension (surface restore on resume)
	autoRenameLocked: boolean; // external rename latched: auto-renaming is locked off for the session (when respectExternalRenames)
	turnsSeen: number; // agent_settled counter (turn-interval re-rename; one settled user-facing turn = one unit)
	nameAtGenerationStart: string | undefined; // for the race guard
	namingCalls: number; // billed naming runs this session (usage entries)
	namingTokens: number; // input + output + cacheRead + cacheWrite of those runs
	namingCost: number; // USD, as pi-ai priced it
	namingModel: string | undefined; // last model that produced a name (greeting/status context)
}

export function createState(): RenameState {
	return {
		done: false,
		inflight: false,
		lastAutoName: undefined,
		lastAutoWindowName: undefined,
		autoRenameLocked: false,
		turnsSeen: 0,
		nameAtGenerationStart: undefined,
		namingCalls: 0,
		namingTokens: 0,
		namingCost: 0,
		namingModel: undefined,
	};
}

/**
 * Record a rename: remember the STORED (normalized) session name for echo
 * suppression and the window name for surface restore, and persist both as
 * provenance. The caller passes the name it set; the stored name is re-read
 * from pi so that normalization inside setSessionName (trim, newline collapse)
 * cannot break the echo-equality check in ownership.ts. The extension
 * session_info_changed echo is dispatched fire-and-forget (async), so
 * lastAutoName is always set before the echo handler runs. `windowName` is
 * optional: the temporary-title flow records a session name only, leaving the
 * previous window name intact.
 */
export function recordAutoRename(
	pi: ExtensionAPI,
	state: RenameState,
	sessionName: string,
	windowName?: string,
): void {
	state.lastAutoName = sessionName;
	if (windowName) state.lastAutoWindowName = windowName;
	pi.appendEntry(ENTRY_TYPE, {
		sessionName,
		...(windowName ? { windowName } : {}),
		at: new Date().toISOString(),
	});
}

/**
 * Fold one billed naming run into the session totals.
 *
 * Tokens count all four buckets: a cached read is billed (cheaper) and would
 * silently vanish from the figure otherwise.
 */
function accumulateUsage(state: RenameState, usage: NamingUsage): void {
	state.namingCalls += 1;
	state.namingTokens +=
		usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	state.namingCost += usage.cost;
	state.namingModel = usage.responseModel ?? usage.model;
}

/**
 * Record the spend of one naming run: accumulate in memory and append the
 * durable ledger entry. Called from the pipeline on every ok result that
 * carries usage — NOT from applySessionName, which returns early when
 * `surfaces.renamePiSession` is off and would lose the spend of a
 * surfaces-only run. Appended once per billed run, regardless of which
 * surfaces were written.
 *
 * Deliberately no numbering/capping: one line per billed naming run, so the
 * footer figure stays auditable in the session file. With
 * `reRenameEveryNTurns: 1` that is one small entry per settled turn.
 */
export function recordNamingUsage(
	pi: ExtensionAPI,
	state: RenameState,
	usage: NamingUsage,
): void {
	accumulateUsage(state, usage);
	pi.appendEntry<UsageEntryData>(USAGE_ENTRY_TYPE, {
		...usage,
		at: new Date().toISOString(),
	});
}

/** What the transcript scan found that is not a running total. */
export interface RestoredTranscriptState {
	/** A startup greeting entry already exists (skip re-appending it on resume). */
	hasGreeting: boolean;
}

/**
 * One pass over the transcript for every custom entry this extension owns, so
 * `lastAutoName`/`lastAutoWindowName` (provenance), the naming-spend totals
 * (usage ledger) and the greeting marker survive reload/resume. The greeting
 * idempotence check rides on this same pass instead of a second
 * `getEntries()` walk.
 *
 * Sessions recorded before the ledger existed simply have no usage entries:
 * totals stay 0 and the cost status stays hidden.
 */
export function restoreTranscriptState(
	ctx: ExtensionContext,
	state: RenameState,
): RestoredTranscriptState {
	let hasGreeting = false;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom") continue;
		if (entry.customType === GREETING_ENTRY_TYPE) {
			hasGreeting = true;
			continue;
		}
		if (entry.customType === USAGE_ENTRY_TYPE) {
			const usage = entry.data as Partial<UsageEntryData> | undefined;
			if (!usage) continue;
			accumulateUsage(state, {
				provider: usage.provider ?? "",
				model: usage.model ?? "",
				...(usage.responseModel ? { responseModel: usage.responseModel } : {}),
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				cost: usage.cost ?? 0,
			});
			continue;
		}
		if (entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as
			| { sessionName?: string; windowName?: string }
			| undefined;
		if (!data) continue;
		if (typeof data.sessionName === "string")
			state.lastAutoName = data.sessionName;
		// Restored verbatim: what we persisted was already the canonical surface
		// label (sanitizeWindowName output). Re-compacting here would rewrite
		// non-`natural` styles (topic-project's ｜ separator, slug's hyphens).
		if (typeof data.windowName === "string")
			state.lastAutoWindowName = data.windowName;
	}
	return { hasGreeting };
}
