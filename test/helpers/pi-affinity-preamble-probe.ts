// Run outside bun:test so the trust-boundary probe uses real Pi projection and
// provider payloads, not test/setup.ts's converter mock. No provider I/O occurs.
import assert from "node:assert/strict";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { Api, Model } from "@earendil-works/pi-ai";
import { COMPACTION_AFFINITY_RETIRED_ENTRY } from "../../src/compaction-affinity";
import { registerExtensionRuntime } from "../../src/extension-runtime";
import { extractFreshAuthoritativePreamble } from "../../src/payload-rewrite";
import { createNativeCompactionDetails, DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY, NATIVE_COMPACTION_STRATEGY_V2 } from "../../src/types";

const [api, reasoningArg] = process.argv.slice(2);
const model = {
	provider: api === "openai-responses" ? "openai" : "openai-codex",
	api, id: "pi-affinity-regression", name: "Pi affinity regression", baseUrl: "http://127.0.0.1:1/v1",
	reasoning: reasoningArg === "true", input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
	compat: { supportsMidConvoSystemMessages: true },
} as Model<Api>;
const opaque = { type: "compaction", encrypted_content: "retired-opaque-test-checkpoint" };
const sectionText = 'Updated system prompt section "mcp_servers":\n\nAvailable MCP servers: docs';
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
let networkCalls = 0;
let aborts = 0;
const handlers = new Map<string, Function>();
registerExtensionRuntime({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never, {
	loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG, debug: false }, warnings: [] }),
});

function branch(fullTranscript: boolean) {
	const session = SessionManager.inMemory(process.env.TMPDIR);
	session.appendMessage({ role: "system", content: "Authoritative base prompt.", timestamp: 0 });
	if (fullTranscript) {
		session.appendMessage(user("ORIGINAL_QUESTION"));
		session.appendMessage({
			role: "assistant", content: [{ type: "text", text: "ORIGINAL_ANSWER" }],
			provider: model.provider, api: model.api, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		});
	}
	const keptId = session.appendMessage(user("KEPT_USER"));
	const compactionId = session.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, keptId, 256,
		createNativeCompactionDetails({ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, compactedWindow: [opaque] }, NATIVE_COMPACTION_STRATEGY_V2), true);
	session.appendMessage(user("LIVE_TAIL"));
	return { session, compactionId };
}

async function capture(session: SessionManager) {
	let payload: any;
	// Synthetic credential only passes local provider setup; the fetch stub forbids I/O.
	const apiKey = api === "openai-responses" ? "local-test-only" : `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-test-only" } })).toString("base64url")}.not-a-signature`;
	const stream = (api === "openai-responses" ? responsesStream : codexStream)(model as never, { messages: convertToLlm(session.buildSessionContext().messages) }, {
		apiKey, transport: "sse", maxRetries: 0,
		fetch: async () => { networkCalls++; throw new Error("Network forbidden in affinity probe"); },
		onPayload: (body: unknown) => { payload = structuredClone(body); throw new Error("LOCAL_PAYLOAD_CAPTURE_COMPLETE"); },
	});
	await stream.result();
	assert.ok(payload, "real Pi provider must reach onPayload");
	return payload;
}

const request = (session: SessionManager, payload: unknown) => handlers.get("before_provider_request")!({ payload }, {
	cwd: process.env.TMPDIR, model, hasUI: false, sessionManager: session,
	abort: () => { aborts++; }, getSystemPrompt: () => "Authoritative base prompt.",
	modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test-only" }) },
});

// Complete transcript with ordinary envelopes is still recoverable after retirement.
const complete = branch(true);
const clean = await capture(complete.session);
assert.ok(JSON.stringify(await request(complete.session, clean)).includes(opaque.encrypted_content));
complete.session.appendCustomEntry(COMPACTION_AFFINITY_RETIRED_ENTRY, { compactionEntryId: complete.compactionId });
const recovered = await request(complete.session, clean);
assert.ok(JSON.stringify(recovered).includes("ORIGINAL_ANSWER"));
assert.ok(!JSON.stringify(recovered).includes(opaque.encrypted_content));
assert.ok(!JSON.stringify(recovered).includes(NATIVE_COMPACTION_FALLBACK_SUMMARY));
assert.equal(aborts, 0);

// No-history preamble extraction may not authorize an unrecorded interior MCP note.
// Affinity recovery has no parity oracle for it, unlike successful native replay.
for (const role of ["system", "developer"]) {
	const unexpected = structuredClone(clean);
	const firstUser = unexpected.input.findIndex((item: any) => item.role === "user");
	assert.ok(firstUser >= 0);
	unexpected.input.splice(firstUser + 1, 0, { role, content: sectionText });
	const before = structuredClone(unexpected);
	const blocked = await request(complete.session, unexpected);
	assert.deepEqual(blocked, { ...unexpected, input: [] });
	assert.equal(extractFreshAuthoritativePreamble(unexpected), undefined);
	assert.equal(extractFreshAuthoritativePreamble(unexpected, []), undefined);
	assert.deepEqual(unexpected, before, "failed rewrite must not mutate Pi's payload");
}
assert.equal(aborts, 2);

// Recorded MCP changes pass native replay but never repopulate a fail-closed
// retired checkpoint whose original transcript is missing, at either position.
for (const placement of ["interior", "trailing"]) {
	const truncated = branch(false);
	truncated.session.appendMessage({ role: "system", content: "MCP registry changed.", sections: { mcp_servers: "Available MCP servers: docs" }, timestamp: Date.now() });
	if (placement === "interior") truncated.session.appendMessage(user("FOLLOW_UP"));
	const payload = await capture(truncated.session);
	const before = structuredClone(payload);
	const native = await request(truncated.session, payload);
	assert.ok(JSON.stringify(native).includes(opaque.encrypted_content));
	assert.ok(JSON.stringify(native).includes("Available MCP servers: docs"));
	truncated.session.appendCustomEntry(COMPACTION_AFFINITY_RETIRED_ENTRY, { compactionEntryId: truncated.compactionId });
	const blocked = await request(truncated.session, payload);
	assert.deepEqual(blocked, { ...payload, input: [] });
	assert.deepEqual(payload, before);
	assert.equal(await handlers.get("agent_before_settle")!({}, {}), undefined, "blocked requests cannot schedule a resend");
}
assert.equal(aborts, 4);
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ api, reasoning: model.reasoning, realPiPayload: true, recoveredCleanTranscript: true, unknownInteriorBlocked: true, nativeMcpPreserved: true, retiredMcpFailClosed: true, aborts, networkCalls }));
