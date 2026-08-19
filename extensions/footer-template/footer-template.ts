import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function formatElapsedTime(elapsedSeconds: number): string {
	if (elapsedSeconds < 60) return `${elapsedSeconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(elapsedSeconds);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes} min ${seconds} s`;

	const hours = Math.floor(minutes / 60);
	return `${hours} h ${minutes % 60} min ${seconds} s`;
}

/**
 * Scaffold for a configurable string-template footer.
 *
 * TODO: read `footerTemplate` settings and install a custom footer with
 * `ctx.ui.setFooter()`.
 */
export default function footerTemplate(pi: ExtensionAPI): void {
	let agentStartMs: number | null = null;

	pi.on("agent_start", () => {
		agentStartMs = performance.now();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = performance.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		const elapsedTime = formatElapsedTime(elapsedSeconds);
		const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedTime}`;
		ctx.ui.notify(message, "info");
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// TODO: resolve the configured template and render footer placeholders.
	});
}
