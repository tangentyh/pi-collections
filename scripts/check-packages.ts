// Checks the package-manifest rules every extension in this collection must
// satisfy for its CHANGELOG to be usable — by pi, which shows a package's
// changelog after an update, and by .github/workflows/publish.yml, which cuts
// the GitHub Release notes out of it.
//
// pi only reads a changelog for a package that loads at least one extension
// (`pi.extensions`), from `CHANGELOG.md` at the package root (or
// `pi.changelogPath`), and it matches entries against `package.json` `version`
// — so a release whose changelog has no section for its version shows nothing.
// Its parser also stops collecting an entry at the next line starting with
// `## `, so a non-version `## ` heading silently truncates the entry before
// it (and the heading's own section is discarded). publish.yml looks for a
// line starting with `## [<version>]` and falls back to the tag message when
// there is none or the entry is empty.
//
// Run: npm run check:packages            (the repo's extensions/)
//  or: node scripts/check-packages.ts <dir>   (a fixture dir, for testing)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG_HEADING = /^## \[(\d+)\.(\d+)\.(\d+)\]/;

interface PackageJson {
	name?: unknown;
	version?: unknown;
	files?: unknown;
	pi?: { extensions?: unknown; changelogPath?: unknown };
}

/** First three numbers of a version, so a pre-release suffix does not skew a comparison. */
function parseVersion(version: string): [number, number, number] {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) return [0, 0, 0];
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let i = 0; i < 3; i++) {
		const diff = left[i] - right[i];
		if (diff !== 0) return diff;
	}
	return 0;
}

interface ChangelogSection {
	version: string;
	/** Body lines after the heading, still untrimmed. */
	body: string[];
}

/**
 * Split a changelog the way pi does: an entry runs from its `## ` heading to
 * the next `## ` heading. Unlike pi — which ends the entry above there anyway
 * and silently discards the section under a heading it cannot parse — an
 * unparsable heading is reported, because the entry above loses its tail.
 */
function readChangelog(path: string): {
	sections: ChangelogSection[];
	badHeadings: string[];
} {
	const lines = readFileSync(path, "utf-8").split("\n");
	const sections: ChangelogSection[] = [];
	const badHeadings: string[] = [];
	let current: ChangelogSection | undefined;

	for (const line of lines) {
		if (!line.startsWith("## ")) {
			current?.body.push(line);
			continue;
		}
		current = undefined;
		const match = line.match(CHANGELOG_HEADING);
		if (!match) {
			badHeadings.push(line.trim());
			continue;
		}
		current = {
			version: parseVersion(`${match[1]}.${match[2]}.${match[3]}`).join("."),
			body: [],
		};
		sections.push(current);
	}

	return { sections, badHeadings };
}

function checkPackage(packageDir: string): string[] {
	const problems: string[] = [];
	const manifestPath = join(packageDir, "package.json");
	let manifest: PackageJson;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PackageJson;
	} catch (error) {
		// One unreadable manifest must not hide the other packages' problems.
		return [
			`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		];
	}

	// pi shows a changelog only for packages that load at least one extension.
	const extensions = manifest.pi?.extensions;
	if (!Array.isArray(extensions) || extensions.length === 0) {
		problems.push(
			"pi.extensions is missing or empty — pi shows a changelog only for packages that load an extension",
		);
	}

	const version =
		typeof manifest.version === "string" ? manifest.version : undefined;
	if (!version) {
		problems.push("package.json has no version");
	}

	// pi reads CHANGELOG.md from the package root unless pi.changelogPath says
	// otherwise; an empty changelogPath turns the feature off.
	const configured = manifest.pi?.changelogPath;
	if (typeof configured === "string" && configured.trim() === "") {
		problems.push("pi.changelogPath is empty — this disables the changelog");
		return problems;
	}
	const changelogName =
		typeof configured === "string" ? configured : "CHANGELOG.md";
	const changelogPath = join(packageDir, changelogName);
	// npm `files` entries are paths without a leading "./".
	const changelogEntry = changelogName.replace(/^\.\//, "");

	// Only files in `files` reach an npm install, which is where pi reads them.
	const files = Array.isArray(manifest.files)
		? manifest.files.filter((f): f is string => typeof f === "string")
		: [];
	const shipped = files.indexOf(changelogEntry) !== -1;
	if (!shipped) {
		problems.push(
			`${changelogName} is not listed in "files" — npm will not ship it, so pi has nothing to read`,
		);
	}

	if (!existsSync(changelogPath) || !statSync(changelogPath).isFile()) {
		problems.push(`${changelogName} does not exist at the package root`);
		return problems;
	}

	const { sections, badHeadings } = readChangelog(changelogPath);
	for (const heading of badHeadings) {
		problems.push(
			`heading "${heading}" is not a "## [x.y.z]" version heading — pi ends the entry above at any "## " line and discards the section under a heading it cannot parse; publish.yml finds a release only by a line starting with "## [<version>]", else it falls back to the tag message`,
		);
	}
	if (sections.length === 0) {
		problems.push(`${changelogName} has no "## [x.y.z]" entry`);
		return problems;
	}

	const seen = new Set<string>();
	for (const section of sections) {
		if (seen.has(section.version)) {
			problems.push(`${changelogName} lists version ${section.version} twice`);
		}
		seen.add(section.version);
	}

	if (version) {
		const newest = sections.reduce((a, b) =>
			compareVersions(a.version, b.version) >= 0 ? a : b,
		);
		if (compareVersions(newest.version, version) < 0) {
			problems.push(
				`newest ${changelogName} entry is ${newest.version} but package.json version is ${version} — a bump needs an entry of its own, or pi has nothing to show and the Release falls back to the tag message`,
			);
		} else if (compareVersions(newest.version, version) > 0) {
			problems.push(
				`newest ${changelogName} entry is ${newest.version} but package.json version is ${version} — the manifest version is behind its changelog`,
			);
		}
		const own = sections.find(
			(section) => compareVersions(section.version, version) === 0,
		);
		if (own && own.body.join("\n").trim() === "") {
			problems.push(
				`the ${version} entry in ${changelogName} is empty — publish.yml would fall back to the tag message`,
			);
		}
	}

	return problems;
}

function main(): void {
	// An explicit argument lets the check run against a fixture directory.
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const root = process.argv[2] ?? join(repoRoot, "extensions");
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		process.stderr.write(`No packages found under ${root}\n`);
		process.exitCode = 1;
		return;
	}
	const packageDirs = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name))
		.filter((dir) => existsSync(join(dir, "package.json")))
		.sort();

	if (packageDirs.length === 0) {
		process.stderr.write(`No packages found under ${root}\n`);
		process.exitCode = 1;
		return;
	}

	const lines: string[] = [];
	let failed = 0;
	for (const packageDir of packageDirs) {
		const problems = checkPackage(packageDir);
		if (problems.length === 0) continue;
		failed++;
		lines.push(`${relative(root, packageDir)}/`);
		for (const problem of problems) lines.push(`  - ${problem}`);
	}

	const suffix = failed === 0 ? "" : `, ${failed} failed`;
	lines.push(
		`Changelog metadata: ${packageDirs.length - failed}/${packageDirs.length} packages ok${suffix}`,
	);

	// One write, so the per-package problems stay above the summary when CI
	// merges stderr into stdout.
	if (failed > 0) {
		process.stderr.write(`${lines.join("\n")}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write(`${lines.join("\n")}\n`);
	}
}

main();
