import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Label pi's working indicator carries before the clock is appended. */
export const DEFAULT_LABEL = "Working";

/** How often the label is refreshed while a run is in flight. */
export const TICK_MS = 1000;

/**
 * Elapsed time as a compact label: `12s`, `1m 04s`, `1h 02m`.
 *
 * Whole seconds only — the tick is one second, so tenths would add redraw
 * churn without saying anything new — and zero-padded remainders so the text
 * does not jitter in width while it counts.
 */
export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The working-indicator text for a run that started `elapsedMs` ago. */
export function formatWorkingMessage(
	elapsedMs: number,
	label = DEFAULT_LABEL,
): string {
	return `${label} · ${formatElapsed(elapsedMs)}`;
}

/** Schedules a repeating tick; the returned function cancels it. */
export type Schedule = (tick: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (tick, ms) => {
	const handle = setInterval(tick, ms);
	// A timer must never be the reason pi stays alive (same reason pi-tui's own
	// loaders stop on dispose).
	(handle as { unref?: () => void }).unref?.();
	return () => clearInterval(handle);
};

export interface WorkingTimerOptions {
	/** Clock, injectable for tests. */
	now?: () => number;
	/** Ticker, injectable for tests. */
	schedule?: Schedule;
}

/**
 * The elapsed-time state machine behind the working line.
 *
 * A "run" here is one agent run: `agent_start` through `agent_settled`, which
 * spans every tool round, automatic retry, compaction retry and queued
 * continuation. `agent_end` is deliberately not the end — pi emits it per
 * agent-loop iteration, before deciding to retry or continue.
 *
 * The clock starts at the moment the prompt was *submitted* (pi's `input`
 * event), not at `agent_start`, which fires after prompt expansion and queue
 * flush — the user is waiting from the keystroke, not from the request.
 */
export class WorkingTimer {
	private readonly paint: (message: string | undefined) => void;
	private readonly options: WorkingTimerOptions;
	/** Submission time of the prompt this run belongs to, if one was seen. */
	private submittedAt: number | undefined;
	private startedAt: number | undefined;
	private cancelTick: (() => void) | undefined;

	constructor(
		paint: (message: string | undefined) => void,
		options: WorkingTimerOptions = {},
	) {
		this.paint = paint;
		this.options = options;
	}

	/** True while a run is being timed. */
	get running(): boolean {
		return this.startedAt !== undefined;
	}

	/**
	 * A prompt was submitted while idle: remember when, so the run's clock
	 * starts at the user's send. Submissions during a run (steer/follow-up)
	 * keep the existing start — one continuous clock for one stretch of work.
	 */
	noteInput(at = this.now()): void {
		if (this.startedAt !== undefined) return;
		this.submittedAt = at;
	}

	/** A run began: take over the working line and start ticking. */
	start(at = this.now()): void {
		if (this.startedAt !== undefined) return;
		this.startedAt = this.submittedAt ?? at;
		this.submittedAt = undefined;
		this.paintTick();
		this.cancelTick = (this.options.schedule ?? defaultSchedule)(
			() => this.paintTick(),
			TICK_MS,
		);
	}

	/**
	 * The run settled (or the session is going away): stop ticking and hand
	 * the working message back to pi by clearing it. Idempotent, and silent
	 * when no run was timed — pi's `setWorkingMessage` is a single global slot,
	 * so clearing a message this extension never set would stomp someone
	 * else's.
	 */
	stop(): void {
		const wasRunning = this.startedAt !== undefined;
		this.cancelTick?.();
		this.cancelTick = undefined;
		this.startedAt = undefined;
		this.submittedAt = undefined;
		if (wasRunning) this.paint(undefined);
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private paintTick(): void {
		if (this.startedAt === undefined) return;
		this.paint(formatWorkingMessage(this.now() - this.startedAt));
	}
}

/**
 * Wire the timer to pi's events.
 *
 * pi exposes the working line as one string (`ctx.ui.setWorkingMessage`) with
 * no getter, and stores it on the session rather than on the loader — so a
 * message set here survives the loader pi recreates each turn, and whoever
 * writes last wins. Nothing here reads the previous message; it cannot.
 */
export function registerWorkingTimer(
	pi: ExtensionAPI,
	options: WorkingTimerOptions = {},
): void {
	// Contexts are per-dispatch objects, so the paint target is whichever one
	// last handled an event.
	let ctx: ExtensionContext | undefined;
	const timer = new WorkingTimer(
		(message) => ctx?.ui.setWorkingMessage(message),
		options,
	);

	/**
	 * Record the context and report whether this mode has a working line at
	 * all. RPC/JSON/print modes accept `setWorkingMessage` as a no-op, so a
	 * ticker there would be pure cost.
	 */
	const usable = (context: ExtensionContext): boolean => {
		ctx = context;
		return context.mode === "tui";
	};

	pi.on("input", (event, context) => {
		if (!usable(context)) return;
		// Extension-injected messages have no user waiting on them; a run they
		// start is timed from `agent_start` instead.
		if (event.source === "extension") return;
		timer.noteInput();
	});

	pi.on("agent_start", (_event, context) => {
		if (!usable(context)) return;
		timer.start();
	});

	pi.on("agent_settled", (_event, context) => {
		if (!usable(context)) return;
		timer.stop();
	});

	pi.on("session_shutdown", () => {
		timer.stop();
		ctx = undefined;
	});
}

/** Live elapsed time in pi's working indicator: `Working · 1m 04s`. */
export default function (pi: ExtensionAPI): void {
	registerWorkingTimer(pi);
}
