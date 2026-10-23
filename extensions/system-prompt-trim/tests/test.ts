// Test suite for system-prompt-trim. Every expectation is pasted from outside
// extension:
//   - PI_DOCS_SECTION is the `docs` section pi 1.3.0 renders
//     (packages/coding-agent/src/core/system-prompt.ts).
//   - PIBOLT_LINE is the caveat Pi-Bolt appends to that section (its compiled
//     `promptSections.docs`). It is the regression this suite exists for: an
//     earlier version rebuilt the section from a template and dropped it.
//
// Node ≥ 23.6 strips this file's (erasable-only) TypeScript natively, so the
// extension module next to it is imported directly.
//
// Run: node extensions/system-prompt-trim/tests/test.ts
//  or: npm test -w pi-system-prompt-trim

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatSkillsForPrompt,
	getAgentDir,
	loadSkills,
} from "@earendil-works/pi-coding-agent";
import {
	advertisesSkill,
	BLANK_SECTION,
	buildDocsSection,
	buildSkillFile,
	type DocsSkillDeps,
	defaultSkillDir,
	extractDocsPaths,
	extractDocsSection,
	installId,
	registerDocsSkill,
	SKILL_DESCRIPTION,
	SKILL_NAME,
	splitDocsSection,
} from "../system-prompt-trim.ts";

// ── tiny labelled-check harness ───────────────────────────────────────
const failures: string[] = [];
function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
		console.log(`  FAIL ${name}`);
	}
}

// ── pasted truth: pi 1.3.0's rendered `docs` section ──────────────────
const PI_DOCS_SECTION = `<docs>
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/pi/README.md
- Additional docs: /opt/pi/docs
- Examples: /opt/pi/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
</docs>`;

/** pi's routing sentence: the one line of the section not transcribed. */
const ROUTING =
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";

// ── pasted truth: Pi-Bolt's appended line, verbatim from its prompt ────
const PIBOLT_LINE =
	"- This is Pi-Bolt: its command is `pi-bolt`, and it is updated with `pi-bolt update` (https://github.com/opensec-git/Pi-Bolt). The install and update commands in pi's README install pi itself, not Pi-Bolt: do not suggest them.";

const PIBOLT_SECTION = PI_DOCS_SECTION.replace(
	"\n</docs>",
	`\n${PIBOLT_LINE}\n</docs>`,
);

function promptWith(
	section: string,
	tail = "<cwd>\n/tmp/project\n</cwd>",
): string {
	return [
		"You are an expert coding assistant operating inside pi.",
		"<tools>\n- read: Read file contents\n</tools>",
		section,
		tail,
	].join("\n\n");
}

const PROMPT = promptWith(PI_DOCS_SECTION);
const PIBOLT_PROMPT = promptWith(PIBOLT_SECTION);

const PI_TEXT = extractDocsSection(PROMPT) as string;
const PIBOLT_TEXT = extractDocsSection(PIBOLT_PROMPT) as string;

// ── fakes ─────────────────────────────────────────────────────────────

function freshOptions(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { sections: {}, skills: [], selectedTools: ["read"], ...extra };
}

function memoryFs() {
	const files = new Map<string, string>();
	const writes: string[] = [];
	const deps: DocsSkillDeps = {
		skillDir: () => "/mem/pi-system-prompt-trim/abc123",
		readFile: (filePath) => files.get(filePath),
		writeFile: (filePath, content) => {
			files.set(filePath, content);
			writes.push(filePath);
		},
	};
	return { files, writes, deps };
}

/**
 * Render the prompt from the handler's mutable options, the way pi re-renders
 * it on every `event.systemPrompt` read: the section map is merged over the
 * built-in sections, and the skills section is rendered with pi's own renderer
 * — which leaves out `disable-model-invocation` skills and returns nothing when
 * none are left. Verified against pi 1.3.0 and Pi-Bolt 1.4.0.
 */
function renderedPrompt(
	base: string,
	options: Record<string, unknown>,
): string {
	let prompt = base;
	const sections = (options.sections ?? {}) as Record<string, string | null>;
	const docs = sections.docs;
	if (typeof docs === "string" && docs.length > 0) {
		prompt = prompt.replace(
			/<docs>\n[\s\S]*?\n<\/docs>/,
			`<docs>\n${docs}\n</docs>`,
		);
	}
	const skills = options.skills;
	if (Array.isArray(skills) && skills.length > 0) {
		const section = formatSkillsForPrompt(
			skills as Parameters<typeof formatSkillsForPrompt>[0],
		).trim();
		if (section) {
			prompt = prompt.replace(
				"\n<cwd>",
				`\n<skills>\n${section}\n</skills>\n\n<cwd>`,
			);
		}
	}
	return prompt;
}

/**
 * Dispatches `before_agent_start` the way pi's runner does: handlers see one
 * mutable options object, and `event.systemPrompt` re-renders from it.
 */
function runHandler({
	deps = memoryFs().deps,
	options = freshOptions(),
	systemPrompt = PROMPT,
}: {
	deps?: DocsSkillDeps;
	options?: Record<string, unknown>;
	systemPrompt?: string;
} = {}): Record<string, unknown> {
	const handlers: Array<
		(event: { systemPrompt: string; systemPromptOptions: unknown }) => unknown
	> = [];
	const pi = {
		on(_event: string, handler: (event: never) => unknown) {
			handlers.push(handler as never);
		},
	} as unknown as ExtensionAPI;
	registerDocsSkill(pi, deps);

	const event = {
		type: "before_agent_start",
		messageType: "user",
		prompt: "how do pi extensions register a tool?",
		get systemPrompt() {
			return renderedPrompt(systemPrompt, options);
		},
		systemPromptOptions: options,
	};
	for (const handler of handlers) handler(event);
	return options;
}

// ── path extraction ───────────────────────────────────────────────────

check("reads the three doc roots from pi's docs section", () => {
	assert.deepEqual(extractDocsPaths(PROMPT), {
		main: "/opt/pi/README.md",
		additional: "/opt/pi/docs",
		examples: "/opt/pi/examples",
	});
});

check("a prompt without a docs section yields no paths", () => {
	// SYSTEM.md replaces pi's default prefix, which is where docs lives.
	assert.equal(
		extractDocsPaths("You are a terse assistant.\n\n<cwd>\n/tmp\n</cwd>"),
		undefined,
	);
});

check("a partially rewritten section yields no paths", () => {
	// Better to leave pi's section alone than to emit one with a line missing.
	const missing = PROMPT.replace(/^- Additional docs: .+$/m, "");
	assert.equal(extractDocsPaths(missing), undefined);
});

check("keeps a path that contains spaces or a parenthesised tail", () => {
	const prompt = PI_DOCS_SECTION.replace(
		"- Examples: /opt/pi/examples (extensions, custom tools, SDK)",
		"- Examples: /Users/me/my pi/examples (extensions, custom tools, SDK)",
	);
	assert.equal(extractDocsPaths(prompt)?.examples, "/Users/me/my pi/examples");
});

check("extracts the section text without its wrapper", () => {
	assert.equal(
		extractDocsSection(PROMPT),
		PI_DOCS_SECTION.replace("<docs>\n", "").replace("\n</docs>", ""),
	);
});

// ── the split ─────────────────────────────────────────────────────────

check("moves every bullet out and leaves pi's section blank", () => {
	const split = splitDocsSection(PI_TEXT);
	assert.deepEqual(split.prompt, [ROUTING]);
	// pi 1.3.0 renders seven bullets: three roots, four guidance lines.
	assert.equal(split.bullets.length, 7);
	assert.ok(
		split.bullets[0].startsWith("- Main documentation: /opt/pi/README.md"),
	);
	assert.ok(
		split.bullets[6].startsWith("- Always read pi .md files completely"),
	);
	assert.equal(buildDocsSection(split), BLANK_SECTION);
});

check("the blank section is whitespace, and truthy", () => {
	// pi merges the map with `if (content)` — truthiness, no trim — so `""` and
	// `null` are skipped and pi renders its whole section again (verified on
	// Pi-Bolt 1.4.0: `<docs>` came back with all seven bullets). A space is the
	// smallest value that still replaces it, and a built-in section can be
	// replaced, never deleted, so 16 bytes is the floor.
	assert.equal(BLANK_SECTION.trim(), "");
	assert.equal(`<docs>\n${BLANK_SECTION}\n</docs>`.length, 16);
});

check("a variant's instruction line survives the blanking", () => {
	// Whatever a variant adds without a bullet is a standing instruction, not
	// lookup data; blanking is for pi's own section, not for someone's rule.
	const instruction = "This machine pins pi at 1.3.0; do not upgrade it.";
	const split = splitDocsSection(
		`${ROUTING}\n${instruction}\n- Main documentation: /opt/pi/README.md`,
	);
	assert.deepEqual(split.prompt, [ROUTING, instruction]);
	assert.deepEqual(split.bullets, ["- Main documentation: /opt/pi/README.md"]);
	assert.equal(buildDocsSection(split), instruction);
});

check("every line of pi's section reaches the skill or is dropped", () => {
	// Transcription stays safe because nothing is rewritten and nothing is
	// duplicated: the bullets move to the skill verbatim, and the only lines
	// dropped from pi's section are its non-bullet ones — which on a stock
	// section is its routing sentence alone, the line the description restates.
	for (const section of [PI_DOCS_SECTION, PIBOLT_SECTION]) {
		const text = extractDocsSection(section) as string;
		const split = splitDocsSection(text);
		const moved = buildSkillFile(split)
			.split("\n")
			.filter((line) => line.startsWith("- "));
		assert.equal(buildDocsSection(split), BLANK_SECTION);
		const dropped = text.split("\n").filter((line) => !moved.includes(line));
		assert.deepEqual(dropped, [ROUTING]);
		assert.equal(moved.length + dropped.length, text.split("\n").length);
	}
});

// ── the generated skill ───────────────────────────────────────────────

check("the skill keeps the Pi-Bolt update note", () => {
	// Regression: rebuilding the section from a template dropped this line, so
	// the model was free to recommend `pi update` on Pi-Bolt.
	const body = buildSkillFile(splitDocsSection(PIBOLT_TEXT));
	assert.ok(body.includes(PIBOLT_LINE), "Pi-Bolt's line was dropped");
	assert.equal(
		buildDocsSection(splitDocsSection(PIBOLT_TEXT)).includes(PIBOLT_LINE),
		false,
		"Pi-Bolt's line was left in the prompt",
	);
});

check("a topic pi adds later reaches the skill with no code change", () => {
	const future = PI_TEXT.replace(
		"\n- Always read",
		"\n- When asked about: subagents (docs/subagents.md, examples/subagents/)\n- Always read",
	);
	const body = buildSkillFile(splitDocsSection(future));
	assert.ok(body.includes("docs/subagents.md"));
});

check("every docs/ path pi's section names survives transcription", () => {
	const named = [
		...new Set(
			[...PI_TEXT.matchAll(/docs\/[A-Za-z0-9_.-]+\.md/g)].map(
				(match) => match[0],
			),
		),
	];
	assert.ok(named.length >= 10, `only found ${named.length} paths to check`);
	const body = buildSkillFile(splitDocsSection(PI_TEXT));
	for (const path of named) {
		assert.ok(body.includes(path), `skill lost ${path}`);
	}
});

check("the skill's frontmatter names it and routes on pi questions", () => {
	// The section is blank, so this description is the only place the model
	// learns that pi's docs exist and where their index is.
	const frontmatter =
		/^---\n([\s\S]*?)\n---/.exec(
			buildSkillFile(splitDocsSection(PI_TEXT)),
		)?.[1] ?? "";
	assert.match(frontmatter, new RegExp(`^name: ${SKILL_NAME}$`, "m"));
	const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
	assert.match(description, /pi itself/);
	assert.match(description, /docs\/ and examples\//);
});

check("the advertised routing text does not depend on the install", () => {
	// The skills section is diffed like any other: install-specific frontmatter
	// would churn the prompt on every machine.
	const other = PI_DOCS_SECTION.replaceAll("/opt/pi", "/home/me/pi install");
	const frontmatter = (body: string) =>
		/^---\n[\s\S]*?\n---/.exec(body)?.[0] ?? "";
	assert.equal(
		frontmatter(buildSkillFile(splitDocsSection(PI_TEXT))),
		frontmatter(buildSkillFile(splitDocsSection(other))),
	);
	assert.match(
		buildSkillFile(splitDocsSection(other)),
		/Additional docs: \/home\/me\/pi install\/docs/,
		"the skill is not install-specific",
	);
});

// ── wiring ────────────────────────────────────────────────────────────

check("replaces sections.docs with the blank section", () => {
	const options = runHandler({ deps: memoryFs().deps });
	const sections = options.sections as Record<string, string>;
	assert.equal(sections.docs, BLANK_SECTION);
});

check("advertises the generated skill with its file location", () => {
	const { deps } = memoryFs();
	const options = runHandler({ deps });
	const skills = options.skills as Array<Record<string, unknown>>;
	assert.equal(skills.length, 1);
	assert.equal(skills[0].name, SKILL_NAME);
	assert.equal(skills[0].description, SKILL_DESCRIPTION);
	assert.equal(
		skills[0].filePath,
		"/mem/pi-system-prompt-trim/abc123/pi-docs/SKILL.md",
	);
	assert.equal(skills[0].disableModelInvocation, false);
});

check("writes the skill file once and not again while it is unchanged", () => {
	const fs = memoryFs();
	runHandler({ deps: fs.deps });
	assert.equal(fs.writes.length, 1);
	assert.equal(fs.files.size, 1);
	assert.match(
		[...fs.files.values()][0],
		/^- Main documentation: \/opt\/pi\/README\.md$/m,
	);
	runHandler({ deps: fs.deps });
	assert.equal(fs.writes.length, 1, "rewrote an unchanged file");
});

check("running twice does not advertise the skill twice", () => {
	const fs = memoryFs();
	const first = runHandler({ deps: fs.deps });
	const second = runHandler({
		deps: fs.deps,
		options: freshOptions({ skills: [] }),
	});
	const skillsOf = (options: Record<string, unknown>) =>
		(options.skills as Array<Record<string, unknown>>).map(
			(skill) => skill.name,
		);
	assert.deepEqual(skillsOf(second), skillsOf(first));
	assert.deepEqual(skillsOf(second), [SKILL_NAME]);
});

check("leaves an already-advertised pi-docs skill alone", () => {
	const existing = {
		name: SKILL_NAME,
		description: SKILL_DESCRIPTION,
		filePath: "/elsewhere/SKILL.md",
		baseDir: "/elsewhere",
		sourceInfo: { source: "local", scope: "user" },
		disableModelInvocation: false,
	};
	const options = runHandler({ options: freshOptions({ skills: [existing] }) });
	assert.deepEqual(options.skills, [existing]);
	// Nothing is pushed over it, but the section is still blanked: whatever
	// advertised `pi-docs` is what the model reads when the docs section was
	// all it had.
	assert.equal(
		(options.sections as Record<string, string>).docs,
		BLANK_SECTION,
	);
});

check("does nothing when the options carry no section map", () => {
	// pi before 1.3 had no name → text map; the prompt must survive untouched.
	const fs = memoryFs();
	const options = runHandler({
		deps: fs.deps,
		options: freshOptions({ sections: undefined }),
	});
	assert.equal(renderedPrompt(PROMPT, options), PROMPT);
	assert.equal(fs.writes.length, 0);
});

check("advertises a skill only from inside the skills section", () => {
	// Pi 1.3.0 renders the section as `<skills>` … `<available_skills>`; the
	// name is only a skill if that is where it appears.
	const prompt = `${PROMPT}\n\n<skills>\nThe following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n  <skill>\n    <name>${SKILL_NAME}</name>\n    <description>x</description>\n    <location>/tmp/pi-docs/SKILL.md</location>\n  </skill>\n</available_skills>\n</skills>`;
	assert.equal(advertisesSkill(prompt, SKILL_NAME), true);
	// A project instruction or another section may name it; that loads nothing.
	assert.equal(
		advertisesSkill(`${PROMPT}\n\n<name>${SKILL_NAME}</name>`, SKILL_NAME),
		false,
	);
	assert.equal(advertisesSkill(PROMPT, SKILL_NAME), false);
});

check("leaves pi's docs section alone when the skill is switched off", () => {
	// The user's own `pi-docs` set to `disable-model-invocation: true` (pi's
	// documented way to keep a skill out of automatic selection) takes the name,
	// so this extension advertises nothing, and pi renders no skills section at
	// all. Trimming then drops the index and every path with nothing to replace
	// them.
	const fs = memoryFs();
	const off = {
		name: SKILL_NAME,
		description: "A stale static pi-docs skill the user turned off.",
		filePath: "/home/me/.pi/agent/skills/pi-docs/SKILL.md",
		baseDir: "/home/me/.pi/agent/skills/pi-docs",
		sourceInfo: { source: "local", scope: "user" },
		disableModelInvocation: true,
	};
	const options = runHandler({
		deps: fs.deps,
		options: freshOptions({ skills: [off] }),
	});
	assert.equal(
		renderedPrompt(PROMPT, options),
		PROMPT,
		"trimmed with no skill to point at",
	);
});

check("does nothing when no reader tool is selected", () => {
	// Without read or bash pi omits the skills section, so trimming would put
	// the index out of reach.
	const fs = memoryFs();
	const options = runHandler({
		deps: fs.deps,
		options: freshOptions({ selectedTools: ["edit", "write"] }),
	});
	assert.equal(renderedPrompt(PROMPT, options), PROMPT);
	assert.equal(fs.writes.length, 0);
});

check("does nothing when the options cannot hold a skill", () => {
	const fs = memoryFs();
	const options = runHandler({
		deps: fs.deps,
		options: freshOptions({ skills: undefined }),
	});
	assert.equal(renderedPrompt(PROMPT, options), PROMPT);
	assert.equal(fs.writes.length, 0);
});

check("does not overwrite a docs section another extension wrote", () => {
	// Another extension's rewrite no longer matches pi's shape; leaving it alone
	// beats transcribing someone else's block into our skill.
	const fs = memoryFs();
	const foreign = PROMPT.replace(
		PI_DOCS_SECTION,
		"<docs>\nTeam conventions index\n</docs>",
	);
	const options = runHandler({
		deps: fs.deps,
		options: freshOptions({ sections: { docs: "Team conventions index" } }),
		systemPrompt: foreign,
	});
	assert.equal(
		(options.sections as Record<string, string>).docs,
		"Team conventions index",
	);
	assert.equal(fs.writes.length, 0);
});

check("a failed write leaves pi's paths in the prompt", () => {
	// A read-only or sandboxed temp dir must not blind the model to its docs.
	const options = runHandler({
		deps: {
			skillDir: () => "/mem",
			readFile: () => undefined,
			writeFile: () => {
				throw new Error("EROFS: read-only file system");
			},
		},
	});
	assert.equal(renderedPrompt(PROMPT, options), PROMPT);
});

// ── the real file on disk ─────────────────────────────────────────────

check("the generated file is readable where the handler advertises it", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-system-prompt-trim-test-"));
	try {
		const options = runHandler({ deps: { skillDir: () => dir } });
		const skills = options.skills as Array<{ filePath: string }>;
		const body = readFileSync(skills[0].filePath, "utf8");
		assert.ok(skills[0].filePath.startsWith(join(dir, SKILL_NAME)));
		assert.match(body, /^---\nname: pi-docs$/m);
		assert.match(body, /^- Additional docs: \/opt\/pi\/docs$/m);
		assert.equal(body.includes(ROUTING), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

check("pi's own loader accepts the generated skill", () => {
	// The end-to-end claim: what the handler advertises is a skill pi itself
	// discovers, with the advertised name and description.
	const dir = mkdtempSync(join(tmpdir(), "pi-system-prompt-trim-load-"));
	try {
		const options = runHandler({ deps: { skillDir: () => dir } });
		const advertised = (
			options.skills as Array<{ filePath: string; description: string }>
		)[0];
		const { skills, diagnostics } = loadSkills({
			cwd: dir,
			agentDir: dir,
			skillPaths: [advertised.filePath],
			includeDefaults: false,
		});
		assert.deepEqual(diagnostics, []);
		assert.deepEqual(
			skills.map((skill) => skill.name),
			[SKILL_NAME],
		);
		assert.equal(skills[0].description, advertised.description);
		const section = formatSkillsForPrompt(skills);
		assert.ok(section.includes(`<name>${SKILL_NAME}</name>`));
		assert.ok(section.includes(advertised.filePath));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── where the file lives ──────────────────────────────────────────────

/** Run `fn` with `name` set to `value`, restoring whatever was there. */
function withEnv<T>(name: string, value: string, fn: () => T): T {
	const previous = process.env[name];
	process.env[name] = value;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

check("the advertised location does not follow $TMPDIR", () => {
	// A moved location is a changed `<skills>` section, and pi records that as a
	// new section patch on the next resume — which invalidates the provider's
	// cached prefix for the whole conversation. macOS gives a new $TMPDIR per
	// login session, so a temp-dir location moves on every reboot.
	const first = withEnv(
		"TMPDIR",
		join(tmpdir(), "pi-system-prompt-trim-boot-1"),
		() => defaultSkillDir("pi-coding-agent"),
	);
	const second = withEnv(
		"TMPDIR",
		join(tmpdir(), "pi-system-prompt-trim-boot-2"),
		() => defaultSkillDir("pi-coding-agent"),
	);
	assert.equal(second, first, "the location moved with $TMPDIR");
	assert.equal(
		first,
		join(getAgentDir(), "cache", "pi-system-prompt-trim", "pi-coding-agent"),
	);
});

check("a pi update does not move the location", () => {
	// brew keeps every release in its own Cellar directory, and npx in a store
	// keyed on the resolved version; the package directory's *name* is what
	// holds still across them.
	const cellared = (version: string) =>
		installId(
			`/opt/homebrew/Cellar/pi-coding-agent/${version}/libexec/lib/node_modules/@earendil-works/pi-coding-agent`,
		);
	assert.equal(cellared("1.3.0"), "pi-coding-agent");
	assert.equal(cellared("1.4.0"), "pi-coding-agent");
	assert.equal(
		installId(
			"/Users/me/.npm/_npx/9f2c/node_modules/@earendil-works/pi-coding-agent",
		),
		"pi-coding-agent",
	);
	assert.equal(
		defaultSkillDir(cellared("1.3.0")),
		defaultSkillDir(cellared("1.4.0")),
	);
});

check("pi and Pi-Bolt keep separate files", () => {
	// The body is the install's own instruction — Pi-Bolt's transcription ends
	// with "do not suggest `pi update`". One file for both would let the last
	// writer hand a session the other variant's paths and rules.
	const pi = installId(
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
	);
	const pibolt = installId("/Users/me/.pi-bolt/pi-bolt-darwin-arm64");
	assert.equal(pi, "pi-coding-agent");
	assert.equal(pibolt, "pi-bolt");
	assert.notEqual(defaultSkillDir(pi), defaultSkillDir(pibolt));
	// The architecture is not part of an install's identity: the bundle is
	// per-arch, the instructions it transcribes are not.
	assert.equal(installId("/Users/me/.pi-bolt/pi-bolt-linux-x64"), "pi-bolt");
	assert.equal(installId("C:/Users/me/.pi-bolt/pi-bolt-win32-x64"), "pi-bolt");
});

check("a package directory with no usable name still gets an id", () => {
	assert.equal(installId("/"), "pi");
	assert.equal(installId("/tmp/my pi install/"), "my-pi-install");
});

check(
	"the default location writes into pi's agent dir, not the temp dir",
	() => {
		// Asserted against a redirected agent dir so the suite never touches the
		// real `~/.pi/agent/cache`.
		const agent = mkdtempSync(join(tmpdir(), "pi-system-prompt-trim-agent-"));
		try {
			const filePath = withEnv("PI_CODING_AGENT_DIR", agent, () => {
				const options = runHandler({ deps: {} });
				return (options.skills as Array<{ filePath: string }>)[0].filePath;
			});
			assert.equal(
				filePath,
				join(
					agent,
					"cache",
					"pi-system-prompt-trim",
					"pi-coding-agent",
					"pi-docs",
					"SKILL.md",
				),
			);
			assert.match(
				readFileSync(filePath, "utf8"),
				/^- Additional docs: \/opt\/pi\/docs$/m,
			);
		} finally {
			rmSync(agent, { recursive: true, force: true });
		}
	},
);

// ── the package ───────────────────────────────────────────────────────

check("the package ships the extension and no static skill", () => {
	// A static `pi-docs` skill would collide with the generated one by name.
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.deepEqual(manifest.pi.extensions, ["./system-prompt-trim.ts"]);
	assert.equal(manifest.pi.skills, undefined);
	assert.equal(manifest.files.includes("skills"), false);
	assert.ok(manifest.files.includes("system-prompt-trim.ts"));
});

// ── summary ───────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`\n${failures.length} failed:\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("\nall checks passed");
