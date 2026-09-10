# `bash-gate` prior art

Research notes for a pi extension that gates `bash` tool calls and returns a
feedback instruction (e.g. `grep` detected → block the call, tell the agent to
use `rg` instead).

Decision: drop — adopted `npm:@aaronkyriesenbach/pi-substitute-commands`, which already implements the stated behavior; revisit only if custom rules / warn modes / copy-paste feedback become needed.
Date: 2026-09-04 (resolved 2026-09-04)

## Catalog search

Searched the npm registry (`keywords:pi-package`, the source of truth the
pi.dev gallery is built on; the catalog pages are JS-rendered and could not be
scraped via `curl`). Registry `total` counts all ~9k keyword-tagged packages,
so hits below are the top relevance-ranked candidates per query:

- `bash gate guard`: `@xynogen/pix-gate` (permission gate for dangerous bash), `pi-permission-ai-guard`, `pi-ast-guard`, permission-adjacent guards
- `bash tool`: `@fgladisch/pi-bash-approval`, `@aaronkyriesenbach/pi-substitute-commands`, `pi-restrict-bash`, `pi-nolo`, `pi-smart-terminal`, `@giladbarnea/pi-pretty-bash`
- `grep ripgrep`: `@piotr-oles/pi-reflag` (rewrite `grep`→`rg`), `@tian.zuo/pi-find`, `@xynogen/pix-grep`
- `tool guard intercept block`: `@lucascardozo/pi-edit-guard`, `@yaosu/pi-path-guard`, `pi-death-loop-guard`
- `substitute commands`: exact match → `@aaronkyriesenbach/pi-substitute-commands`
- `rewrite redirect`: no direct competitor (only output-rewriting proxies)

Exact idea: exact match exists → `@aaronkyriesenbach/pi-substitute-commands`
(hard-blocks `bash` calls containing disallowed commands and suggests
replacements, shipping `find`/`grep` → `fd`/`rg`).

## Closest alternatives

| Package | Approach | Useful ideas |
| --- | --- | --- |
| `npm:@aaronkyriesenbach/pi-substitute-commands` — hard-blocks `bash` calls with disallowed commands, suggests replacements | Block + feedback via `tool_call` event; parses with `unbash`, resolves wrappers/subshells/`find -exec`/`bash -c`, fails open on parse errors, exempts `git grep` | Closest overlap. Steal: `unbash` command-position detection, wrapper taxonomy (passthrough/flag/exec wrappers), fail-open rule, block message naming each command + replacement |
| `npm:@piotr-oles/pi-reflag` — transparently rewrites `grep`→`rg`, `find`→`fd` before execution | Silent in-place rewrite; extensive flag-translation tables; leaves subshells/variable assignments untouched | Steal: flag-mapping tables if a rewrite mode is ever added. Lesson: silent rewrite teaches the agent nothing — block + feedback is the pedagogical opposite, and the stated goal |
| `npm:pi-restrict-bash` — opinionated `bash` restrictions nudging toward `read`/`edit`/`write` + `rg` | Broad strict blocklist (tools, shell features, wrappers, launchers, mutating `git` subcommands); GPL-2.0-only; loosen by forking | Steal: rule taxonomy (what categories to gate). Warnings: strictness fatigue, GPL license vs this repo's MIT, no runtime configuration |
| `npm:@fgladisch/pi-bash-approval` — interactive allow-list guard for `bash` calls | Confirm/allow-list via TUI prompt | Steal: allow-list UX if an interactive approve path is added later |
| `npm:pi-nolo` — gates `write`/`edit`/`bash` behind confirmation with safe-command allowlists + YOLO overrides | Confirmation gate with allowlist + override modes | Steal: allowlist + override-mode config pattern (`strict`/`loose`-style settings) |
| `npm:@xynogen/pix-gate` — permission gate for dangerous bash (confirm/block TUI dialog) | Dangerous-pattern confirmation | Adjacent only (safety, not substitution feedback); snippet-level, README not verified |
| `npm:pi-ast-guard` / `npm:@yaosu/pi-path-guard` — AST/pattern guards against destructive commands and path overwrites | Destructive-command blocking | Adjacent only (safety, not substitution feedback); snippet-level, READMEs not verified |

## Upstream baseline

Closest `examples/extensions/permission-gate.ts` (in `@earendil-works/pi-coding-agent`):

```ts
pi.on("tool_call", async (event, ctx) => {
	if (event.toolName !== "bash") return undefined;
	const command = event.input.command as string;
	// ...pattern check...
	return { block: true, reason: "Blocked by user" };
});
```

What to reuse natively — `pi.on("tool_call")`, `event.toolName` /
`event.input.command`, the `{ block: true, reason }` return (the reason string
is the feedback instruction, no extra plumbing needed), `ctx.hasUI` +
`ctx.ui.select`/`confirm` if an interactive approve path is ever added.
What NOT to reimplement — do not override/replace the `bash` tool itself
(`examples/extensions/tool-override.ts` shows that heavier path: same-name
`registerTool`, reimplemented execution, lost built-in rendering). An event
gate keeps built-in behavior and rendering untouched.

## Implications

1. **Scope to keep narrow.** One mechanism: match `bash` command → block →
   feedback string. No rewriting, no confirmation UI, no safety blocklist in v1.
2. **Syntax/API choice.** Settings-driven rules (`{ match, message }` list in
   settings, `grep`→`rg` as the single default) instead of hardcoded pairs —
   this is the one thing `pi-substitute-commands` (code change per pair) and
   `pi-restrict-bash` (fork to adjust) both lack.
3. **Differentiation.** The 1–2 things competitors lack: (a) user-configurable
   rules + messages with zero rebuild/fork; (b) MIT-licensed, dependency-free,
   single-purpose gate fitting this collection (vs strict GPL bundle or silent
   rewriter). Document the matcher honestly: simple matching with fail-open on
   unparseable input (per `pi-substitute-commands`), not `unbash`-deep
   resolution in v1 — or depend on `unbash` and say so.
4. **If configurability is not wanted, do not build.** `pi install
   npm:@aaronkyriesenbach/pi-substitute-commands` already delivers exactly the
   stated example behavior with deeper nesting coverage than a v1 could match.
5. **Design for agent familiarity, not just tool merit.** Agents produce far
   more reliable `find`/`grep` invocations than `fd`/`rg` ones — decades of
   examples in training data vs a newer, smaller corpus — and `fd`'s
   pattern-first syntax diverges from `find` predicates exactly where agents
   guess wrong (e.g. a hallucinated `fd -name`). `rg` is the safer nudge
   (grep-compatible flags, wide coverage); `fd` is the riskier one. Two
   consequences: (a) every rule's feedback message must contain a
   ready-to-paste replacement command, so the agent copies instead of
   recalling — in-context teaching beats training-data reliance; (b) the
   silent-rewrite approach (`pi-reflag`) sidesteps familiarity entirely, so
   if blocked agents keep emitting broken `fd` commands, rewriting beats
   blocking.
