// Test suite for auto-rename's subagent-surface gating, run against the REAL
// extension module. Node cannot strip this extension's TypeScript directly
// (its internal imports use `.js` specifiers and config.ts imports a Node
// module that is itself TypeScript), so — like sticky-last-prompt's suite —
// this file compiles the extension with the repo's tsc into a temp dir INSIDE
// the repo (so bare `@earendil-works/*` imports resolve against the workspace
// node_modules) and imports the emitted JS.
//
// Config loading is injected through the `AutoRenameDeps` test seam, so
// config.ts is never imported at runtime.
//
// Run: node extensions/auto-rename/tests/test.ts
//  or: npm test -w @tangentyh/pi-auto-rename

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutoRenameDeps } from "../auto-rename.ts";
import type { Config } from "../config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

// tmux is the only surface observable through the stub exec (makeCfg disables
// the herdr/zellij surfaces). PI_AUTO_NAME_DEBUG is deliberately left unset so
// debug() stays a no-op.
process.env.TMUX = "/tmp/tmux-1000/default,123,0";
process.env.TMUX_PANE = "%7";

// ── tiny labelled-check harness ───────────────────────────────────────
// Collects failures instead of aborting on the first one; any failure sets a
// non-zero exit code.

let passed = 0;
let failed = 0;

async function check(
	name: string,
	fn: () => void | Promise<void>,
): Promise<void> {
	try {
		await fn();
		passed++;
	} catch (error) {
		failed++;
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`FAIL ${name}`);
		console.error(`     ${detail}`);
	}
}

// ── config / ctx / pi stubs ───────────────────────────────────────────

type CfgOverrides = Partial<Omit<Config, "surfaces">> & {
	surfaces?: Partial<Config["surfaces"]>;
};

/**
 * A full Config with every non-tmux surface OFF and only the tmux window
 * rename enabled, so `pi.exec("tmux", ...)` is the single observable surface
 * write. The two non-TUI mode gates (`renamePiSessionInNonTuiModes`,
 * `renameMultiplexersInNonTuiModes`) are per-test overrides.
 */
function makeCfg(overrides: CfgOverrides = {}): Config {
	const base: Config = {
		enabled: true,
		surfaces: {
			renamePiSession: true,
			renameHerdrPane: false,
			renameHerdrTab: false,
			renameTmuxWindow: true,
			renameZellijPane: false,
			renameZellijTab: false,
			renamePiSessionInNonTuiModes: false,
			renameMultiplexersInNonTuiModes: false,
		},
		initialRenameTrigger: "first-input",
		reRenameEveryNTurns: 0,
		replaceExistingName: "always",
		respectExternalRenames: true,
		namingStyle: "natural",
		namingContextDepth: "recent-user-messages",
		// Keeps the handler tests hermetic: no sibling-session scan.
		skipSessionNameDedup: true,
		namingModel: "",
		language: "en",
	};
	return {
		...base,
		...overrides,
		surfaces: { ...base.surfaces, ...(overrides.surfaces ?? {}) },
	};
}

interface Stub {
	pi: ExtensionAPI;
	handlers: Map<string, ((...a: unknown[]) => unknown)[]>;
	calls: { cmd: string; args: string[] }[];
	sessionName: string | undefined;
	/** How many times the naming pipeline read `ctx.model`. */
	modelReads: number;
}

/** A stub ExtensionAPI that records event handlers and every exec call. */
function makeStub(): Stub {
	const stub: Stub = {
		pi: undefined as unknown as ExtensionAPI,
		handlers: new Map(),
		calls: [],
		sessionName: undefined,
		modelReads: 0,
	};
	stub.pi = {
		on: (ev: string, h: (...a: unknown[]) => unknown) => {
			stub.handlers.set(ev, [...(stub.handlers.get(ev) ?? []), h]);
		},
		getSessionName: () => stub.sessionName,
		setSessionName: (n: string) => {
			stub.sessionName = n;
		},
		appendEntry: () => {},
		registerEntryRenderer: () => {},
		exec: async (cmd: string, args: string[]) => {
			stub.calls.push({ cmd, args });
			return { stdout: "", stderr: "", code: 0 };
		},
	} as unknown as ExtensionAPI;
	return stub;
}

/**
 * Fake ExtensionContext. `buildContextEntries`/`getSessionFile` are present
 * (beyond the minimum handler needs) so an unguarded session reaches the
 * naming pipeline and reads `ctx.model` — that read is the assertion that
 * prepareRename bailed out before generateNames.
 */
function makeCtx(mode: string, stub: Stub): ExtensionContext {
	return {
		cwd: root,
		mode,
		hasUI: false,
		sessionManager: {
			getEntries: () => [],
			buildContextEntries: () => [],
			getSessionFile: () => undefined,
		},
		signal: undefined,
		isIdle: () => true,
		modelRegistry: undefined,
		get model() {
			stub.modelReads += 1;
			return undefined;
		},
	} as unknown as ExtensionContext;
}

/** The registered handler for `event`, failing loudly when absent. */
function handler(stub: Stub, event: string): (...a: unknown[]) => unknown {
	const list = stub.handlers.get(event);
	assert.ok(list && list.length > 0, `no handler registered for ${event}`);
	return list[0];
}

const tmuxRename = (stub: Stub) => stub.calls.filter((c) => c.cmd === "tmux");

// ── compile + run ─────────────────────────────────────────────────────

interface Mod {
	default: (pi: ExtensionAPI, deps?: AutoRenameDeps) => void;
	ownsTerminalSurfaces: (ctx: ExtensionContext, cfg: Config) => boolean;
	ownsPiSessionName: (ctx: ExtensionContext, cfg: Config) => boolean;
}

const tmpDir = join(root, ".tmp-auto-rename-test");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
try {
	const tsc = join(
		root,
		"node_modules",
		".bin",
		process.platform === "win32" ? "tsc.CMD" : "tsc",
	);
	execFileSync(
		tsc,
		[
			join(here, "..", "auto-rename.ts"),
			"--outDir",
			tmpDir,
			"--module",
			"nodenext",
			"--target",
			"es2022",
			"--moduleResolution",
			"nodenext",
			"--skipLibCheck",
			"--strict",
		],
		{ cwd: root },
	);
	const mod = (await import(
		pathToFileURL(join(tmpDir, "auto-rename.js")).href
	)) as Mod;
	await runTests(mod);
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

async function runTests(mod: Mod): Promise<void> {
	const factory = mod.default;
	const ownsTerminalSurfaces = mod.ownsTerminalSurfaces;
	const ownsPiSessionName = mod.ownsPiSessionName;

	// ── 1. pure unit: mode matrix ───────────────────────────────────

	await check(
		"ownsTerminalSurfaces: tui owns surfaces with the default config",
		() => {
			const stub = makeStub();
			assert.equal(ownsTerminalSurfaces(makeCtx("tui", stub), makeCfg()), true);
		},
	);
	for (const mode of ["rpc", "json", "print"]) {
		await check(
			`ownsTerminalSurfaces: ${mode} does not own surfaces by default`,
			() => {
				const stub = makeStub();
				assert.equal(
					ownsTerminalSurfaces(makeCtx(mode, stub), makeCfg()),
					false,
				);
			},
		);
	}
	for (const mode of ["tui", "rpc", "json", "print"]) {
		await check(
			`ownsTerminalSurfaces: renameMultiplexersInNonTuiModes lets ${mode} own surfaces`,
			() => {
				const stub = makeStub();
				const cfg = makeCfg({
					surfaces: { renameMultiplexersInNonTuiModes: true },
				});
				assert.equal(ownsTerminalSurfaces(makeCtx(mode, stub), cfg), true);
			},
		);
	}

	// ── 1b. the session-name gate is independent of the surface gate ─

	await check(
		"ownsPiSessionName: tui owns its name with the default config",
		() => {
			const stub = makeStub();
			assert.equal(ownsPiSessionName(makeCtx("tui", stub), makeCfg()), true);
		},
	);
	for (const mode of ["rpc", "json", "print"]) {
		await check(
			`ownsPiSessionName: ${mode} does not own its name by default`,
			() => {
				const stub = makeStub();
				assert.equal(ownsPiSessionName(makeCtx(mode, stub), makeCfg()), false);
			},
		);
	}
	for (const mode of ["tui", "rpc", "json", "print"]) {
		await check(
			`ownsPiSessionName: renamePiSessionInNonTuiModes lets ${mode} own its name`,
			() => {
				const stub = makeStub();
				const cfg = makeCfg({
					surfaces: { renamePiSessionInNonTuiModes: true },
				});
				assert.equal(ownsPiSessionName(makeCtx(mode, stub), cfg), true);
				// The surface gate is untouched by the session-name gate.
				assert.equal(
					ownsTerminalSurfaces(makeCtx(mode, stub), cfg),
					mode === "tui",
				);
			},
		);
	}
	for (const mode of ["rpc", "json", "print"]) {
		await check(
			`ownsTerminalSurfaces: renameMultiplexersInNonTuiModes leaves ${mode} without its name`,
			() => {
				const stub = makeStub();
				const cfg = makeCfg({
					surfaces: { renameMultiplexersInNonTuiModes: true },
				});
				assert.equal(ownsTerminalSurfaces(makeCtx(mode, stub), cfg), true);
				assert.equal(ownsPiSessionName(makeCtx(mode, stub), cfg), false);
			},
		);
	}

	// ── 2. child session: session_start must not touch tmux ─────────

	await check(
		"session_start in print mode (child) issues no surface exec",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			stub.sessionName = "parent topic";
			const ctx = makeCtx("print", stub);
			await handler(stub, "session_start")({ reason: "startup" }, ctx);
			assert.equal(
				stub.calls.length,
				0,
				`expected no exec calls, got ${JSON.stringify(stub.calls)}`,
			);
		},
	);

	// ── 3. child session: input must not run the naming pipeline ────

	await check(
		"input in print mode (child) never reaches generateNames",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () => makeCfg({ initialRenameTrigger: "first-input" }),
			});
			const ctx = makeCtx("print", stub);
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			assert.equal(
				stub.calls.length,
				0,
				`expected no exec calls, got ${JSON.stringify(stub.calls)}`,
			);
			assert.equal(
				stub.modelReads,
				0,
				"ctx.model was read — prepareRename did not bail out before generateNames",
			);
		},
	);

	// ── 3b. child session with the session-name gate on: names itself, ───
	// never touches the parent's surfaces ─────────────────────────

	await check(
		"input in print mode with renamePiSessionInNonTuiModes runs the pipeline but never touches tmux",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () =>
					makeCfg({
						initialRenameTrigger: "first-input",
						surfaces: { renamePiSessionInNonTuiModes: true },
					}),
			});
			const ctx = makeCtx("print", stub);
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			assert.ok(
				stub.modelReads > 0,
				"ctx.model was not read — prepareRename bailed instead of running the naming pipeline",
			);
			assert.equal(
				tmuxRename(stub).length,
				0,
				`expected no tmux calls, got ${JSON.stringify(stub.calls)}`,
			);
		},
	);

	await check(
		"session_start in print mode with renameMultiplexersInNonTuiModes syncs tmux",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () =>
					makeCfg({
						surfaces: { renameMultiplexersInNonTuiModes: true },
					}),
			});
			stub.sessionName = "child topic";
			const ctx = makeCtx("print", stub);
			await handler(stub, "session_start")({ reason: "startup" }, ctx);
			assert.ok(
				tmuxRename(stub).some(
					(c) => c.args[0] === "rename-window" && c.args[2] === "%7",
				),
				`expected a tmux rename-window for %7, got ${JSON.stringify(stub.calls)}`,
			);
		},
	);

	// ── 4. regression: the main (tui) session still renames tmux ────

	await check(
		"session_start in tui mode still renames the tmux window",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			stub.sessionName = "parent topic";
			const ctx = makeCtx("tui", stub);
			await handler(stub, "session_start")({ reason: "startup" }, ctx);
			assert.ok(
				tmuxRename(stub).some(
					(c) =>
						c.args[0] === "rename-window" &&
						c.args[1] === "-t" &&
						c.args[2] === "%7" &&
						typeof c.args[3] === "string" &&
						c.args[3].length > 0,
				),
				`expected a tmux rename-window for %7, got ${JSON.stringify(stub.calls)}`,
			);
		},
	);

	// ── 5. child session: external rename must not sync surfaces ───

	await check(
		"session_info_changed in print mode (child) issues no surface exec",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			stub.sessionName = "parent topic";
			const ctx = makeCtx("print", stub);
			await handler(stub, "session_start")({ reason: "startup" }, ctx);
			stub.calls.length = 0;
			await handler(stub, "session_info_changed")(
				{ name: "external rename" },
				ctx,
			);
			assert.equal(
				stub.calls.length,
				0,
				`expected no exec calls, got ${JSON.stringify(stub.calls)}`,
			);
		},
	);
}
