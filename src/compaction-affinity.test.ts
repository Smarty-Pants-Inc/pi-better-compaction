import { describe, expect, test } from "bun:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { COMPACTION_AFFINITY_RETIRED_ENTRY, isCompactionAffinityMissing } from "./compaction-affinity";
import { registerExtensionRuntime } from "./extension-runtime";
import { serializeMessagesToResponsesInput } from "./serializer";
import { DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY, NATIVE_COMPACTION_STRATEGY_V2, createNativeCompactionDetails } from "./types";

const model = {
	provider: "cliproxyapi",
	api: "openai-responses",
	id: "gpt-6-astra",
	baseUrl: "https://dev1.example.net/v1",
	input: ["text"],
	reasoning: true,
};

const SIGNED = { type: "compaction", id: "cmp_1", encrypted_content: "gAAAA-signed-elsewhere" };
const RETAINED = { role: "user", content: [{ type: "input_text", text: "Remember: the codename is HERON-7." }] };
/** The compaction item the gateway returns when this account recompacts. */
const FRESH = { type: "compaction", id: "cmp_fresh", encrypted_content: "gAAAA-signed-here" };

/** What pi-ai 0.87 records for the gateway's 409 on an openai-responses route (formatProviderError). */
const body = (code: string, field: "code" | "type" = "code") =>
	JSON.stringify({
		message: "compaction item was not produced through this gateway",
		type: field === "type" ? code : "invalid_request_error",
		...(field === "code" ? { code } : {}),
	});
const AFFINITY_409 = `cliproxyapi API error (409): ${body("compaction_affinity_missing")}`;

function userEntry(id: string, text: string) {
	return { type: "message", id, timestamp: "2026-10-06T08:00:00.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } };
}

function compactionEntry(id: string, compactedWindow: unknown[], summary = NATIVE_COMPACTION_FALLBACK_SUMMARY) {
	return {
		type: "compaction",
		id,
		timestamp: "2026-10-06T08:01:00.000Z",
		summary,
		firstKeptEntryId: "kept",
		tokensBefore: 200_000,
		details: createNativeCompactionDetails(
			{ provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, compactedWindow },
			NATIVE_COMPACTION_STRATEGY_V2,
		),
	};
}

function assistantEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		timestamp: "2026-10-06T07:59:00.000Z",
		message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "stop", content: [{ type: "text", text }], timestamp: 1 },
	};
}

/** Pi's own context for the branch (latest compaction, kept window, tail, context edits). */
function contextMessages(branch: Array<Record<string, any>>) {
	const chained = branch.map((entry, index) => ({ ...entry, parentId: index > 0 ? branch[index - 1]!.id : null }));
	return buildSessionContext(chained as never).messages;
}

/** The payload Pi itself builds: its plain summary, the kept messages, then the tail. */
function piPayload(branch: Array<Record<string, any>>) {
	const messages = contextMessages(branch);
	return {
		model: model.id,
		instructions: "system prompt",
		input: [{ role: "developer", content: "fresh preamble" }, ...serializeMessagesToResponsesInput(model as never, messages as never)],
	};
}

function errorTurn(errorMessage: string) {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "error",
		timestamp: 1,
		errorMessage,
	};
}

function turnEnd(errorMessage: string, toolResultEntryIds: string[] = []) {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: errorTurn(errorMessage),
		toolResults: [],
		messageEntryId: "failed",
		toolResultEntryIds,
		outcome: "error",
		entries: [],
		continue: false,
	};
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(recompact = true) {
	const handlers = new Map<string, Handler>();
	const notes: Array<{ text: string; level: string }> = [];
	const v2Calls: Array<Record<string, any>> = [];
	const toolExecutions: unknown[] = [];
	/** ctx.abort() calls: a fail-closed request is aborted before the SDK sends it. */
	const aborts: unknown[] = [];
	registerExtensionRuntime(
		{
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			appendEntry: () => {
				throw new Error("turn_end boundary results are available");
			},
		} as never,
		{
			loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG }, warnings: [] }),
			executeNativeCompaction: async () => ({ ok: false, reason: "network-error" }) as never,
			executeV2Compaction: async (args) => {
				v2Calls.push(args as never);
				return (recompact ? { ok: true, compactionItem: FRESH, responseId: "resp_fresh" } : { ok: false, reason: "network-error" }) as never;
			},
			runNativeFallbackCompaction: async () => ({ ok: false, reason: "no-model-configured" }) as never,
			executeAnthropicCompaction: async () => ({ ok: false, reason: "request-failed" }) as never,
		},
	);
	const context = (branch: unknown[]) => ({
		cwd: "/tmp/pbc-affinity-test",
		hasUI: true,
		abort: () => aborts.push(true),
		ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
		model,
		getSystemPrompt: () => "system prompt",
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }) },
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "session-affinity",
			getSessionFile: () => undefined,
			getSessionDir: () => "/tmp/pbc-affinity-test",
			buildSessionContext: () => ({ messages: contextMessages(branch as Array<Record<string, any>>) }),
		},
	});
	const call = (name: string, event: unknown, branch: unknown[]) => handlers.get(name)?.(event, context(branch));
	return { call, notes, v2Calls, toolExecutions, aborts };
}

const hasSignedItem = (payload: unknown) =>
	((payload as { input: Array<Record<string, unknown>> }).input ?? []).some((item) => item.type === "compaction");

function commit(branch: unknown[], boundary: unknown) {
	const entries = (boundary as { entries: Array<Record<string, unknown>> }).entries;
	const at = branch.length;
	branch.push(...entries.map((entry, index) => ({ timestamp: "2026-10-06T08:05:00.000Z", ...entry, id: `boundary-${at}-${index}` })));
}

describe("isCompactionAffinityMissing", () => {
	test("matches only a 409 whose error code or type is compaction_affinity_missing", () => {
		const turn = (text: string) => errorTurn(text) as never;
		expect(isCompactionAffinityMissing(turn(AFFINITY_409))).toBe(true);
		expect(isCompactionAffinityMissing(turn(`OpenAI API error (409): ${body("compaction_affinity_missing", "type")}`))).toBe(true);
		expect(isCompactionAffinityMissing(turn(`409: {"error":${body("compaction_affinity_missing")}}`))).toBe(true);

		expect(isCompactionAffinityMissing(turn(`cliproxyapi API error (409): ${body("conflict")}`))).toBe(false);
		expect(isCompactionAffinityMissing(turn("cliproxyapi API error (409): 409 status code (no body)"))).toBe(false);
		expect(isCompactionAffinityMissing(turn(`cliproxyapi API error (400): ${body("compaction_affinity_missing")}`))).toBe(false);
		expect(isCompactionAffinityMissing(turn(`cliproxyapi API error (429): ${body("compaction_affinity_missing")}`))).toBe(false);
		expect(isCompactionAffinityMissing(turn("compaction_affinity_missing"))).toBe(false);
		expect(isCompactionAffinityMissing({ ...errorTurn(AFFINITY_409), stopReason: "stop" } as never)).toBe(false);
	});
});

describe("compaction affinity recovery", () => {
	/** A V2 compaction that kept one retained user message; the assistant answer lives only in the signed item. */
	function v2Branch(): Array<Record<string, any>> {
		return [
			userEntry("u0", "Remember: the codename is HERON-7."),
			assistantEntry("a0", "Noted. The cat is called Biscuit."),
			userEntry("kept", "kept"),
			compactionEntry("c1", [RETAINED, SIGNED]),
			userEntry("u2", "next question"),
		];
	}

	test("v2: a 409 recompacts the branch transcript on the current account, then resends once with that compaction", async () => {
		const h = harness();
		const branch = v2Branch();
		const first = await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
		expect(hasSignedItem(first)).toBe(true);

		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		const boundary = (await h.call("turn_end", turnEnd(AFFINITY_409), branch)) as { entries: Array<Record<string, any>> };
		expect(boundary.entries.slice(0, 2)).toEqual([
			{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } },
			{ type: "context_edit", targetId: "failed", replacement: null },
		]);

		// The recompaction ran once, from the transcript the retired compaction had summarized.
		expect(h.v2Calls).toHaveLength(1);
		const recompactInput = JSON.stringify(h.v2Calls[0]!.request.input);
		expect(recompactInput).toContain("The cat is called Biscuit.");
		expect(recompactInput).toContain("HERON-7");
		expect(recompactInput).toContain("next question");
		expect(recompactInput).not.toContain(SIGNED.encrypted_content);
		expect(recompactInput).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
		const fresh = boundary.entries[2]!;
		expect(fresh).toMatchObject({ type: "compaction", firstKeptEntryId: "failed" });
		expect(JSON.stringify(fresh.details.compactedWindow)).toContain(FRESH.encrypted_content);

		commit(branch, boundary);
		expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });
		expect(h.notes.filter((note) => note.text.includes("compaction-affinity-recovery: "))).toHaveLength(1);

		// The resend replays the fresh compaction (history kept), never the rejected item.
		const resend = JSON.stringify(await h.call("before_provider_request", { payload: piPayload(branch) }, branch));
		expect(resend).toContain(FRESH.encrypted_content);
		expect(resend).not.toContain(SIGNED.encrypted_content);
		expect(resend).toContain("next question");
	});

	test("v2: if the recompaction fails, recovery is blocked and no history-losing payload is ever sent", async () => {
		const h = harness(false);
		const branch = v2Branch();
		await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		const boundary = await h.call("turn_end", turnEnd(AFFINITY_409), branch);
		expect(boundary).toEqual({
			entries: [{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } }],
		});
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		const errors = h.notes.filter((note) => note.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.text).toContain("/compact");
		expect(errors[0]!.text).toContain("retry");

		// The next prompt carries the full branch transcript, not retained user items alone.
		commit(branch, boundary);
		await h.call("before_agent_start", { prompt: "retry" }, branch);
		branch.push(userEntry("u3", "retry"));
		const next = JSON.stringify(await h.call("before_provider_request", { payload: piPayload(branch) }, branch));
		expect(next).toContain("The cat is called Biscuit.");
		expect(next).toContain("HERON-7");
		expect(next).toContain("next question");
		expect(next).not.toContain(SIGNED.encrypted_content);
		expect(next).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);

		// /compact recompacts from the same transcript, so the loss is never made permanent.
		await h.call(
			"session_before_compact",
			{
				signal: new AbortController().signal,
				preparation: { tokensBefore: 1, firstKeptEntryId: "u3", messagesToSummarize: [], turnPrefixMessages: [] },
			},
			branch,
		);
		expect(h.v2Calls).toHaveLength(2);
		expect(JSON.stringify(h.v2Calls[1]!.request.input)).toContain("The cat is called Biscuit.");
		expect(hasSignedItem(h.v2Calls[1]!.request)).toBe(false);
	});

	test("a second 409 in the same turn is not recovered again", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [userEntry("kept", "kept"), compactionEntry("c1", [RETAINED, SIGNED]), userEntry("u2", "next")];
		await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		commit(branch, await h.call("turn_end", turnEnd(AFFINITY_409), branch));
		expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });

		// The resend (now replaying the fresh compaction) fails the same way: no further recovery, no further resend.
		expect(JSON.stringify(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toContain(FRESH.encrypted_content);
		expect(await h.call("turn_end", turnEnd(AFFINITY_409), branch)).toBeUndefined();
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();

		// Even a different signed compaction replayed in the same turn is not recovered a second time.
		const other: Array<Record<string, any>> = [userEntry("kept", "kept"), compactionEntry("c2", [RETAINED, SIGNED]), userEntry("u3", "again")];
		expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(other) }, other))).toBe(true);
		expect(await h.call("turn_end", turnEnd(AFFINITY_409), other)).toBeUndefined();
		expect(await h.call("agent_before_settle", {}, other)).toBeUndefined();
		// One recovery, then an "already-recovered" error for each later 409 in the turn.
		expect(h.notes.filter((note) => note.text.includes("compaction-affinity-recovery: "))).toHaveLength(3);
		expect(h.notes.filter((note) => note.text.includes("already-recovered"))).toHaveLength(2);

		// The next user prompt is a new turn and may recover once again.
		await h.call("before_agent_start", { prompt: "hi" }, other);
		await h.call("before_provider_request", { payload: piPayload(other) }, other);
		expect(await h.call("turn_end", turnEnd(AFFINITY_409), other)).toBeDefined();
	});

	test("tool calls are not re-executed: only the failed reply is dropped and the model request is resent", async () => {
		const h = harness();
		const call = { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } };
		const branch: Array<Record<string, any>> = [
			userEntry("kept", "kept"),
			compactionEntry("c1", [RETAINED, SIGNED]),
			userEntry("u2", "read a.ts"),
			{ type: "message", id: "a1", message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", content: [call], timestamp: 2 } },
			{ type: "message", id: "t1", message: { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, content: [{ type: "text", text: "file body" }], timestamp: 3 } },
		];
		await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		const boundary = (await h.call("turn_end", turnEnd(AFFINITY_409), branch)) as { entries: Array<Record<string, unknown>> };
		// Nothing targets the earlier tool call or its result; the error turn itself ran no tools.
		expect(boundary.entries.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId)).toEqual(["failed"]);
		commit(branch, boundary);
		expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });

		// The tool call and its result go into the recompaction on this account; the resend replays it.
		const recompactInput = h.v2Calls[0]!.request.input as Array<Record<string, unknown>>;
		expect(recompactInput.filter((item) => item.type === "function_call")).toHaveLength(1);
		expect(recompactInput.filter((item) => item.type === "function_call_output")).toHaveLength(1);
		const resend = JSON.stringify(await h.call("before_provider_request", { payload: piPayload(branch) }, branch));
		expect(resend).toContain(FRESH.encrypted_content);
		expect(resend).not.toContain(SIGNED.encrypted_content);
		expect(h.toolExecutions).toHaveLength(0);
	});

	test("consecutive v2: a 409 on the second compaction after an earlier placeholder one fails closed: no recompaction, no resend, error shown", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [
			userEntry("u0", "Remember: the codename is HERON-7."),
			assistantEntry("a0", "Noted. The cat is called Biscuit."),
			userEntry("kept", "kept"),
			// The earlier native compaction: its history lives only in its own signed item.
			compactionEntry("c0", [RETAINED, { ...SIGNED, id: "cmp_0", encrypted_content: "gAAAA-older-signed" }]),
			userEntry("u1", "middle question"),
			assistantEntry("a1", "Middle answer: the dog is called Juniper."),
			{ ...compactionEntry("c1", [RETAINED, SIGNED]), firstKeptEntryId: "u1" },
			userEntry("u2", "next question"),
		];
		expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		const boundary = await h.call("turn_end", turnEnd(AFFINITY_409), branch);

		// Retiring c1 leaves c0's placeholder in force, so the rebuilt context is incomplete:
		// c1 is retired, nothing is recompacted and nothing is resent.
		expect(boundary).toEqual({
			entries: [{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } }],
		});
		expect(h.v2Calls).toHaveLength(0);
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		const errors = h.notes.filter((note) => note.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.text).toContain("compaction-affinity-recovery: blocked");
		expect(errors[0]!.text).toContain("/compact");
		expect(errors[0]!.text).toContain("retry");

		// The next prompt fails closed too: the request is aborted, never Pi's placeholder payload.
		commit(branch, boundary);
		await h.call("before_agent_start", { prompt: "retry" }, branch);
		branch.push(userEntry("u3", "retry"));
		const original = piPayload(branch);
		const next = (await h.call("before_provider_request", { payload: original }, branch)) as { input: unknown[] } | undefined;
		expect(h.aborts).toHaveLength(1);
		expect(next).toBeDefined();
		expect(next).not.toEqual(original);
		expect(next!.input).toEqual([]);
		expect(JSON.stringify(next)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
		expect(h.notes.filter((note) => note.level === "error")).toHaveLength(2);
	});

	test("a retired v2 compaction without plain text and without a recognizable preamble fails closed, never Pi's payload", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [
			userEntry("kept", "kept"),
			compactionEntry("c1", [RETAINED, SIGNED]),
			{ type: "custom", id: "r1", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } },
			userEntry("u2", "next"),
		];
		// A developer item inside the transcript: extractFreshAuthoritativePreamble returns nothing.
		const pi = piPayload(branch);
		const original = { ...pi, input: [pi.input[0], pi.input[1], { role: "developer", content: "mid-transcript note" }, ...pi.input.slice(2)] };
		expect(JSON.stringify(original)).toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
		const result = (await h.call("before_provider_request", { payload: original }, branch)) as { input: unknown[] } | undefined;
		expect(result).toBeDefined();
		expect(result).not.toEqual(original);
		expect(result!.input).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
		expect(h.aborts).toHaveLength(1);
		const errors = h.notes.filter((note) => note.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.text).toContain("/compact");
		expect(errors[0]!.text).toContain("retry");
	});

	test("other 409s, other statuses and requests without a compaction item are untouched", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [userEntry("kept", "kept"), compactionEntry("c1", [RETAINED, SIGNED]), userEntry("u2", "next")];
		for (const errorMessage of [
			`cliproxyapi API error (409): ${body("conflict")}`,
			"cliproxyapi API error (409): 409 status code (no body)",
			`cliproxyapi API error (400): ${body("compaction_affinity_missing")}`,
			`cliproxyapi API error (500): ${body("compaction_affinity_missing")}`,
		]) {
			await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
			expect(await h.call("turn_end", turnEnd(errorMessage), branch)).toBeUndefined();
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		}

		// A successful response clears the in-flight replay.
		await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
		await h.call("after_provider_response", { status: 200, headers: {} }, branch);
		expect(await h.call("turn_end", turnEnd(AFFINITY_409), branch)).toBeUndefined();

		// A request that carried no compaction item is not ours to recover.
		const plain: Array<Record<string, any>> = [userEntry("u1", "hello")];
		await h.call("before_provider_request", { payload: piPayload(plain) }, plain);
		expect(await h.call("turn_end", turnEnd(AFFINITY_409), plain)).toBeUndefined();
		expect(h.notes).toHaveLength(0);
		expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
	});

	test("a plain-text summary (v1) is enough: the resend is Pi's own payload", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [userEntry("kept", "kept"), compactionEntry("c1", [SIGNED], "Cat is Biscuit."), userEntry("u2", "next")];
		expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
		commit(branch, await h.call("turn_end", turnEnd(AFFINITY_409), branch));
		expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });
		expect(await h.call("before_provider_request", { payload: piPayload(branch) }, branch)).toBeUndefined();
		expect(JSON.stringify(piPayload(branch))).toContain("Cat is Biscuit.");
	});

	test("with no plain text and a failed recompaction, the block is retired and the user is told to /compact or retry", async () => {
		const h = harness(false);
		const branch: Array<Record<string, any>> = [userEntry("kept", "kept"), compactionEntry("c1", [SIGNED]), userEntry("u2", "next")];
		await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
		const boundary = await h.call("turn_end", turnEnd(AFFINITY_409), branch);
		expect(boundary).toEqual({
			entries: [{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } }],
		});
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		const errors = h.notes.filter((note) => note.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.text).toContain("compaction-affinity-recovery: ");
		expect(errors[0]!.text).toContain("/compact");
		expect(errors[0]!.text).toContain("retry");

		// Persisted: the retired block is never injected again, and /compact recompacts from Pi's own context.
		commit(branch, boundary);
		expect(hasSignedItem((await h.call("before_provider_request", { payload: piPayload(branch) }, branch)) ?? piPayload(branch))).toBe(false);
		await h.call(
			"session_before_compact",
			{
				signal: new AbortController().signal,
				preparation: { tokensBefore: 1, firstKeptEntryId: "u2", messagesToSummarize: [], turnPrefixMessages: [] },
			},
			branch,
		);
		// The recovery tried once to recompact; /compact recompacts again, never with the retired item.
		expect(h.v2Calls).toHaveLength(2);
		expect(hasSignedItem(h.v2Calls[1]!.request)).toBe(false);
	});
});
