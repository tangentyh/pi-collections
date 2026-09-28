// index.ts — entry point: event wiring + orchestration.
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { buildContext, type NamingContext } from "./context.js";
import { debug, initDebug } from "./debug.js";
import { collectExistingSessionNames } from "./dedup.js";
import {
	type GenerateFailureReason,
	type GenerateNamesResult,
	generateNames,
	type NamingSession,
	UI_RENAME_TIMEOUT_MS,
} from "./naming.js";
import {
	canReplace,
	handleSessionInfoChanged,
	reconcileProvenanceOnStart,
} from "./ownership.js";
import { createState, type RenameState, restoreProvenance } from "./state.js";
import {
	applySessionName,
	logSurfacesEnv,
	syncSurfaces,
	windowNameForSync,
} from "./surfaces.js";

/**
 * Everything a rename run needs from the event context, captured synchronously
 * after the generation guard and before the naming pipeline yields, so the
 * deferred flow never touches a stale-guarded ctx getter.
 */
interface PreparedRename {
	/**
	 * The pure generation signal at prepare time. Aborted on session_shutdown
	 * and superseded by the re-mint on session_start, so post-step checks
	 * against it detect a replaced session. Deliberately NOT the combined
	 * fetch signal (NamingSession.signal), which can abort for non-replacement
	 * reasons.
	 */
	generation: AbortSignal;
	state: RenameState;
	c: Config;
	currentName: string | undefined;
	context: NamingContext;
	cwd: string;
	sessionFile: string | undefined;
	session: NamingSession;
	/** May write the per-session pi name (mode gate AND `renamePiSession`). */
	renameSession: boolean;
	/** May write the process-global terminal surfaces (mode gate). */
	renameSurfaces: boolean;
}

/**
 * Options for a rename run. `currentInput` carries the in-progress user turn
 * — only the `input` handler sets it (it fires before pi appends the
 * message); `agent_settled` handlers leave it unset and read the transcript.
 */
interface RenameOptions {
	timeoutMs?: number;
	currentInput?: string;
}

/** Optional test seam: overrides config loading (production uses ./config.js). */
export interface AutoRenameDeps {
	loadConfig?: (ctx: ExtensionContext) => Config | Promise<Config>;
}

/**
 * Whether this session may write the process-global terminal surfaces (tmux
 * window, herdr/zellij pane/tab). Subagent child sessions are bound with the
 * default mode "print" (pi-subagents never passes `mode`), while the
 * interactive session is "tui"; the mode signal is the only child-session
 * marker pi exposes to extensions. Kept separate from `ownsPiSessionName`: the
 * pi name is per-session (a child naming itself is harmless), while these
 * surfaces are process-global (a child writing them relabels the parent's
 * pane). `surfaces.renameMultiplexersInNonTuiModes` is the escape hatch for
 * users who drive pi through RPC/print inside a multiplexer and want it named.
 */
export function ownsTerminalSurfaces(
	ctx: ExtensionContext,
	cfg: Config,
): boolean {
	return cfg.surfaces.renameMultiplexersInNonTuiModes || ctx.mode === "tui";
}

/**
 * Whether this session may write its own pi session name. Same mode signal as
 * `ownsTerminalSurfaces` but a separate gate, because the name is scoped to the
 * session: a subagent child can name itself without touching the parent, so
 * `surfaces.renamePiSessionInNonTuiModes` can be enabled on its own while the
 * process-global surfaces stay off.
 */
export function ownsPiSessionName(ctx: ExtensionContext, cfg: Config): boolean {
	return cfg.surfaces.renamePiSessionInNonTuiModes || ctx.mode === "tui";
}

/**
 * The signal a rename fetch runs with: the event ctx's signal when pi
 * provides one, combined with the generation signal so a session
 * replacement/reload preempts the fetch. ctx.signal is expected to be
 * undefined at both registered triggers (they fire while idle), in which
 * case the generation signal alone applies.
 */
function namingSignal(
	ctxSignal: AbortSignal | undefined,
	generation: AbortSignal,
): AbortSignal {
	if (!ctxSignal) return generation;
	if (typeof AbortSignal.any === "function")
		return AbortSignal.any([ctxSignal, generation]);
	return ctxSignal;
}

export default function (pi: ExtensionAPI, deps?: AutoRenameDeps): void {
	// NB: no action calls (appendEntry / registerEntryRenderer / ...) here — during
	// extension loading the runtime actions are throwing stubs. initDebug only
	// stores pi; the first gated debug() call (from an event handler) registers
	// the renderer and appends entries.
	initDebug(pi);
	let state: RenameState = createState();
	let cfg: Config | undefined;
	/**
	 * Per-generation abort controller. Aborted on `session_shutdown` — every
	 * replacement path (reload/new/resume/fork/quit) emits it to the old runner
	 * before invalidation — and re-minted on `session_start`. Its signal is
	 * both the preemption mechanism (fed to the naming fetch via prepareRename,
	 * see namingSignal) and the staleness token: handlers capture it on entry
	 * and the pipeline re-checks it after each step, so work from a replaced
	 * session exits instead of touching a stale ctx or renaming the wrong
	 * session. Abort classification lives in naming.ts.
	 */
	let generationController = new AbortController();

	/**
	 * Delayed initialization: load config from the first event ctx that needs it
	 * and cache it for the session (`session_start` resets the cache). The ctx is
	 * not retained past the load.
	 */
	async function config(ctx: ExtensionContext): Promise<Config> {
		if (!cfg) {
			const load =
				deps?.loadConfig ??
				(async (ctx: ExtensionContext) => {
					const { loadConfig } = await import("./config.js");
					return loadConfig(ctx);
				});
			cfg = await load(ctx);
		}
		return cfg;
	}

	/**
	 * Guard checks + synchronous preparation, run after config loading confirms
	 * the event's generation is still current. Returns undefined when the rename is
	 * skipped (disabled, done, inflight/locked, un-replaceable name, or no
	 * naming context yet).
	 *
	 * Crucially, the naming context is built HERE - before the naming pipeline's
	 * first await and after the generation check - so `ctx.sessionManager` is read
	 * only while the session remains active. Session-bound values go into a plain
	 * `PreparedRename` snapshot; the (possibly deferred) flow that follows never
	 * touches a stale-guarded ctx getter again.
	 */
	function prepareRename(
		ctx: ExtensionContext,
		options: RenameOptions | undefined,
	): PreparedRename | undefined {
		// cfg is read synchronously so this preparation remains before the next
		// await in every caller. config(ctx) has already populated the cache.
		const c = cfg as Config;
		if (!c.enabled || state.done || state.inflight || state.autoRenameLocked) {
			// A completed initial rename (`done` or `!enabled`) is the expected
			// steady-state between re-renames — not worth logging on every input.
			// Log only the transient blocks that indicate something may be stuck.
			if (state.inflight || state.autoRenameLocked) {
				debug("renameOnce: skip (inflight or locked)", {
					enabled: c.enabled,
					done: state.done,
					inflight: state.inflight,
					autoRenameLocked: state.autoRenameLocked,
				});
			}
			return undefined;
		}

		// The two mode gates are independent. `renameSession` also folds in the
		// user-facing `renamePiSession` switch, so a session with nothing to write
		// (a subagent child under the defaults) bails before the naming LLM call.
		const renameSession =
			c.surfaces.renamePiSession && ownsPiSessionName(ctx, c);
		const renameSurfaces = ownsTerminalSurfaces(ctx, c);
		if (!renameSession && !renameSurfaces) {
			debug(
				"renameOnce: skip (session owns neither its name nor the terminal surfaces)",
				{ mode: ctx.mode },
			);
			return undefined;
		}

		const currentName = pi.getSessionName();
		// The replaceability policy governs the session name only: a surfaces-only
		// run still proceeds, since `session_start` derives its window name from
		// the current name and the run stays bounded by `done`.
		if (renameSession && !canReplace(currentName, c.replaceExistingName)) {
			debug("renameOnce: name not replaceable — latching done", {
				currentName,
				policy: c.replaceExistingName,
			});
			state.done = true;
			return undefined;
		}

		// Build the naming context synchronously with the fresh ctx. The
		// in-progress user turn is threaded in explicitly: the `input` event
		// fires before pi appends the message, so the transcript alone has no
		// seed on the very first turn.
		let context: NamingContext | undefined;
		try {
			context = buildContext(ctx, c, options?.currentInput);
		} catch (error) {
			debug("renameOnce: buildContext failed", String(error));
			return undefined;
		}
		if (!context) {
			debug("renameOnce: no naming context available");
			return undefined;
		}

		state.inflight = true;
		state.nameAtGenerationStart = currentName;
		debug("renameOnce: starting generation", {
			currentName,
			timeoutMs: options?.timeoutMs,
		});
		return {
			generation: generationController.signal,
			state,
			c,
			currentName,
			context,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			renameSession,
			renameSurfaces,
			session: {
				modelRegistry: ctx.modelRegistry,
				model: ctx.model,
				// NOTE: ctx.signal is expected to be undefined here — both callers
				// (input, agent_settled) run while the agent is idle. Preemption
				// across session replacement/reload comes from the generation
				// signal; the post-step generation checks below remain as backup.
				// See NamingSession.signal.
				signal: namingSignal(ctx.signal, generationController.signal),
			},
		};
	}

	/**
	 * The rename pipeline on top of a prepared snapshot (no ctx access). Each
	 * risky step is wrapped in its own small try/catch that logs exactly where it
	 * failed and rethrows, so the caller of the pipeline still resets `inflight`/
	 * `done` and debug pinpoints the failing stage.
	 */
	async function completeRename(
		p: PreparedRename,
		options: { timeoutMs?: number } | undefined,
	): Promise<void> {
		const { c, currentName } = p;

		// Step 1: collect existing sibling session names (dedup hints). A failure
		// here is non-fatal — the prompt just loses the dedup hints. Uses the
		// captured cwd/sessionFile, not ctx.
		let titles: string[] = [];
		if (!c.skipSessionNameDedup) {
			try {
				titles = await collectExistingSessionNames(p.cwd, p.sessionFile);
			} catch (error) {
				debug(
					"renameOnce: collectExistingSessionNames failed — continuing without dedup",
					String(error),
				);
				titles = [];
			}
		}
		if (p.generation.aborted) return;

		// Step 2: generate the names (LLM + fallback) from the prebuilt context and
		// captured session refs. generateNames returns its failures rather than
		// throwing, so a throw here would be unexpected.
		let result: GenerateNamesResult;
		try {
			result = await generateNames(
				p.session,
				c,
				p.context,
				titles,
				p.cwd,
				pi,
				options,
			);
		} catch (error) {
			debug("renameOnce: generateNames threw unexpectedly", String(error));
			throw error;
		}
		if (p.generation.aborted) return;
		debug("renameOnce: generateNames result", result);

		if (!result.ok) {
			// Aborted by session replacement/reload mid-fetch: this run belongs to
			// a dead session. Exit silently — no failure handling, no fallback
			// (which would rename the wrong session), no done-latching here beyond
			// the caller's standard reset of its own (possibly detached) state.
			if (result.reason === "aborted") {
				debug(
					"renameOnce: naming aborted (session replaced) — exiting silently",
				);
				return;
			}
			await handleFailure(result.reason);
			return;
		}

		// Step 3: apply the session name (race-guarded). Skipped when this session
		// may not write its own name (non-TUI with the session gate off) — the
		// surfaces below may still be granted independently.
		if (p.renameSession) {
			try {
				if (
					p.state.autoRenameLocked ||
					pi.getSessionName() !== p.state.nameAtGenerationStart
				) {
					debug(
						"renameOnce: race guard abort — session name changed during generation",
						{
							nameAtGenerationStart: p.state.nameAtGenerationStart,
							current: pi.getSessionName(),
						},
					);
					return;
				}
				debug("renameOnce: applying names", {
					previous: currentName,
					next: result.names.sessionName,
					changed: currentName !== result.names.sessionName,
					windowName: result.names.windowName,
				});
				await applySessionName(
					pi,
					p.state,
					c,
					result.names.sessionName,
					result.names.windowName,
				);
			} catch (error) {
				debug("renameOnce: applySessionName failed", String(error));
				throw error;
			}
			if (p.generation.aborted) return;
		}

		// Step 4: sync surfaces to the generated window name. Skipped when this
		// session may not write the process-global terminal surfaces.
		if (p.renameSurfaces) {
			try {
				await syncSurfaces(pi, c, result.names.windowName);
			} catch (error) {
				debug("renameOnce: syncSurfaces failed", String(error));
				throw error;
			}
		}
	}

	/**
	 * Awaited rename: prepare synchronously with the active event ctx, then run the
	 * pipeline to completion. Fired inside the event dispatch for headless flows
	 * (`agent_settled` and `input`), so any error propagates to the runtime, which
	 * wraps the handler await in try/catch and reports it rather than crashing.
	 */
	async function renameOnce(
		ctx: ExtensionContext,
		options?: RenameOptions,
	): Promise<void> {
		const p = prepareRename(ctx, options);
		if (!p) return;
		try {
			await completeRename(p, options);
		} finally {
			p.state.inflight = false;
			p.state.done = true;
		}
	}

	/**
	 * Deferred rename for interactive first-input and UI agent_settled flows:
	 * same synchronous preparation (fresh ctx), but the LLM call + apply run
	 * fire-and-forget so the user's turn is never blocked. The body swallows its
	 * own errors: a deferred continuation can never be an unhandled rejection
	 * (which would crash pi). If the session is replaced/reloaded mid-flight,
	 * the rename for the replaced session is then simply skipped.
	 */
	function renameOnceDeferred(
		ctx: ExtensionContext,
		options?: RenameOptions,
	): void {
		const p = prepareRename(ctx, options);
		if (!p) return;
		void (async () => {
			try {
				await completeRename(p, options);
			} catch (error) {
				debug("renameOnce: deferred rename aborted mid-flight", String(error));
			} finally {
				p.state.inflight = false;
				p.state.done = true;
			}
		})();
	}

	/**
	 * Total-failure handling for the initial rename. Latching `done`
	 * (renameOnce's finally sets it) stops the input path from retrying: the
	 * session simply keeps its current name and the initial rename does not
	 * land this turn. This is not a permanent lockout — a configured
	 * `reRenameEveryNTurns` interval re-arms `done` on its turns, so a
	 * transient failure (model down on turn one) can still recover later.
	 */
	async function handleFailure(reason: GenerateFailureReason): Promise<void> {
		debug("renameOnce: name generation failed — latching done (no retry)", {
			reason,
		});
	}

	pi.on("session_start", async (event, ctx) => {
		// Re-mint for the new generation, invalidating the previous one. Normally
		// already-fresh (a reloaded factory gets a new closure), but a shared
		// closure across replacement would otherwise inherit an aborted
		// controller and fail every rename.
		generationController.abort();
		generationController = new AbortController();
		const generation = generationController.signal;
		state = createState();
		cfg = undefined;
		restoreProvenance(ctx, state);
		const c = await config(ctx);
		if (generation.aborted) return;
		debug("session_start", {
			reason: event.reason,
			restored: {
				lastAutoName: state.lastAutoName,
				lastAutoWindowName: state.lastAutoWindowName,
			},
		});

		// Respect an existing deliberate name; still sync surfaces to a window
		// name derived from it (stored window name, else compacted session name).
		const currentName = pi.getSessionName();
		reconcileProvenanceOnStart(state, currentName, c.respectExternalRenames);
		if (currentName && !canReplace(currentName, c.replaceExistingName)) {
			debug(
				"session_start: existing deliberate name — initial rename skipped",
				{ currentName },
			);
			state.done = true;
		}
		logSurfacesEnv();
		if (ownsTerminalSurfaces(ctx, c)) {
			debug("session_start: syncing surfaces", { currentName });
			await syncSurfaces(pi, c, windowNameForSync(state, currentName));
		} else {
			debug("session_start: surfaces not synced (session does not own them)", {
				mode: ctx.mode,
			});
		}
	});

	pi.on("input", async (event, ctx) => {
		const generation = generationController.signal;
		if (generation.aborted) return;
		const c = await config(ctx);
		if (generation.aborted) return;
		if (!c.enabled || c.initialRenameTrigger !== "first-input") {
			debug("input: ignored", {
				enabled: c.enabled,
				trigger: c.initialRenameTrigger,
			});
			return;
		}
		if (event.source === "extension") {
			debug("input: ignored (extension source)");
			return; // injected by another extension, not the user
		}
		const text = (event.text ?? "").trim();
		if (!text) {
			debug("input: ignored (empty text)");
			return;
		}
		debug("input: triggering rename", {
			hasUI: ctx.hasUI,
			text: text.slice(0, 80),
		});
		// With a UI present, never block the user's turn on the naming LLM call:
		// prepare synchronously (fresh ctx) and defer only the LLM + apply with a
		// shorter naming budget so the rename lands before the agent gets far into
		// its turn. Headless (RPC/print) awaits the full budget (§4 rule 5 note;
		// Gap 5). Either way the in-progress turn is threaded in as the seed: the
		// `input` event fires before pi appends the message, so the transcript
		// alone has nothing to name on the very first turn.
		if (ctx.hasUI) {
			renameOnceDeferred(ctx, {
				timeoutMs: UI_RENAME_TIMEOUT_MS,
				currentInput: text,
			});
			return;
		}
		await renameOnce(ctx, { currentInput: text });
	});

	/**
	 * agent_settled fires once pi will not continue running automatically —
	 * after auto-retries, compaction-retries, and queued follow-ups are all
	 * done. That makes it the one clean boundary per *user-facing* turn: one
	 * real user input = one agent_settled. Contrast agent_end (fires mid-
	 * activity, while pi may still auto-compact/retry or run follow-ups) and
	 * turn_end (fires once per model continuation), which is why the initial
	 * rename and the turn-interval re-rename both live here.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		const generation = generationController.signal;
		if (generation.aborted) return;
		const c = await config(ctx);
		if (generation.aborted) return;
		if (!c.enabled) return;
		state.turnsSeen += 1;

		// Initial rename (first-agent-settled trigger): fires after the first
		// agent run has fully settled, so the naming context is stable. With a UI,
		// defer the naming request so the next user turn is not blocked; headless
		// callers keep the awaited behavior.
		if (c.initialRenameTrigger === "first-agent-settled" && !state.done) {
			debug("agent_settled: triggering initial rename", { hasUI: ctx.hasUI });
			if (ctx.hasUI) {
				renameOnceDeferred(ctx, { timeoutMs: UI_RENAME_TIMEOUT_MS });
			} else {
				await renameOnce(ctx, { timeoutMs: undefined });
			}
			return;
		}

		// Turn-interval re-rename. agent_settled counts real user-facing turns
		// (one input = one settled turn), so reRenameEveryNTurns behaves exactly
		// as its name implies — no per-continuation churn, and it fires at the
		// settled boundary rather than mid-turn. The first settled turn belongs
		// to the initial rename (landed at its input, or just above at its
		// settle), so intervals start counting from turn 2: without this, N=1
		// would re-rename on the very turn the initial rename landed and
		// overwrite it.
		if (
			c.reRenameEveryNTurns > 0 &&
			state.done &&
			state.turnsSeen > 1 &&
			state.turnsSeen % c.reRenameEveryNTurns === 0
		) {
			const currentName = pi.getSessionName();
			const blocked = state.inflight || state.autoRenameLocked;
			const replaceable = canReplace(currentName, c.replaceExistingName);
			debug("agent_settled: re-rename check", {
				turnsSeen: state.turnsSeen,
				interval: c.reRenameEveryNTurns,
				currentName,
				inflight: state.inflight,
				autoRenameLocked: state.autoRenameLocked,
				canReplace: replaceable,
				renamed: !blocked && replaceable,
			});
			if (!blocked && replaceable) {
				const prevDone = state.done;
				state.done = false; // allow a re-run
				if (ctx.hasUI) {
					renameOnceDeferred(ctx, { timeoutMs: UI_RENAME_TIMEOUT_MS });
				} else {
					await renameOnce(ctx, { timeoutMs: undefined });
				}
				state.done = prevDone || state.done;
			}
		}
	});

	pi.on("session_info_changed", async (event, ctx) => {
		const generation = generationController.signal;
		if (generation.aborted) return;
		const c = await config(ctx);
		if (generation.aborted) return;
		const isEcho = event.name === state.lastAutoName;
		debug("session_info_changed", {
			name: event.name,
			isEcho,
			lastAutoName: state.lastAutoName,
			respectExternalRenames: c.respectExternalRenames,
		});
		handleSessionInfoChanged(state, event.name, c.respectExternalRenames);
		// Echoes of our own rename already synced surfaces inside renameOnce;
		// only external renames (user /name, RPC, other extensions) re-sync here.
		if (!isEcho && ownsTerminalSurfaces(ctx, c))
			await syncSurfaces(pi, c, windowNameForSync(state, event.name));
	});

	pi.on("session_shutdown", async () => {
		// Preempt any in-flight naming fetch from this (now dead) generation at
		// the provider boundary. The pipeline classifies the abort and exits
		// silently (see naming.ts); post-step generation checks remain as backup.
		generationController.abort();
	});
}
