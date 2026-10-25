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
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
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
		namingThinking: "off",
		// The schema defaults: both visibility surfaces are on. The checks that
		// exercise the off path (or want silence) pass false explicitly.
		showNamingGreeting: true,
		showNamingCost: true,
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
	/** Registered slash commands, keyed by name. */
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	/** Every `ctx.ui.notify` call, in order. */
	notifications: { message: string; type?: string }[];
	calls: { cmd: string; args: string[] }[];
	sessionName: string | undefined;
	/** How many times the naming pipeline read `ctx.model`. */
	modelReads: number;
	/** The live transcript: what `appendEntry` wrote, as `getEntries` reads it. */
	entries: unknown[];
	/** Registered entry renderers, keyed by custom entry type. */
	renderers: Map<string, (...a: unknown[]) => unknown>;
	/** Every `ctx.ui.setStatus` call, in order. */
	statuses: { key: string; text: string | undefined }[];
}

/** A stub ExtensionAPI that records event handlers and every exec call. */
function makeStub(): Stub {
	const stub: Stub = {
		pi: undefined as unknown as ExtensionAPI,
		handlers: new Map(),
		commands: new Map(),
		notifications: [],
		calls: [],
		sessionName: undefined,
		modelReads: 0,
		entries: [],
		renderers: new Map(),
		statuses: [],
	};
	stub.pi = {
		on: (ev: string, h: (...a: unknown[]) => unknown) => {
			stub.handlers.set(ev, [...(stub.handlers.get(ev) ?? []), h]);
		},
		registerCommand: (
			name: string,
			options: Omit<RegisteredCommand, "name" | "sourceInfo">,
		) => {
			stub.commands.set(name, options);
		},
		getSessionName: () => stub.sessionName,
		setSessionName: (n: string) => {
			stub.sessionName = n;
		},
		appendEntry: (customType: string, data?: unknown) => {
			stub.entries.push({ type: "custom", customType, data });
		},
		registerEntryRenderer: (
			customType: string,
			renderer: (...a: unknown[]) => unknown,
		) => {
			stub.renderers.set(customType, renderer);
		},
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
			getEntries: () => stub.entries,
			buildContextEntries: () => stub.entries,
			getSessionFile: () => undefined,
		},
		signal: undefined,
		isIdle: () => true,
		modelRegistry: undefined,
		ui: {
			notify: (message: string, type?: string) => {
				stub.notifications.push({ message, type });
			},
			setStatus: (key: string, text: string | undefined) => {
				stub.statuses.push({ key, text });
			},
		},
		get model() {
			stub.modelReads += 1;
			return undefined;
		},
	} as unknown as ExtensionContext;
}

/** A minimal fake ModelRegistry: just the `find`/`getAvailable` reads used. */
function makeRegistry(
	models: { provider: string; id: string; name?: string }[],
): ExtensionContext["modelRegistry"] {
	return {
		find: (provider: string, modelId: string) =>
			models.find((m) => m.provider === provider && m.id === modelId),
		getAvailable: () => models,
	} as unknown as ExtensionContext["modelRegistry"];
}

// ── fake naming backend ───────────────────────────────────────────────
//
// The handler tests drive the REAL naming pipeline (prompt, call, parse,
// ledger) without a network: the fake registry answers `complete` from a queue
// of canned AssistantMessages. The usage figures are pi-ai's vendored `Usage`
// shape (dist/types.d.ts) with the cost totals taken from the plan's worked
// example, not recomputed from anything here.

/** input, output, cacheRead, cacheWrite, and cost.total — the billed buckets. */
interface FakeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface FakeResponse {
	text?: string;
	stopReason?: string;
	usage?: FakeUsage;
	responseModel?: string;
}

/** Two billed runs: A is 1480 tokens / $0.001, B is 960 tokens / $0.0024. */
const USAGE_A: FakeUsage = {
	input: 1200,
	output: 80,
	cacheRead: 200,
	cacheWrite: 0,
	cost: 0.001,
};
const USAGE_B: FakeUsage = {
	input: 800,
	output: 40,
	cacheRead: 0,
	cacheWrite: 120,
	cost: 0.0024,
};

const GOOD_NAMES = "WINDOW: alpha beta\nSESSION: Alpha beta session";

/** An AssistantMessage as pi-ai produces it, with usage in its vendored shape. */
function assistantResponse(response: FakeResponse): unknown {
	const usage = response.usage ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	return {
		role: "assistant",
		content:
			response.text === undefined
				? []
				: [{ type: "text", text: response.text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "nano",
		...(response.responseModel
			? { responseModel: response.responseModel }
			: {}),
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens:
				usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: usage.cost,
			},
		},
		stopReason: response.stopReason ?? "stop",
		timestamp: 0,
	};
}

/**
 * A ctx that can actually run a rename: a session model and a registry whose
 * `complete` answers from the queued responses. `hasUI` stays false (the input
 * handler then awaits the pipeline instead of deferring it, so a check can
 * assert right after the handler resolves).
 *
 * `model` is the session's model, `available` the model the registry knows —
 * they differ when the test exercises a `namingModel` override.
 */
function makeRenameCtx(
	stub: Stub,
	options: {
		responses: FakeResponse[];
		mode?: string;
		model?: { provider: string; id: string };
		available?: { provider: string; id: string };
	},
): ExtensionContext {
	const queue = [...options.responses];
	const model = options.model ?? { provider: "openrouter", id: "nano" };
	const available = options.available ?? { provider: "openrouter", id: "nano" };
	const registry = {
		find: (provider: string, id: string) =>
			provider === available.provider && id === available.id
				? available
				: undefined,
		getAvailable: () => [available],
		complete: async () => {
			const next = queue.shift();
			assert.ok(
				next,
				"the naming pipeline called the model more often than the test queued responses",
			);
			return assistantResponse(next);
		},
	};
	const base = makeCtx(options.mode ?? "tui", stub) as unknown as Record<
		string,
		unknown
	>;
	return {
		...base,
		model,
		modelRegistry: registry,
	} as unknown as ExtensionContext;
}

/** A transcript entry of one custom type, as a previous session left it. */
function usageEntry(usage: FakeUsage): unknown {
	return {
		type: "custom",
		customType: "pi-auto-name:usage",
		data: {
			at: "2026-02-01T00:00:00.000Z",
			provider: "openrouter",
			model: "nano",
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
		},
	};
}

/** A user message entry, so a settled-turn rename has a naming context. */
function userMessageEntry(text: string): unknown {
	return {
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

/** The greeting expectation both the handler test and the renderer test use. */
const GREETING_TYPE = "pi-auto-name:greeting";
const USAGE_TYPE = "pi-auto-name:usage";
const STATUS_KEY = "auto-rename";

/** Custom entries of one type in the live transcript. */
function entriesOfType(
	stub: Stub,
	customType: string,
): { customType: string; data?: unknown }[] {
	return stub.entries.filter(
		(entry) => (entry as { customType?: string }).customType === customType,
	) as { customType: string; data?: unknown }[];
}

/**
 * Command-capable ctx: a real model registry plus a notify sink, with the same
 * tmux/mode surface wiring as makeCtx.
 */
function makeCommandCtx(
	stub: Stub,
	registry: ExtensionContext["modelRegistry"],
	model?: { provider: string; id: string },
): ExtensionCommandContext {
	const base = makeCtx("tui", stub) as unknown as Record<string, unknown>;
	return {
		...base,
		modelRegistry: registry,
		model,
	} as unknown as ExtensionCommandContext;
}

/** The registered command, failing loudly when absent. */
function command(
	stub: Stub,
	name: string,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
	const cmd = stub.commands.get(name);
	assert.ok(cmd, `no command registered for ${name}`);
	return cmd;
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

	// ── 1. child session: session_start must not touch tmux ─────────

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

	// ── 2. child session: input must not run the naming pipeline ────

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

	// ── 2b. child session with the session-name gate on: names itself, ───
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

	// ── 3. regression: the main (tui) session still renames tmux ────

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

	// ── 4. child session: external rename must not sync surfaces ───

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

	// ── 5. config location: pi settings `autoRename` namespace ──────
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
			assert.equal(cfg.namingThinking, "off");
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

	await check(
		"config location: writeGlobalNamingModel preserves other settings",
		async () => {
			const io = (await import(ioUrl)) as typeof import("../io.ts");
			const paths = settingsPaths("auto-rename-write-");
			writeJson(paths.globalSettingsPath, {
				unrelated: 1,
				autoRename: {
					namingStyle: "slug",
					surfaces: { renameTmuxWindow: false },
				},
			});
			assert.equal(
				io.writeGlobalNamingModel("openrouter/fast", paths.globalSettingsPath),
				true,
			);
			const written = JSON.parse(
				readFileSync(paths.globalSettingsPath, "utf8"),
			) as {
				unrelated: number;
				autoRename: {
					namingModel: string;
					namingStyle: string;
					surfaces: Record<string, boolean>;
				};
			};
			assert.equal(written.unrelated, 1);
			assert.equal(written.autoRename.namingModel, "openrouter/fast");
			assert.equal(written.autoRename.namingStyle, "slug");
			assert.deepEqual(written.autoRename.surfaces, {
				renameTmuxWindow: false,
			});

			// An empty string is the documented "follow the session model" value.
			assert.equal(
				io.writeGlobalNamingModel("", paths.globalSettingsPath),
				true,
			);
			assert.equal(
				(
					JSON.parse(readFileSync(paths.globalSettingsPath, "utf8")) as {
						autoRename: { namingModel: string };
					}
				).autoRename.namingModel,
				"",
			);
		},
	);

	// ── 6. /auto-rename model command ───────────────────────────────

	await check("command: /auto-rename offers a `model` subcommand", async () => {
		const stub = makeStub();
		factory(stub.pi, { loadConfig: () => makeCfg() });
		const cmd = command(stub, "auto-rename");
		assert.equal(typeof cmd.handler, "function", "missing handler");
		const completions = (await cmd.getArgumentCompletions?.("")) ?? [];
		assert.ok(
			completions.some((c) => c.value === "model"),
			`expected a \`model\` completion, got ${JSON.stringify(completions)}`,
		);
	});

	await check(
		"command: no args reports the configured and effective model",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () => makeCfg({ namingModel: "openrouter/m" }),
			});
			const registry = makeRegistry([
				{ provider: "openrouter", id: "m", name: "M" },
			]);
			const ctx = makeCommandCtx(stub, registry, {
				provider: "openrouter",
				id: "m",
			});
			await command(stub, "auto-rename").handler("", ctx);
			assert.equal(stub.notifications.length, 1);
			assert.equal(stub.notifications[0].type, "info");
			assert.match(stub.notifications[0].message, /openrouter\/m/);
		},
	);

	await check(
		"command: model set persists the override and applies it",
		async () => {
			const stub = makeStub();
			let stored = "";
			factory(stub.pi, {
				loadConfig: () => makeCfg({ namingModel: stored }),
				writeNamingModel: (m) => {
					stored = m;
					return true;
				},
			});
			const registry = makeRegistry([
				{ provider: "openrouter", id: "fast", name: "Fast" },
			]);
			const ctx = makeCommandCtx(stub, registry, {
				provider: "openrouter",
				id: "fast",
			});
			await command(stub, "auto-rename").handler("model openrouter/fast", ctx);
			assert.equal(stored, "openrouter/fast");
			assert.equal(stub.notifications.at(-1)?.type, "info");
			assert.match(
				stub.notifications.at(-1)?.message ?? "",
				/openrouter\/fast/,
			);
		},
	);

	await check(
		"command: unknown model is rejected without writing",
		async () => {
			const stub = makeStub();
			let writes = 0;
			factory(stub.pi, {
				loadConfig: () => makeCfg(),
				writeNamingModel: () => {
					writes++;
					return true;
				},
			});
			const ctx = makeCommandCtx(stub, makeRegistry([]), undefined);
			await command(stub, "auto-rename").handler("model nope/nope", ctx);
			assert.equal(writes, 0);
			assert.equal(stub.notifications.at(-1)?.type, "warning");
		},
	);

	await check("command: `default` clears the override", async () => {
		const stub = makeStub();
		let stored = "openrouter/fast";
		factory(stub.pi, {
			loadConfig: () => makeCfg({ namingModel: stored }),
			writeNamingModel: (m) => {
				stored = m;
				return true;
			},
		});
		const ctx = makeCommandCtx(stub, makeRegistry([]), undefined);
		await command(stub, "auto-rename").handler("model default", ctx);
		assert.equal(stored, "");
		assert.equal(stub.notifications.at(-1)?.type, "info");
		assert.match(stub.notifications.at(-1)?.message ?? "", /default/);
	});

	await check(
		"command: a project-level override still shadowing is reported",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				// Mirrors a project file: the reload never reflects the global write.
				loadConfig: () => makeCfg({ namingModel: "project/model" }),
				writeNamingModel: () => true,
			});
			const registry = makeRegistry([
				{ provider: "openrouter", id: "fast", name: "Fast" },
			]);
			const ctx = makeCommandCtx(stub, registry, {
				provider: "openrouter",
				id: "fast",
			});
			await command(stub, "auto-rename").handler("model openrouter/fast", ctx);
			assert.equal(stub.notifications.at(-1)?.type, "warning");
			assert.match(stub.notifications.at(-1)?.message ?? "", /project/i);
		},
	);

	await check(
		"command: completions list `default` plus the session's available models",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			const registry = makeRegistry([
				{ provider: "openrouter", id: "fast", name: "Fast" },
				{ provider: "anthropic", id: "claude", name: "Claude" },
			]);
			// session_start populates the registry handle used by completions.
			await handler(stub, "session_start")(
				{ reason: "startup" },
				makeCommandCtx(stub, registry),
			);
			const items =
				(await command(stub, "auto-rename").getArgumentCompletions?.(
					"model ",
				)) ?? [];
			assert.ok(items.some((i) => i.value === "default"));
			assert.ok(items.some((i) => i.value === "openrouter/fast"));
			assert.ok(items.some((i) => i.value === "anthropic/claude"));
		},
	);

	await check("command: an unknown subcommand is rejected", async () => {
		const stub = makeStub();
		factory(stub.pi, { loadConfig: () => makeCfg() });
		const ctx = makeCommandCtx(stub, makeRegistry([]), undefined);
		await command(stub, "auto-rename").handler("thinking high", ctx);
		assert.equal(stub.notifications.at(-1)?.type, "warning");
	});

	// ── 7. the two visibility config keys ───────────────────────────

	await check("config: the visibility flags default to true", async () => {
		const { loadConfig } = (await import(
			configUrl
		)) as typeof import("../config.ts");
		const paths = settingsPaths("auto-rename-visibility-defaults-");
		const cfg = await loadConfig(fakeCtx(tmpdir(), true), paths);
		assert.equal(cfg.showNamingGreeting, true);
		assert.equal(cfg.showNamingCost, true);
	});

	await check(
		"config: project settings can turn a visibility flag off, untouched global keys survive",
		async () => {
			const { loadConfig } = (await import(
				configUrl
			)) as typeof import("../config.ts");
			const paths = settingsPaths("auto-rename-visibility-merge-");
			writeJson(paths.globalSettingsPath, {
				autoRename: { showNamingGreeting: false },
			});
			writeJson(paths.projectSettingsPath, {
				autoRename: { showNamingCost: false },
			});
			const cfg = await loadConfig(fakeCtx(tmpdir(), true), paths);
			assert.equal(cfg.showNamingCost, false);
			assert.equal(cfg.showNamingGreeting, false);
		},
	);

	// ── 8. the startup greeting entry ───────────────────────────────

	await check(
		"greeting: appended once on a fresh tui session, not again on resume",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () =>
					makeCfg({ showNamingGreeting: true, namingThinking: "low" }),
			});
			const ctx = makeRenameCtx(stub, { responses: [] });
			await handler(stub, "session_start")({ reason: "startup" }, ctx);
			const greetings = entriesOfType(stub, GREETING_TYPE);
			assert.equal(
				greetings.length,
				1,
				`expected one greeting entry, got ${JSON.stringify(stub.entries)}`,
			);
			const data = greetings[0].data as {
				model: string;
				effort: string;
				override: boolean;
				at: string;
			};
			assert.equal(data.model, "openrouter/nano");
			assert.equal(data.effort, "low");
			assert.equal(data.override, false);
			assert.equal(typeof data.at, "string");
			assert.ok(
				stub.renderers.has(GREETING_TYPE),
				"the greeting entry renderer was not registered on the api instance",
			);

			// Resume: the transcript already carries the greeting.
			await handler(stub, "session_start")({ reason: "resume" }, ctx);
			assert.equal(entriesOfType(stub, GREETING_TYPE).length, 1);
		},
	);

	await check(
		"greeting: a resumed session renders its replayed greeting without writing another",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () => makeCfg({ showNamingGreeting: true }),
			});
			stub.entries.push({
				type: "custom",
				customType: GREETING_TYPE,
				data: {
					at: "2026-02-01T00:00:00.000Z",
					model: "openrouter/nano",
					effort: "off",
					override: false,
				},
			});
			await handler(stub, "session_start")(
				{ reason: "resume" },
				makeRenameCtx(stub, { responses: [] }),
			);
			assert.equal(entriesOfType(stub, GREETING_TYPE).length, 1);
			assert.ok(
				stub.renderers.has(GREETING_TYPE),
				"the replayed greeting entry has no renderer",
			);
		},
	);

	await check(
		"greeting: names the namingModel override, not the session model",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () =>
					makeCfg({
						showNamingGreeting: true,
						namingModel: "openrouter/fast",
						namingThinking: "max",
					}),
			});
			const ctx = makeRenameCtx(stub, {
				responses: [],
				model: { provider: "anthropic", id: "claude" },
				available: { provider: "openrouter", id: "fast" },
			});
			await handler(stub, "session_start")({ reason: "startup" }, ctx);
			const data = entriesOfType(stub, GREETING_TYPE)[0]?.data as {
				model: string;
				override: boolean;
			};
			assert.equal(data.model, "openrouter/fast");
			assert.equal(data.override, true);
		},
	);

	await check("greeting: not appended when the flag is off", async () => {
		const stub = makeStub();
		factory(stub.pi, {
			loadConfig: () => makeCfg({ showNamingGreeting: false }),
		});
		await handler(stub, "session_start")(
			{ reason: "startup" },
			makeRenameCtx(stub, { responses: [] }),
		);
		assert.deepEqual(entriesOfType(stub, GREETING_TYPE), []);
	});

	await check("greeting: not appended in non-tui mode", async () => {
		const stub = makeStub();
		factory(stub.pi, {
			loadConfig: () => makeCfg({ showNamingGreeting: true }),
		});
		await handler(stub, "session_start")(
			{ reason: "startup" },
			makeRenameCtx(stub, { responses: [], mode: "print" }),
		);
		assert.deepEqual(entriesOfType(stub, GREETING_TYPE), []);
	});

	await check(
		"greeting: the renderer prints model and effort verbatim, `off` stays `off`",
		async () => {
			const { renderGreetingEntry } = (await import(
				pathToFileURL(join(tmpDir, "greeting.js")).href
			)) as typeof import("../greeting.ts");
			const theme = {
				fg: (_color: string, text: string) => text,
			} as unknown as Parameters<typeof renderGreetingEntry>[2];
			const render = (data: unknown): string => {
				const component = renderGreetingEntry(
					{
						type: "custom",
						customType: GREETING_TYPE,
						data,
					} as never,
					{} as never,
					theme,
				);
				return (component?.render(200) ?? [])
					.map((line) => line.trim())
					.filter(Boolean)
					.join("\n");
			};
			assert.equal(
				render({
					at: "2026-02-01T00:00:00.000Z",
					model: "openrouter/nano",
					effort: "off",
					override: false,
				}),
				"[pi-auto-rename] naming: openrouter/nano • effort: off",
			);
			assert.equal(
				render({
					at: "2026-02-01T00:00:00.000Z",
					model: "openrouter/fast",
					effort: "xhigh",
					override: true,
				}),
				"[pi-auto-rename] naming: openrouter/fast • effort: xhigh (override)",
			);
		},
	);

	// ── 9. usage threading through the naming pipeline ──────────────

	await check(
		"usage: a billed rename records the response's usage in the ledger",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			const ctx = makeRenameCtx(stub, {
				responses: [
					{ text: GOOD_NAMES, usage: USAGE_A, responseModel: "nano-v2" },
				],
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			const ledger = entriesOfType(stub, USAGE_TYPE);
			assert.equal(ledger.length, 1);
			const data = ledger[0].data as Record<string, unknown>;
			assert.equal(data.provider, "openrouter");
			assert.equal(data.model, "nano");
			assert.equal(data.responseModel, "nano-v2");
			assert.equal(data.input, 1200);
			assert.equal(data.output, 80);
			assert.equal(data.cacheRead, 200);
			assert.equal(data.cacheWrite, 0);
			assert.equal(data.cost, 0.001);
			assert.equal(typeof data.at, "string");
		},
	);

	await check(
		"usage: a billed retry is overwritten by the attempt that succeeds (one ledger entry)",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			const ctx = makeRenameCtx(stub, {
				responses: [
					{ stopReason: "error", usage: USAGE_A },
					{ text: GOOD_NAMES, usage: USAGE_B },
				],
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			const ledger = entriesOfType(stub, USAGE_TYPE);
			assert.equal(ledger.length, 1);
			const data = ledger[0].data as Record<string, unknown>;
			assert.equal(data.input, 800);
			assert.equal(data.output, 40);
			assert.equal(data.cacheRead, 0);
			assert.equal(data.cacheWrite, 120);
			assert.equal(data.cost, 0.0024);
		},
	);

	await check(
		"usage: a billed non-stop retry supplies the usage when the final attempt reports none",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			const ctx = makeRenameCtx(stub, {
				responses: [
					{ stopReason: "length", usage: USAGE_A },
					{ text: GOOD_NAMES }, // usable answer, all-zero usage
				],
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			const ledger = entriesOfType(stub, USAGE_TYPE);
			assert.equal(ledger.length, 1);
			assert.equal((ledger[0].data as { cost: number }).cost, 0.001);
		},
	);

	await check(
		"usage: a billed attempt that ends in the last-message fallback still records its spend",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg() });
			const ctx = makeRenameCtx(stub, {
				responses: [
					{ text: "no labels here", usage: USAGE_A },
					{ text: "no labels here", usage: USAGE_A },
					{ text: "no labels here", usage: USAGE_A },
				],
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			// The names came from the local fallback, but the calls were billed.
			assert.equal(stub.sessionName, "hello world");
			const ledger = entriesOfType(stub, USAGE_TYPE);
			assert.equal(ledger.length, 1);
			assert.equal((ledger[0].data as { cost: number }).cost, 0.001);
		},
	);

	await check(
		"usage: an all-zero usage object creates no ledger entry",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg({ showNamingCost: true }) });
			// pi-ai reports all-zero usage for some failures; nothing was billed.
			const ctx = makeRenameCtx(stub, { responses: [{ text: GOOD_NAMES }] });
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			assert.equal(entriesOfType(stub, USAGE_TYPE).length, 0);
			assert.deepEqual(stub.statuses, []);
		},
	);

	await check(
		"usage: a surfaces-only run (no session rename) still records its spend",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () =>
					makeCfg({
						showNamingCost: true,
						surfaces: { renamePiSession: false, renameTmuxWindow: true },
					}),
			});
			const ctx = makeRenameCtx(stub, {
				responses: [{ text: GOOD_NAMES, usage: USAGE_A }],
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			// No pi session rename…
			assert.equal(stub.sessionName, undefined);
			// …but the naming call was billed, and only applySessionName skips.
			assert.equal(entriesOfType(stub, USAGE_TYPE).length, 1);
			assert.deepEqual(stub.statuses.at(-1), {
				key: STATUS_KEY,
				text: "naming $0.0010",
			});
		},
	);

	await check("usage: an aborted run records nothing", async () => {
		const stub = makeStub();
		factory(stub.pi, { loadConfig: () => makeCfg({ showNamingCost: true }) });
		const ctx = makeRenameCtx(stub, {
			responses: [{ stopReason: "aborted", usage: USAGE_A }],
		});
		await handler(stub, "input")({ source: "user", text: "hello world" }, ctx);
		assert.deepEqual(entriesOfType(stub, USAGE_TYPE), []);
		assert.deepEqual(stub.statuses, []);
		assert.equal(stub.sessionName, undefined);
	});

	// ── 10. the footer cost status ──────────────────────────────────

	await check(
		"status: two billed renames sum into the footer status",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () =>
					makeCfg({
						showNamingCost: true,
						initialRenameTrigger: "first-agent-settled",
						reRenameEveryNTurns: 1,
					}),
			});
			stub.entries.push(userMessageEntry("hello world"));
			const ctx = makeRenameCtx(stub, {
				responses: [
					{ text: GOOD_NAMES, usage: USAGE_A },
					{ text: GOOD_NAMES, usage: USAGE_B },
				],
			});
			const settled = handler(stub, "agent_settled");
			await settled({}, ctx); // turn 1 → initial rename
			assert.deepEqual(stub.statuses.at(-1), {
				key: STATUS_KEY,
				text: "naming $0.0010",
			});
			await settled({}, ctx); // turn 2 → interval re-rename
			assert.deepEqual(stub.statuses.at(-1), {
				key: STATUS_KEY,
				text: "naming $0.0034",
			});
			assert.equal(entriesOfType(stub, USAGE_TYPE).length, 2);
		},
	);

	await check("status: the sub-cent floor avoids reading as free", async () => {
		const { formatNamingCost } = (await import(
			pathToFileURL(join(tmpDir, "auto-rename.js")).href
		)) as typeof import("../auto-rename.ts");
		// The plan's display rule: 4 decimals, and `<$0.0001` below the last bucket.
		assert.equal(formatNamingCost(0.00004), "naming <$0.0001");
		assert.equal(formatNamingCost(0.00006), "naming $0.0001");
		assert.equal(formatNamingCost(0.001084), "naming $0.0011");
		assert.equal(formatNamingCost(0.0034), "naming $0.0034");
		// Nothing is shown for zero (a subscription-covered or unpriced model).
		assert.equal(formatNamingCost(0), undefined);
	});

	await check(
		"status: nothing is published before a cost is incurred",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg({ showNamingCost: true }) });
			await handler(stub, "session_start")(
				{ reason: "startup" },
				makeRenameCtx(stub, { responses: [] }),
			);
			assert.deepEqual(stub.statuses, []);
		},
	);

	await check(
		"status: tokens with a zero cost show no figure (no token fallback)",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg({ showNamingCost: true }) });
			const ctx = makeRenameCtx(stub, {
				responses: [
					{
						text: GOOD_NAMES,
						usage: {
							input: 1200,
							output: 80,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
						},
					},
				],
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			// The spend is real and recorded; it is just unpriced.
			assert.equal(entriesOfType(stub, USAGE_TYPE).length, 1);
			assert.ok(
				stub.statuses.every((s) => s.text === undefined),
				`expected no figure, got ${JSON.stringify(stub.statuses)}`,
			);
		},
	);

	await check(
		"status: a billed rename in non-tui mode publishes nothing",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () =>
					makeCfg({
						showNamingCost: true,
						surfaces: { renamePiSessionInNonTuiModes: true },
					}),
			});
			const ctx = makeRenameCtx(stub, {
				responses: [{ text: GOOD_NAMES, usage: USAGE_A }],
				mode: "print",
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			assert.equal(entriesOfType(stub, USAGE_TYPE).length, 1);
			assert.deepEqual(stub.statuses, []);
		},
	);

	await check(
		"status: the slot is cleared when showNamingCost is off",
		async () => {
			const stub = makeStub();
			factory(stub.pi, {
				loadConfig: () => makeCfg({ showNamingCost: false }),
			});
			const ctx = makeRenameCtx(stub, {
				responses: [{ text: GOOD_NAMES, usage: USAGE_A }],
			});
			await handler(stub, "input")(
				{ source: "user", text: "hello world" },
				ctx,
			);
			assert.deepEqual(stub.statuses, [{ key: STATUS_KEY, text: undefined }]);
		},
	);

	await check(
		"status: a restored ledger is re-published on session_start",
		async () => {
			const stub = makeStub();
			factory(stub.pi, { loadConfig: () => makeCfg({ showNamingCost: true }) });
			// What a previous session left in the transcript (e.g. before a reload).
			stub.entries.push(usageEntry(USAGE_A), usageEntry(USAGE_B));
			await handler(stub, "session_start")(
				{ reason: "resume" },
				makeRenameCtx(stub, { responses: [] }),
			);
			assert.deepEqual(stub.statuses, [
				{ key: STATUS_KEY, text: "naming $0.0034" },
			]);
		},
	);

	// ── 11. the transcript scan that restores the ledger ─────────────

	await check(
		"ledger: the transcript scan recovers calls, tokens, cost and the greeting marker",
		async () => {
			const { createState, restoreTranscriptState } = (await import(
				pathToFileURL(join(tmpDir, "state.js")).href
			)) as typeof import("../state.ts");
			const entries = [
				usageEntry(USAGE_A),
				usageEntry(USAGE_B),
				{
					type: "custom",
					customType: GREETING_TYPE,
					data: {
						at: "2026-02-01T00:00:00.000Z",
						model: "openrouter/nano",
						effort: "off",
						override: false,
					},
				},
				userMessageEntry("hi"),
			];
			const state = createState();
			const restored = restoreTranscriptState(
				{ sessionManager: { getEntries: () => entries } } as never,
				state,
			);
			assert.equal(state.namingCalls, 2);
			// 1200+80+200+0 then 800+40+0+120
			assert.equal(state.namingTokens, 2440);
			assert.equal(state.namingCost.toFixed(4), "0.0034");
			assert.equal(restored.hasGreeting, true);
		},
	);

	await check(
		"ledger: a session recorded before the ledger restores zero spend",
		async () => {
			const { createState, restoreTranscriptState } = (await import(
				pathToFileURL(join(tmpDir, "state.js")).href
			)) as typeof import("../state.ts");
			const entries = [
				{
					type: "custom",
					customType: "pi-auto-name",
					data: { sessionName: "old name", at: "2026-01-01T00:00:00.000Z" },
				},
				userMessageEntry("hi"),
			];
			const state = createState();
			const restored = restoreTranscriptState(
				{ sessionManager: { getEntries: () => entries } } as never,
				state,
			);
			assert.equal(state.namingCalls, 0);
			assert.equal(state.namingTokens, 0);
			assert.equal(state.namingCost, 0);
			assert.equal(state.lastAutoName, "old name");
			assert.equal(restored.hasGreeting, false);
		},
	);
}
