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
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
	getPackageDir,
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

/** A skill entry as it appears in `systemPromptOptions.skills`. */
interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: unknown;
	disableModelInvocation: boolean;
}

/** `systemPromptOptions` — the fields this extension reads and writes. */
interface PromptOptions {
	selectedTools?: string[];
	sections?: Record<string, string | null>;
	skills?: SkillEntry[];
}

export function registerDocsSkill(
	pi: ExtensionAPI,
	deps: DocsSkillDeps = {},
): void {
	const skillDir = deps.skillDir ?? (() => defaultSkillDir());
	const readFile = deps.readFile ?? defaultReadFile;
	const writeFile = deps.writeFile ?? defaultWriteFile;

	pi.on("before_agent_start", (event) => {
		// pi 1.3+ exposes the prompt's name → text map here. The untyped read is
		// deliberate: the workspace typechecks against an older release, and a
		// missing map must leave the prompt exactly as pi built it.
		const options = event.systemPromptOptions as unknown as PromptOptions;
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
				// for code that inspects loaded skills.
				sourceInfo: {
					path: filePath,
					source: "extension",
					scope: "path",
					origin: "extension",
				},
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
