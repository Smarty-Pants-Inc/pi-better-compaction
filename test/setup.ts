import { mock } from "bun:test";
// Pi's real context builder (compaction kept window, context edits); the package entry is mocked below.
import { buildSessionContext } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

mock.module("@earendil-works/pi-coding-agent", () => ({
	buildSessionContext,
	compact: async () => {
		throw new Error("unexpected call to pi's real compact() in tests");
	},
	convertToLlm: (messages: Array<Record<string, unknown>>) =>
		messages.map((message) =>
			message.role === "compactionSummary"
				? {
					role: "user",
					content: [
						{
							type: "text",
							text: `${COMPACTION_SUMMARY_PREFIX}${message.summary ?? ""}\n</summary>`,
						},
					],
					timestamp: message.timestamp,
				}
				: message,
		),
}));
