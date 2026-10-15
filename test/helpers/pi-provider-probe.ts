// Run outside bun:test: its preload mocks pi-coding-agent. This probe intentionally
// imports the published Pi 1.0 packages and captures their actual provider payload.
import assert from "node:assert/strict";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { serializeMessagesToCompactRequest } from "../../src/serializer";
import { rewriteResponsesPayloadWithNativeReplay } from "../../src/payload-rewrite";
import { registerExtensionRuntime } from "../../src/extension-runtime";
import { createNativeCompactionDetails, DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY } from "../../src/types";

const [api, capability, placement, reasoningArg] = process.argv.slice(2);
const native = capability === "true";
const model = {
	provider: api === "openai-responses" ? "openai" : "openai-codex",
	api, id: "pi-1-regression", name: "Pi regression", baseUrl: "http://127.0.0.1:1/v1",
	reasoning: reasoningArg === "true", input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
	...(capability === "absent" ? {} : { compat: { supportsMidConvoSystemMessages: native } }),
} as Model<Api>;
const session = SessionManager.inMemory(process.env.TMPDIR);
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
const update = () => session.appendMessage({
	role: "system", content: "MCP registry changed.",
	sections: { mcp_servers: "Available MCP servers: docs", obsolete_section: null }, timestamp: Date.now(),
});
session.appendMessage({ role: "system", content: "Authoritative base prompt.", sections: { obsolete_section: "Old section." }, timestamp: 0 });
const keptId = session.appendMessage(user("KEPT_USER"));
if (placement === "before") update();
const opaque = [{ type: "compaction", encrypted_content: "opaque-test-checkpoint" }];
const compactionId = session.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, keptId, 256,
	createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, compactedWindow: opaque }), true);
session.appendMessage(user("LIVE_TAIL"));
if (placement.startsWith("tools-")) {
	const calls = ["A", "B"].map(name => ({ type: "toolCall" as const, id: `call_${name}|fc_${name}`, name: `lookup_${name}`, arguments: {} }));
	session.appendMessage({
		role: "assistant", content: calls, provider: model.provider, api: model.api, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now(),
	});
	const result = (index: number) => session.appendMessage({
		role: "toolResult", toolCallId: calls[index].id, toolName: calls[index].name,
		content: [{ type: "text", text: `ACTUAL_RESULT_${index === 0 ? "A" : "B"}` }], isError: false, timestamp: Date.now(),
	});
	if (placement === "tools-before-results") update();
	result(0);
	if (placement !== "tools-before-results") update();
	if (placement !== "tools-trailing-orphan") {
		result(1);
		session.appendMessage(user("FOLLOW_UP"));
	}
} else {
	if (placement !== "before") update();
	if (placement === "interior") session.appendMessage(user("FOLLOW_UP"));
}
const branchEntries = session.getBranch();
const compactionEntry = branchEntries.find(e => e.id === compactionId)!;
assert.equal(compactionEntry.type, "compaction");
if (compactionEntry.type !== "compaction") throw new Error("missing checkpoint");
assert.ok(compactionEntry.systemMessage, "Pi must supply the real system checkpoint");
const projected = session.buildSessionContext().messages;
if (placement === "before") {
	assert.equal(projected.filter(m => m.role === "system").length, 1, "Pi folds the retained update into the checkpoint");
	assert.equal(compactionEntry.systemMessage.sections?.mcp_servers, "Available MCP servers: docs");
	assert.equal(compactionEntry.systemMessage.sections?.obsolete_section, undefined);
}
let payload: any;
let networkCalls = 0;
// Synthetic, non-authentic credential solely to pass the provider's local setup.
const apiKey = api === "openai-responses" ? "local-test-only" : `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-test-only" } })).toString("base64url")}.not-a-signature`;
const stream = (api === "openai-responses" ? responsesStream : codexStream)(model as never, { messages: convertToLlm(projected) }, {
	apiKey, transport: "sse", maxRetries: 0,
	fetch: async () => { networkCalls++; throw new Error("Network forbidden in provider probe"); },
	onPayload: (body: unknown) => { payload = structuredClone(body); throw new Error("LOCAL_PAYLOAD_CAPTURE_COMPLETE"); },
});
await stream.result();
assert.ok(payload, "Pi's real provider must reach onPayload");
assert.equal(networkCalls, 0);
if (placement.startsWith("tools-")) {
	// These expectations describe independently produced Pi provider input, not
	// the extension's transform. System updates must never duplicate outputs.
	const outputs = payload.input.filter((item: any) => item.type === "function_call_output");
	assert.deepEqual(outputs.map((item: any) => item.call_id), ["call_A", "call_B"]);
	assert.deepEqual(outputs.map((item: any) => item.output), ["ACTUAL_RESULT_A", placement === "tools-trailing-orphan" ? "No result provided" : "ACTUAL_RESULT_B"]);
	const lastResultIndex = payload.input.findLastIndex((item: any) => item.type === "function_call_output");
	if (native) {
		const updateIndex = payload.input.findIndex((item: any) => (item.role === "system" || item.role === "developer") && typeof item.content === "string" && item.content.includes("MCP registry changed."));
		assert.equal(updateIndex, lastResultIndex + 1, "Pi holds the update until actual/synthetic tool results are flushed");
	}
}
const original = structuredClone(payload);
const args = { model, payload, branchEntries, compactionEntry: compactionEntry as never };
const rewritten = rewriteResponsesPayloadWithNativeReplay(args);
assert.equal(rewritten.ok, true, `Real Pi payload rejected: ${JSON.stringify(rewritten)}`);
if (!rewritten.ok) throw new Error("parity rejected");
const liveTailIndex = payload.input.findIndex((item: any) => item.role === "user" && JSON.stringify(item.content).includes("LIVE_TAIL"));
assert.ok(liveTailIndex >= 0);
const head = payload.input.slice(0, payload.input.findIndex((item: any) => item.role === "user"));
// Also exercise the compact-request serializer directly against provider input,
// with Pi's independently folded current prompt, not locally reconstructed text.
const freshInstructions = getCurrentSystemPrompt(convertToLlm(projected));
const compactRequest = serializeMessagesToCompactRequest({ model, messages: projected, instructions: freshInstructions });
assert.deepEqual(compactRequest.input, payload.input.slice(head.length));
assert.equal(compactRequest.instructions, freshInstructions);
assert.ok(compactRequest.instructions.includes("Available MCP servers: docs"));
assert.ok(!compactRequest.instructions.includes("Old section."));
assert.deepEqual(rewritten.rewrittenPayload, { ...payload, input: [...head, ...opaque, ...payload.input.slice(liveTailIndex)] });
assert.equal(rewritten.segments.preCompactionKeptWindow.messages.some(m => m.role === "system"), false);
assert.equal(rewritten.segments.preCompactionKeptWindow.entries.some(e => e.type === "message" && e.message.role === "system"), false);
assert.deepEqual(rewritten.segments.postCompactionTail.input, payload.input.slice(liveTailIndex));
const rendered = api === "openai-responses" ? JSON.stringify(head) : payload.instructions;
if (placement === "before" || !native) {
	assert.ok(rendered.includes("Available MCP servers: docs"), "fresh authoritative prompt contains folded MCP state");
	assert.ok(!rendered.includes("Old section."), "removed section stays removed");
}
const interiorSystemCount = payload.input.slice(liveTailIndex).filter((item: any) => item.role === "system" || item.role === "developer").length;
assert.equal(interiorSystemCount, native && placement !== "before" ? 1 : 0);
assert.deepEqual(payload, original, "hook must not mutate Pi's input");
const handlers = new Map<string, Function>();
registerExtensionRuntime({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never, {
	loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG, debug: false }, warnings: [] }),
});
const ctx = {
	cwd: process.env.TMPDIR, model, hasUI: false, sessionManager: session,
	getSystemPrompt: () => rendered,
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test-only" }) },
};
assert.deepEqual(await handlers.get("before_provider_request")!({ payload }, ctx), rewritten.rewrittenPayload, "registered hook must replay the opaque window");
const tampered = structuredClone(payload);
tampered.input[liveTailIndex].content = [{ type: "input_text", text: "UNRECORDED_USER" }];
assert.equal(rewriteResponsesPayloadWithNativeReplay({ ...args, payload: tampered }).ok, false, "strict parity gate rejects changed transcript");
assert.equal(await handlers.get("before_provider_request")!({ payload: tampered }, ctx), undefined);
console.log(JSON.stringify({ api, capability, placement, reasoning: model.reasoning, checkpoint: true, payloadCapturedFromRealProvider: true, networkCalls, parity: true, hook: true, strictTamperRejected: true, toolAccounting: placement.startsWith("tools-") }));
