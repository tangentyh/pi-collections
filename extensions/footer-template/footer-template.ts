import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Scaffold for a configurable string-template footer.
 *
 * TODO: read `footerTemplate` settings and install a custom footer with
 * `ctx.ui.setFooter()`.
 */
export default function footerTemplate(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// TODO: resolve the configured template and render footer placeholders.
	});
}
