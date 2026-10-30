/**
 * pi-system-prompt-trim — pi's own documentation map as a generated, on-demand skill.
 *
 * Transcribes the `docs` section the running install actually renders — paths,
 * topic → file index, reading rules, any variant caveat — into a per-install
 * `pi-docs` skill file, advertises it, and blanks the section. Nothing is
 * hand-maintained, so a pi release that rewrites the section keeps its wording.
 *
 * The `docs` section is the only one trimmed. Other sections are left exactly as
 * pi built them: they carry standing instructions, not lookup data, so moving one
 * behind a skill would change behaviour on turns that never mention it.
 *
 * The skill's absolute path is prompt state, so resuming a session under a
 * different install rewrites the `<skills>` section and invalidates the
 * provider's cached prefix for the rest of the conversation.
 * `promptCacheWarning` compares the path the session recorded with the one this
 * run advertises, and the `session_start` handler says so once.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	createSyntheticSourceInfo,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getPackageDir,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const SKILL_NAME = "pi-docs";

/**
 * The skill's advertised description. Static on purpose: it is the routing
 * text, and it stays install-independent so the `skills` section does not
 * churn between machines or sessions.
 */
export const SKILL_DESCRIPTION =
	"Index of pi's own documentation — the README, docs/ and examples/ directories that ship with the pi install. Use when the user asks about pi itself (its CLI, extensions, skills, prompt templates, themes, TUI, providers, models, MCP servers, codemode, settings, sessions, or SDK), or when working on pi or on a pi extension.";

const BUILTIN_DOCS = /<docs>\n([\s\S]*?)<\/docs>/;

const SKILLS_SECTION = /<skills>\n([\s\S]*?)<\/skills>/;

const MAIN_DOCS = /^- Main documentation: (.+)$/m;
const ADDITIONAL_DOCS = /^- Additional docs: (.+)$/m;
const EXAMPLES = /^- Examples: (.+)$/m;

/** A line that is documentation lookup rather than prompt instruction. */
const BULLET = /^-\s/;

/**
 * pi's routing sentence: `Pi documentation (read only when …):`.
 *
 * The one line of the section deliberately not transcribed: `SKILL_DESCRIPTION`
 * gates on the same topics plus more. Matching pi's shape rather than position
 * is what keeps a variant's added line in the prompt.
 */
const ROUTING_SENTENCE = /^Pi documentation \(.*\):\s*$/;

/** The documentation roots named by pi's `docs` section. */
export interface DocsPaths {
	/** Pi's README. */
	main: string;
	/** The `docs/` directory. */
	additional: string;
	/** The `examples/` directory. */
	examples: string;
}

/**
 * The three documentation paths from a rendered system prompt, or `undefined`
 * when it has no recognisable `docs` section.
 *
 * Absence is normal: a `SYSTEM.md` or another extension may rewrite the section
 * out of this shape, and a half-parsed section would be worse than pi's own.
 * The three paths are also the guard that the bullets being moved are pi's own
 * documentation lookup rather than some other `<docs>` block.
 */
export function extractDocsPaths(systemPrompt: string): DocsPaths | undefined {
	const section = BUILTIN_DOCS.exec(systemPrompt)?.[1];
	if (section === undefined) return undefined;
	const main = MAIN_DOCS.exec(section)?.[1]?.trim();
	const additional = ADDITIONAL_DOCS.exec(section)?.[1]?.trim();
	// pi renders the examples bullet with a trailing list: `<dir> (extensions,
	// custom tools, SDK)`. The parenthetical is a description, not part of the path.
	const examples = EXAMPLES.exec(section)?.[1]
		?.replace(/\s+\([^()]*\)$/, "")
		.trim();
	if (!main || !additional || !examples) return undefined;
	return { main, additional, examples };
}

/** The text inside `<docs>`, without the wrapper. */
export function extractDocsSection(systemPrompt: string): string | undefined {
	return BUILTIN_DOCS.exec(systemPrompt)?.[1].trimEnd();
}

/**
 * Whether the rendered prompt advertises a skill of this name — i.e. the model
 * can see it and read its file.
 *
 * The prompt is the gate, not the `skills` array the handler pushed into: pi
 * leaves a skill out for `disable-model-invocation: true`, for a missing reader
 * tool, and for rules a later release adds. A blanked section pointing at a
 * skill the model cannot see would cost the index *and* the paths.
 */
export function advertisesSkill(systemPrompt: string, name: string): boolean {
	const section = SKILLS_SECTION.exec(systemPrompt)?.[1];
	if (section === undefined) return false;
	// Only inside the section: project instructions and other sections quote
	// skill names too, and a name mentioned there loads nothing.
	return section.includes(`<name>${name}</name>`);
}

/** pi's section split into the part that stays and the part that moves. */
export interface DocsSplit {
	/** Instruction lines: pi's routing sentence, and anything pi did not bullet. */
	prompt: string[];
	/** Lookup lines: paths, the topic index, the reading rules, variant notes. */
	bullets: string[];
}

/**
 * Split pi's `docs` section by line, keeping order within each part.
 *
 * A line without a bullet is the safe default: more likely a standing
 * instruction than lookup data, and burying one in a skill that loads only on
 * docs questions would change behaviour on unrelated turns.
 */
export function splitDocsSection(section: string): DocsSplit {
	const prompt: string[] = [];
	const bullets: string[] = [];
	for (const line of section.split("\n")) {
		if (BULLET.test(line)) bullets.push(line);
		else prompt.push(line);
	}
	return { prompt, bullets };
}

/**
 * What replaces pi's section: one space.
 *
 * Not `""` and not `null` — pi merges the section map with `if (content)`, a
 * truthiness test with no trim, so an empty value is skipped and pi renders its
 * whole section again. Nor can it be zero bytes: a built-in section can be
 * replaced, never deleted, so the other 15 of the 16 are the `<docs>` wrapper.
 *
 * An earlier version put an 83-character pointer line here; the `skills`
 * section is rendered whenever this extension trims, and it already names the
 * skill, so the line only repeated the description.
 */
export const BLANK_SECTION = " ";

/**
 * The section that replaces pi's: blank, unless pi's section carried an
 * instruction line of its own.
 */
export function buildDocsSection(split: DocsSplit): string {
	const kept = split.prompt.filter((line) => !ROUTING_SENTENCE.test(line));
	return kept.length > 0 ? kept.join("\n") : BLANK_SECTION;
}

/** The generated `SKILL.md`: frontmatter plus pi's bullets, verbatim. */
export function buildSkillFile(split: DocsSplit): string {
	return [
		"---",
		`name: ${SKILL_NAME}`,
		`description: ${SKILL_DESCRIPTION}`,
		"---",
		"",
		"# Pi's own documentation",
		"",
		"Generated by pi-system-prompt-trim from this install's system prompt. Edits are overwritten.",
		"",
		...split.bullets,
		"",
	].join("\n");
}

/** Where the generated file lives and how it is read and written. */
export interface DocsSkillDeps {
	/** Directory holding the skill; defaults to `defaultSkillDir()`. */
	skillDir?: (paths: DocsPaths) => string;
	/** Read the file, or return `undefined` when it does not exist. */
	readFile?: (filePath: string) => string | undefined;
	/** Write the file, creating parents; throws on failure. */
	writeFile?: (filePath: string, content: string) => void;
	/** The install this run belongs to; defaults to `installId()`. */
	installId?: () => string;
	/**
	 * The session's recorded entries, replayed by
	 * {@link replayPromptSections}; defaults to `ctx.sessionManager.getBranch()`.
	 */
	recordedEntries?: (
		ctx: ExtensionContext,
	) => readonly SessionEntry[] | undefined;
}

const SKILL_DIR_NAME = "pi-system-prompt-trim";

/** A pi-bolt bundle directory is `pi-bolt-<platform>-<arch>`. */
const PLATFORM_ARCH = /-(?:darwin|linux|win32)-(?:arm64|x64)$/;

/**
 * Which install owns the generated skill: the *name* of the pi package
 * directory, never its path.
 *
 * Two installs must not share one file. The body is install-specific
 * instruction — this install's doc roots, plus any caveat a variant appends —
 * and the model reads it later in the turn, so the last writer would hand the
 * other install's paths and rules to whoever reads next: a Pi-Bolt session
 * reading pi's transcription loses the `pi update` warning, and pi gains a
 * `pi-bolt update` one.
 *
 * A version, on the other hand, must not be part of it. brew's Cellar, an npx
 * or pnpm store and a dev checkout all end in `pi-coding-agent`, and a pi-bolt
 * bundle minus platform and arch is `pi-bolt`, so the id survives an update —
 * which matters because it is in the prompt (see `defaultSkillDir`).
 *
 * The directory name is the only discriminator the build exposes: pi-bolt's
 * bundle reports pi's own `name`, `version` and `APP_NAME`.
 */
export function installId(packageDir: string = getPackageDir()): string {
	const id = basename(packageDir)
		.replace(PLATFORM_ARCH, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-");
	// `PI_PACKAGE_DIR=/` and the like still need a usable name.
	return id || "pi";
}

/**
 * Where the generated file lives: pi's own per-user state, never the OS temp
 * directory.
 *
 * Every skill's absolute `filePath` is rendered into its `<skills>` entry, so
 * the advertised location is part of the prompt, and it has to hold still
 * between runs. `$TMPDIR` does not: it is per login session on macOS, fresh per
 * container, and emptied by OS cleanup. A location that moves makes pi record a
 * new `sections.skills` patch on the next resume, and a changed system prompt
 * invalidates the provider's cached prefix for the whole conversation — a much
 * larger cost than this extension saves.
 */
export function defaultSkillDir(install: string = installId()): string {
	return join(getAgentDir(), "cache", SKILL_DIR_NAME, install);
}

/** The generated file's path for an install — the value `<skills>` advertises. */
export function defaultSkillPath(install: string = installId()): string {
	return join(defaultSkillDir(install), SKILL_NAME, "SKILL.md");
}

/** This extension's own generated file, with its install id captured. */
const CACHE_SKILL_PATH = new RegExp(
	`[/\\\\]cache[/\\\\]${SKILL_DIR_NAME}[/\\\\]([^/\\\\]+)[/\\\\]${SKILL_NAME}[/\\\\]SKILL\\.md$`,
);

/**
 * The install id inside this extension's own cache path, or `undefined` when the
 * path is not one of ours (a user's `pi-docs` skill, say) — in which case there
 * is nothing this extension can substantiate, and it stays quiet.
 */
export function cacheInstallId(filePath: string): string | undefined {
	return CACHE_SKILL_PATH.exec(filePath)?.[1];
}

/** The `<skill>` blocks of a rendered `skills` section. */
const SKILL_BLOCK = /<skill>([\s\S]*?)<\/skill>/g;

/** The five entities pi escapes in a rendered skill list. */
const XML_ENTITIES: Record<string, string> = {
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&amp;": "&",
};

/**
 * The `pi-docs` location a rendered or recorded `skills` section names, or
 * `undefined` when it has no entry for this extension's skill.
 *
 * Matched as a whole `<skill>` block rather than "the first `<location>` after
 * the name": a section pi shortened or a variant reshaped must not make this
 * return the location of a different skill, because every byte of the path it
 * returns ends up in the user-facing warning.
 */
export function recordedSkillPath(skillsSection: string): string | undefined {
	for (const block of skillsSection.matchAll(SKILL_BLOCK)) {
		if (!block[1].includes(`<name>${SKILL_NAME}</name>`)) continue;
		const location = /<location>([^<]*)<\/location>/.exec(block[1])?.[1];
		if (location === undefined) return undefined;
		return location.replace(
			/&(?:lt|gt|quot|apos|amp);/g,
			(entity) => XML_ENTITIES[entity] ?? entity,
		);
	}
	return undefined;
}

/**
 * Replay the prompt sections a session recorded, from its system messages.
 *
 * pi's session format (docs/session-format.md) says it plainly: the first
 * request persists one system message holding every prompt section, later
 * changes persist as system messages that patch `sections` by name, and a
 * `null` removes one. Replaying them in order yields the prompt the session
 * recorded — there is no separate prompt-state entry. Compaction needs no
 * special case: pi derives its `systemMessage` checkpoint from these same
 * messages (`_restoreToolsFromTranscript`), so the fold already equals the
 * checkpoint.
 *
 * `undefined` when the branch recorded no sections at all — a fresh session, or
 * one older than system messages — which is a state this module cannot compare
 * and so must not guess about.
 */
export function replayPromptSections(
	entries: readonly SessionEntry[],
): Record<string, string | null> | undefined {
	const sections: Record<string, string | null> = {};
	let recorded = false;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "system" || !message.sections) continue;
		recorded = true;
		for (const [name, text] of Object.entries(message.sections)) {
			if (typeof text === "string") sections[name] = text;
			else delete sections[name];
		}
	}
	return recorded ? sections : undefined;
}

/** Friendly names for the installs this extension knows it ships under. */
const INSTALL_LABELS: Record<string, string> = {
	"pi-coding-agent": "pi",
	"pi-bolt": "Pi-Bolt",
};

function installLabel(install: string): string {
	const label = INSTALL_LABELS[install];
	return label ? `${label} (${install})` : install;
}

/**
 * What to tell the user about a resumed session whose recorded prompt carries a
 * different `pi-docs` path than this run will advertise, or `undefined` when the
 * two agree or the recorded prompt says nothing about this extension's skill.
 *
 * Only the one section whose content this extension owns is compared. The rest
 * of the prompt can differ for reasons nothing here can see — a pi upgrade's own
 * section text, a project's instructions — and guessing at a cause is worse than
 * silence. Both named causes are read off the two paths themselves: the install
 * id inside this extension's cache directory, and the path when it moved under
 * the same install (a different agent dir, say).
 */
export function promptCacheWarning(
	recorded: Record<string, string | null> | undefined,
	install: string,
): string | undefined {
	const skills = recorded?.skills;
	if (typeof skills !== "string") return undefined;
	const recordedPath = recordedSkillPath(skills);
	if (recordedPath === undefined) return undefined;
	const currentPath = defaultSkillPath(install);
	if (recordedPath === currentPath) return undefined;

	const recordedInstall = cacheInstallId(recordedPath);
	const effect =
		"the provider's cached prompt prefix is invalidated for the rest of this conversation";
	if (recordedInstall !== undefined && recordedInstall !== install) {
		return `This session was recorded by ${installLabel(recordedInstall)} and is now running under ${installLabel(install)}: the ${SKILL_NAME} skill path changed, so ${effect}. Resume it under ${installLabel(recordedInstall)} to keep the cache.`;
	}
	return `This session recorded the ${SKILL_NAME} skill at ${recordedPath} and this run advertises ${currentPath}: the skill path changed, so ${effect}.`;
}

function defaultReadFile(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function defaultWriteFile(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf8");
}

export function registerDocsSkill(
	pi: ExtensionAPI,
	deps: DocsSkillDeps = {},
): void {
	const skillDir = deps.skillDir ?? (() => defaultSkillDir());
	const readFile = deps.readFile ?? defaultReadFile;
	const writeFile = deps.writeFile ?? defaultWriteFile;
	const install = deps.installId ?? installId;
	const recordedEntries =
		deps.recordedEntries ??
		((ctx: ExtensionContext) => ctx.sessionManager.getBranch());

	// A resumed session carries the prompt it recorded in its system messages. If
	// it names a different `pi-docs` path than this run will, the next request
	// rewrites the prompt and the provider's cached prefix is gone for good. Say so
	// once. Detection only reads entries and writes one notification: one shot,
	// no provider request, no appended entry, and a throw leaves the session and
	// the trim below exactly as they were.
	pi.on("session_start", (_event, ctx) => {
		try {
			const warning = promptCacheWarning(
				replayPromptSections(recordedEntries(ctx) ?? []),
				install(),
			);
			if (warning !== undefined) ctx.ui.notify(warning, "warning");
		} catch {
			// Best effort by construction: an unreadable or unexpected session must
			// never cost the user their run, or the trim, over a warning.
		}
	});

	pi.on("before_agent_start", (event) => {
		// pi 1.4 types this as the normalized name → text map and skill list; the
		// runtime guards below keep a pre-1.4 build (no map at all) a no-op rather
		// than a throw.
		const options = event.systemPromptOptions;
		const sections = options.sections;
		if (!sections || typeof sections !== "object") return;

		// Reading `systemPrompt` re-renders from the options, so ask once.
		const builtPrompt = event.systemPrompt;
		const paths = extractDocsPaths(builtPrompt);
		if (!paths) return;
		const section = extractDocsSection(builtPrompt);
		if (section === undefined) return;

		// Trimming is only safe while the index stays reachable: without a reader
		// tool pi omits the skills section, and without a skills array the file is
		// never advertised — either way the index and the paths both go.
		const tools = options.selectedTools;
		if (
			tools !== undefined &&
			!(tools.includes("read") || tools.includes("bash"))
		)
			return;
		const skills = options.skills;
		if (!Array.isArray(skills)) return;

		const split = splitDocsSection(section);
		// With the default `skillDir` this is `defaultSkillPath()`, the location the
		// resume warning compares the session's recorded path against.
		const filePath = join(skillDir(paths), SKILL_NAME, "SKILL.md");
		try {
			const body = buildSkillFile(split);
			// Avoid rewriting an unchanged file: the directory survives sessions,
			// and a needless write is a needless mtime change.
			if (readFile(filePath) !== body) writeFile(filePath, body);
		} catch {
			// A read-only or sandboxed agent dir must not cost the model its doc
			// paths: leave pi's section exactly as built.
			return;
		}

		if (!skills.some((skill) => skill?.name === SKILL_NAME)) {
			skills.push({
				name: SKILL_NAME,
				description: SKILL_DESCRIPTION,
				filePath,
				baseDir: dirname(filePath),
				// Only name, description, filePath and disableModelInvocation are
				// read when the skills section is rendered; the rest is scaffolding
				// for code that inspects loaded skills. The file is a regenerated
				// cache under pi's agent dir, which is what these values say.
				sourceInfo: createSyntheticSourceInfo(filePath, {
					source: "extension",
					scope: "temporary",
					origin: "top-level",
				}),
				disableModelInvocation: false,
			});
		}

		// Blanking is only safe while the skill that holds the index is on. A
		// user's own `pi-docs` marked `disable-model-invocation: true` keeps this
		// extension from advertising one (the name is taken), and pi then renders
		// no skill entry at all — blanking would drop the index for nothing.
		if (!advertisesSkill(event.systemPrompt, SKILL_NAME)) return;

		sections.docs = buildDocsSection(split);
	});
}

export default registerDocsSkill;
