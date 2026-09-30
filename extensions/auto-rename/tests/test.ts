// Test suite for auto-rename's subagent-surface gating, run against the REAL
// extension module. Node cannot strip this extension's TypeScript directly
// (its internal imports use `.js` specifiers and config.ts imports a Node
// module that is itself TypeScript), so — like sticky-last-prompt's suite —
// this file compiles the extension with the repo's tsc into a temp dir INSIDE
// the repo (so bare `@earendil-works/*` imports resolve against the workspace
// node_modules) and imports the emitted JS.
//
// The handler tests inject config loading through the `AutoRenameDeps` test
// seam. The config-location tests at the end instead import the emitted
// `io.js` and `config.js` directly (inside `check`, so a RED-state missing
// `io.js` is a per-check FAIL rather than a crash of the whole suite).
//
// Run: node extensions/auto-rename/tests/test.ts
//  or: npm test -w @tangentyh/pi-auto-rename

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutoRenameDeps } from "../auto-rename.ts";
import type { Config } from "../config.ts";
import type { AutoRenamePaths } from "../io.ts";

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

	// ── 6. config location: pi settings `autoRename` namespace ──────
	// Exercises the target `io.ts` / `config.ts` API. In the RED state `io.js`
	// does not exist yet (and `config.loadConfig` still takes a cwd string), so
	// every check below is expected to fail.

	const ioUrl = pathToFileURL(join(tmpDir, "io.js")).href;
	const configUrl = pathToFileURL(join(tmpDir, "config.js")).href;

	function fakeCtx(cwd: string, trusted: boolean): ExtensionContext {
		return {
			cwd,
			isProjectTrusted: () => trusted,
			hasUI: false,
		} as unknown as ExtensionContext;
	}

	/** Fresh temp dir; both config paths live inside it (never the real agent dir). */
	function settingsPaths(prefix: string): Required<AutoRenamePaths> {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		return {
			globalSettingsPath: join(dir, "settings.json"),
			projectSettingsPath: join(dir, "project-settings.json"),
		};
	}

	function writeJson(file: string, value: unknown): void {
		writeFileSync(file, JSON.stringify(value));
	}

	await check(
		"config location: only the autoRename namespace is read",
		async () => {
			const io = (await import(ioUrl)) as typeof import("../io.ts");
			const paths = settingsPaths("auto-rename-ns-");
			writeJson(paths.globalSettingsPath, {
				unrelated: 1,
				autoRename: { namingStyle: "slug" },
			});
			const resolved = io.resolveAutoRenameConfiguration(
				fakeCtx(tmpdir(), true),
				paths,
			);
			assert.deepEqual(resolved.raw, { namingStyle: "slug" });
		},
	);

	await check(
		"config location: global autoRename merges project over global",
		async () => {
			const io = (await import(ioUrl)) as typeof import("../io.ts");
			const paths = settingsPaths("auto-rename-merge-");
			writeJson(paths.globalSettingsPath, {
				autoRename: {
					namingStyle: "slug",
					namingModel: "a",
					surfaces: { renameTmuxWindow: false, renameHerdrPane: true },
				},
			});
			writeJson(paths.projectSettingsPath, {
				autoRename: {
					namingModel: "b",
					surfaces: { renameHerdrPane: false },
				},
			});
			const resolved = io.resolveAutoRenameConfiguration(
				fakeCtx(tmpdir(), true),
				paths,
			);
			assert.deepEqual(resolved.raw?.surfaces, {
				renameTmuxWindow: false,
				renameHerdrPane: false,
			});
			assert.equal(resolved.raw?.namingStyle, "slug");
			assert.equal(resolved.raw?.namingModel, "b");
		},
	);

	await check(
		"config location: untrusted project autoRename is ignored",
		async () => {
			const io = (await import(ioUrl)) as typeof import("../io.ts");
			const paths = settingsPaths("auto-rename-untrusted-");
			writeJson(paths.globalSettingsPath, {
				autoRename: { namingStyle: "natural" },
			});
			writeJson(paths.projectSettingsPath, {
				autoRename: { namingStyle: "slug" },
			});
			const resolved = io.resolveAutoRenameConfiguration(
				fakeCtx(tmpdir(), false),
				paths,
			);
			assert.equal(resolved.raw?.namingStyle, "natural");
		},
	);

	await check(
		"config location: missing settings fall back to schema defaults",
		async () => {
			const { loadConfig } = (await import(
				configUrl
			)) as typeof import("../config.ts");
			const paths = settingsPaths("auto-rename-missing-");
			const cfg = await loadConfig(fakeCtx(tmpdir(), true), paths);
			assert.equal(cfg.enabled, true);
			assert.equal(cfg.language, "en");
			assert.equal(cfg.namingStyle, "natural");
			assert.equal(cfg.surfaces.renameTmuxWindow, true);
		},
	);

	await check(
		"config location: malformed settings JSON falls back to defaults",
		async () => {
			const { loadConfig } = (await import(
				configUrl
			)) as typeof import("../config.ts");
			const paths = settingsPaths("auto-rename-malformed-");
			writeFileSync(paths.globalSettingsPath, "{ not json");
			const cfg = await loadConfig(fakeCtx(tmpdir(), true), paths);
			assert.equal(cfg.enabled, true);
			assert.equal(cfg.language, "en");
			assert.equal(cfg.namingStyle, "natural");
			assert.equal(cfg.surfaces.renameTmuxWindow, true);
		},
	);

	await check(
		"config location: schema defaults fill gaps after a partial override",
		async () => {
			const { loadConfig } = (await import(
				configUrl
			)) as typeof import("../config.ts");
			const paths = settingsPaths("auto-rename-partial-");
			writeJson(paths.globalSettingsPath, {
				autoRename: { surfaces: { renameTmuxWindow: false } },
			});
			const cfg = await loadConfig(fakeCtx(tmpdir(), true), paths);
			assert.equal(cfg.surfaces.renameTmuxWindow, false);
			assert.equal(cfg.surfaces.renameHerdrPane, true);
			assert.equal(cfg.enabled, true);
		},
	);
}
