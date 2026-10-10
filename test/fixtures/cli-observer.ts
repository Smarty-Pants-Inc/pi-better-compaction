import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This observer does not author system messages, rewrite requests or compact.
// builtin:mcp generates the sections; the package under test does all replay.
export default function (pi: ExtensionAPI) {
	const log = (event: string, data: unknown = {}) => appendFileSync(process.env.PI_BOUNDARY_EVENTS!, JSON.stringify({ event, data }) + "\n");
	pi.on("session_start", (_event, ctx) => {
		log("start", { mode: ctx.mode, hasUI: ctx.hasUI, stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY });
	});
	pi.on("agent_settled", (_event, ctx) => {
		// Pi 1.0's notification has no outcome field; check the finalized message.
		const branch = ctx.sessionManager.getBranch();
		const last = [...branch].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
		log("settled", { stopReason: last?.type === "message" ? last.message.stopReason : undefined, branch });
	});
	pi.on("session_compact", (_event, ctx) => {
		log("compact", { branch: ctx.sessionManager.getBranch() });
	});
	pi.on("session_compact_failed", (event) => log("compact_failed", event));
	pi.on("session_before_compact", (event) => log("before_compact", { firstKeptEntryId: event.preparation.firstKeptEntryId }));
	pi.on("before_provider_request", (event) => { log("payload", event.payload); });
	pi.registerCommand("boundary-mcp", {
		description: "Register a local synthetic MCP server to change Pi's real MCP section",
		handler: async (version) => {
			pi.registerMcpServer("boundary_docs", {
				command: process.env.PI_BOUNDARY_NODE!, args: [process.env.PI_BOUNDARY_MCP!],
				exposure: "codemode", description: `LOCAL_MCP_DESCRIPTION_${version}`, timeout: 5,
			});
			log("mcp_registered", { version });
		},
	});
	pi.registerCommand("boundary-exit", {
		description: "Persist proof state and shut down cleanly",
		handler: async (_args, ctx) => {
			writeFileSync(process.env.PI_BOUNDARY_SESSION!, JSON.stringify(ctx.sessionManager.getBranch(), null, 2));
			log("exit", { sessionFile: ctx.sessionManager.getSessionFile() });
			ctx.shutdown();
		},
	});
}
