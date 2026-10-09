import { describe, expect, test } from "bun:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { buildAffinityRetiredSessionMessages, buildAffinitySafePayload, COMPACTION_AFFINITY_RETIRED_ENTRY, isAffinityRebuildComplete, isCompactionAffinityMissing } from "./compaction-affinity";
import { registerExtensionRuntime } from "./extension-runtime";
import { serializeMessagesToResponsesInput } from "./serializer";
import { DEFAULT_EXTENSION_CONFIG, NATIVE_COMPACTION_FALLBACK_SUMMARY, NATIVE_COMPACTION_STRATEGY, NATIVE_COMPACTION_STRATEGY_V2, createNativeCompactionDetails } from "./types";

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

/** Materialize Pi's append-only parent links once; never repair an explicit gap. */
function linkBranch(branch: Array<Record<string, any>>) {
	for (const [index, entry] of branch.entries()) {
		if (!("parentId" in entry)) entry.parentId = index > 0 ? branch[index - 1]!.id : null;
	}
	return branch;
}

/** Pi's own context for the branch (latest compaction, kept window, tail, context edits). */
function contextMessages(branch: Array<Record<string, any>>) {
	const chained = branch.map((entry, index) => ({ ...entry, parentId: index > 0 ? branch[index - 1]!.id : null }));
	return buildSessionContext(chained as never).messages;
}

/** The payload Pi itself builds: its plain summary, the kept messages, then the tail. */
function piPayload(branch: Array<Record<string, any>>, currentModel = model) {
	const messages = contextMessages(branch);
	return {
		model: model.id,
		instructions: "system prompt",
		input: [{ role: "developer", content: "fresh preamble" }, ...serializeMessagesToResponsesInput(currentModel as never, messages as never)],
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

function harness(recompact = true, compactionVersion: "v1" | "v2" = "v2", currentModel = model) {
	const handlers = new Map<string, Handler>();
	const notes: Array<{ text: string; level: string }> = [];
	const v1Calls: unknown[] = [];
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
			loadExtensionConfig: () => ({ config: { ...DEFAULT_EXTENSION_CONFIG, compactionVersion }, warnings: [] }),
			executeNativeCompaction: async (args) => {
				v1Calls.push(args);
				return { ok: false, reason: "network-error" } as never;
			},
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
		model: currentModel,
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
	const call = (name: string, event: unknown, branch: unknown[]) => {
		linkBranch(branch as Array<Record<string, any>>);
		return handlers.get(name)?.(event, context(branch));
	};
	return { call, notes, v1Calls, v2Calls, toolExecutions, aborts };
}

const hasSignedItem = (payload: unknown) =>
	((payload as { input: Array<Record<string, unknown>> }).input ?? []).some((item) => item.type === "compaction");

function commit(branch: unknown[], boundary: unknown) {
	const entries = (boundary as { entries: Array<Record<string, unknown>> }).entries;
	const at = branch.length;
	branch.push(...entries.map((entry, index) => ({ timestamp: "2026-10-06T08:05:00.000Z", ...entry, id: `boundary-${at}-${index}` })));
	linkBranch(branch as Array<Record<string, any>>);
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
		const branch: Array<Record<string, any>> = [userEntry("u0", "Original question"), assistantEntry("a0", "Original answer"), userEntry("kept", "kept"), compactionEntry("c1", [RETAINED, SIGNED]), userEntry("u2", "next")];
		await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		commit(branch, await h.call("turn_end", turnEnd(AFFINITY_409), branch));
		expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });

		// The resend (now replaying the fresh compaction) fails the same way: no further recovery, no further resend.
		expect(JSON.stringify(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toContain(FRESH.encrypted_content);
		expect(await h.call("turn_end", turnEnd(AFFINITY_409), branch)).toBeUndefined();
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();

		// Even a different signed compaction replayed in the same turn is not recovered a second time.
		const other: Array<Record<string, any>> = [userEntry("u0", "Original question"), assistantEntry("a0", "Original answer"), userEntry("kept", "kept"), compactionEntry("c2", [RETAINED, SIGNED]), userEntry("u3", "again")];
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
			userEntry("u0", "Original question"), assistantEntry("a0", "Original answer"),
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

	/** Assert all three fail-closed paths, not just the coverage predicate. */
	async function expectGapBlocked(branch: Array<Record<string, any>>, version: "v1" | "v2") {
		const h = harness(true, version);
		const latestId = branch.filter((entry) => entry.type === "compaction").at(-1)!.id;
		expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		const beforeRecovery = JSON.stringify(linkBranch(branch));
		const boundary = await h.call("turn_end", turnEnd(AFFINITY_409), branch);
		expect(JSON.stringify(branch)).toBe(beforeRecovery);
		expect(boundary).toEqual({ entries: [{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: latestId } }] });
		expect(h.v1Calls).toHaveLength(0);
		expect(h.v2Calls).toHaveLength(0);
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		commit(branch, boundary);
		await h.call("before_agent_start", { prompt: "retry" }, branch);
		branch.push(userEntry("retry", "retry"));
		const blocked = await h.call("before_provider_request", { payload: piPayload(branch) }, branch) as { input: unknown[] };
		expect(blocked.input).toEqual([]);
		expect(h.aborts).toHaveLength(1);
		const beforeCompact = JSON.stringify(branch);
		expect(await h.call("session_before_compact", {
			signal: new AbortController().signal,
			preparation: { tokensBefore: 1, firstKeptEntryId: "retry", messagesToSummarize: [], turnPrefixMessages: [] },
		}, branch)).toEqual({ cancel: true });
		expect(JSON.stringify(branch)).toBe(beforeCompact);
		expect(h.v1Calls).toHaveLength(0);
		expect(h.v2Calls).toHaveLength(0);
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		const errors = h.notes.filter((note) => note.level === "error");
		expect(errors).toHaveLength(3);
		for (const error of errors) {
			expect(error.text).toContain("compaction-affinity-recovery:");
			expect(error.text).toContain("/new");
			expect(error.text).toContain("/tree");
			expect(error.text).not.toContain("/compact");
		}
	}

	/** Neither a readable native summary nor its checkpoint metadata proves coverage. */
	function summarizedTwoWindowBranch(
		gap: "missing-boundary" | "broken-chain",
		damagedWindow: "earlier" | "latest" = "earlier",
		strategy: typeof NATIVE_COMPACTION_STRATEGY | typeof NATIVE_COMPACTION_STRATEGY_V2 = NATIVE_COMPACTION_STRATEGY_V2,
	): Array<Record<string, any>> {
		const branch = linkBranch([
			userEntry("original", "Original question"), assistantEntry("original-answer", "Original answer"),
			userEntry("middle", "Middle question"),
			{ ...compactionEntry("c0", [SIGNED], "Nonblank earlier summary is not transcript evidence."), firstKeptEntryId: "middle" },
			assistantEntry("middle-answer", "Middle answer"), userEntry("kept", "Retained boundary survives"),
			compactionEntry("c1", [RETAINED, SIGNED], "Nonblank latest summary is not transcript evidence."),
			userEntry("tail", "Next question"),
		]);
		for (const entry of branch.filter((entry) => entry.type === "compaction")) entry.details.strategy = strategy;
		if (gap === "missing-boundary") {
			branch.find((entry) => entry.id === (damagedWindow === "earlier" ? "c0" : "c1"))!.firstKeptEntryId = "missing-original";
		} else {
			branch.find((entry) => entry.id === (damagedWindow === "earlier" ? "original-answer" : "middle-answer"))!.parentId = "missing-original-parent";
		}
		return branch;
	}

	for (const gap of ["missing-boundary", "broken-chain"] as const) {
		for (const version of ["v1", "v2"] as const) {
			test(`SEC P1 round 3 ${version}: ${gap} with nonblank summaries blocks recovery, resend and recompaction`, async () => {
				for (const strategy of [NATIVE_COMPACTION_STRATEGY, NATIVE_COMPACTION_STRATEGY_V2]) {
					await expectGapBlocked(summarizedTwoWindowBranch(gap, "earlier", strategy), version);
				}
			});

			for (const path of ["before_provider_request", "session_before_compact"] as const) {
				test(`SEC P1 round 3 ${version}: persisted retirement with ${gap} and nonblank summaries blocks ${path} independently`, async () => {
					for (const damagedWindow of ["earlier", "latest"] as const) {
						for (const strategy of [NATIVE_COMPACTION_STRATEGY, NATIVE_COMPACTION_STRATEGY_V2]) {
							const h = harness(true, version);
							const branch = summarizedTwoWindowBranch(gap, damagedWindow, strategy);
							branch.push({ type: "custom", id: "retired", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } });
							const before = JSON.stringify(linkBranch(branch));
							if (path === "before_provider_request") {
								const blocked = await h.call(path, { payload: piPayload(branch) }, branch) as { input: unknown[] };
								expect(blocked.input).toEqual([]);
								expect(h.aborts).toHaveLength(1);
							} else {
								expect(await h.call(path, {
									signal: new AbortController().signal,
									preparation: { tokensBefore: 1, firstKeptEntryId: "tail", messagesToSummarize: [], turnPrefixMessages: [] },
								}, branch)).toEqual({ cancel: true });
							}
							expect(JSON.stringify(branch)).toBe(before);
							expect(h.v1Calls).toHaveLength(0);
							expect(h.v2Calls).toHaveLength(0);
							expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
							const errors = h.notes.filter((note) => note.level === "error");
							expect(errors).toHaveLength(1);
							expect(errors[0]!.text).toContain("/new");
							expect(errors[0]!.text).toContain("/tree");
							expect(errors[0]!.text).not.toContain("/compact");
						}
					}
				});
			}
		}

		test(`SEC P1 round 3: public helpers reject ${gap} despite summaries, retirement markers and checkpoint fields`, () => {
			for (const damagedWindow of ["earlier", "latest"] as const) {
				for (const strategy of [NATIVE_COMPACTION_STRATEGY, NATIVE_COMPACTION_STRATEGY_V2]) {
					for (const concealWith of ["nothing", "retirement", "branch-summary", "nonnative-summary"] as const) {
						const branch = summarizedTwoWindowBranch(gap, damagedWindow, strategy);
						const entry = branch.find((entry) => entry.id === "c1")!;
						entry.details.compactResponseId = "resp_replayed";
						entry.details.requestMeta = { tokensBefore: 200_000, previousSummaryPresent: true };
						if (concealWith === "retirement") {
							branch.push({ type: "custom", id: "retired", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c0" } });
						} else if (concealWith === "branch-summary") {
							branch.push({ type: "branch_summary", id: "later", fromId: "abandoned", summary: "A later branch summary cannot conceal a gap." });
						} else if (concealWith === "nonnative-summary") {
							branch.push({ ...compactionEntry("later", [], "A later nonnative summary cannot conceal a gap."), firstKeptEntryId: "tail", details: undefined });
						}
						const before = JSON.stringify(linkBranch(branch));
						const payload = piPayload(branch);
						expect(isAffinityRebuildComplete(branch as never, model as never)).toBe(false);
						expect(buildAffinitySafePayload(model as never, payload, branch as never, entry as never)).toEqual({ ok: false });
						expect(() => buildAffinityRetiredSessionMessages(branch as never, model as never)).toThrow("Cannot recover every opaque Responses compaction");
						expect(JSON.stringify(branch)).toBe(before);
					}
				}
			}
		});
	}

	for (const version of ["v1", "v2"] as const) {
		test(`SEC P1 ${version}: truncated pre-boundary transcript with a surviving earlier summary blocks visibly without sending`, async () => {
			const full = linkBranch([
				userEntry("original", "Original question"), assistantEntry("original-answer", "Original answer"),
				userEntry("earlier-kept", "Earlier kept question"),
				{ ...compactionEntry("plain", [SIGNED], "A surviving nonempty earlier summary."), firstKeptEntryId: "earlier-kept", details: undefined },
				userEntry("missing", "A lost turn"), assistantEntry("partial", "One surviving answer is not the whole window"),
				userEntry("kept", "Retained boundary survives"), compactionEntry("opaque", [RETAINED, SIGNED]), userEntry("tail", "Next question"),
			]);
			await expectGapBlocked(full.filter((entry) => !["original", "original-answer", "missing"].includes(entry.id)), version);
		});

		test(`SEC P1 ${version}: summaries and the retained boundary alone are never transcript evidence`, async () => {
			for (const prefix of [
				[{ ...compactionEntry("plain", [SIGNED], "A surviving nonempty earlier summary."), firstKeptEntryId: "missing-original", details: undefined }],
				[{ ...compactionEntry("plain", [SIGNED], "A surviving nonempty earlier summary."), firstKeptEntryId: "plain", details: undefined }],
				[{ type: "branch_summary", id: "summary", fromId: "abandoned", summary: "A surviving branch summary." }],
				[],
			]) {
				await expectGapBlocked(linkBranch([
					...prefix, userEntry("kept", "Retained boundary survives"), compactionEntry("opaque", [RETAINED, SIGNED]), userEntry("tail", "Next question"),
				]), version);
			}
		});

		test(`SEC P1 ${version}: a missing middle entry in window 2 of 3 blocks the entire recovery`, async () => {
			const full = linkBranch([
				userEntry("original", "Oldest question"), assistantEntry("oldest-answer", "Oldest answer"),
				userEntry("boundary-1", "Middle question"), { ...compactionEntry("c0", [SIGNED]), firstKeptEntryId: "boundary-1" },
				assistantEntry("middle-answer", "Middle answer"), userEntry("missing-middle", "Missing middle turn"), assistantEntry("surviving-middle", "Surviving middle answer"),
				userEntry("boundary-2", "Latest question"), { ...compactionEntry("c1", [SIGNED]), firstKeptEntryId: "boundary-2" },
				assistantEntry("latest-answer", "Latest answer"), userEntry("kept", "Kept question"), compactionEntry("c2", [SIGNED]), userEntry("tail", "Next question"),
			]);
			await expectGapBlocked(full.filter((entry) => entry.id !== "missing-middle"), version);
		});

		for (const missing of ["result", "call"] as const) {
			test(`SEC P1 ${version}: orphan tool ${missing === "result" ? "call (result missing)" : "result (call missing)"} in the window blocks even with an intact parent chain`, async () => {
				const call = { type: "toolCall", id: "call_orphan|fc_orphan", name: "read", arguments: { path: "lost.ts" } };
				// Construct an intact chain: pairing must fail independently of parent coverage.
				await expectGapBlocked(linkBranch([
					userEntry("original", "Read lost.ts"),
					...(missing === "result" ? [{ type: "message", id: "orphan-call", message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", content: [call], timestamp: 2 } }]
						: [{ type: "message", id: "orphan-result", message: { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, content: [{ type: "text", text: "Orphaned output" }], timestamp: 3 } }]),
					assistantEntry("answer", "A surviving answer does not prove the tool exchange"),
					userEntry("kept", "Kept question"), compactionEntry("opaque", [RETAINED, SIGNED]), userEntry("tail", "Next question"),
				]), version);
			});
		}
	}

	test("SEC P1: public recovery helpers reject dangling, absent, skipped and cyclic parents without repairing the input", () => {
		for (const [id, parentId] of [
			["u0", "missing-root"], ["a0", undefined], ["a0", "a0"], ["kept", "u0"], ["c1", "missing-checkpoint-parent"],
		] as const) {
			const branch = linkBranch(v2Branch());
			branch.find((entry) => entry.id === id)!.parentId = parentId;
			const original = JSON.stringify(branch);
			const entry = branch.find((entry) => entry.id === "c1")!;
			const payload = { model: model.id, instructions: "system prompt", input: [{ role: "developer", content: "fresh preamble" }] };
			expect(isAffinityRebuildComplete(branch as never, model as never)).toBe(false);
			expect(buildAffinitySafePayload(model as never, payload, branch as never, entry as never)).toEqual({ ok: false });
			expect(() => buildAffinityRetiredSessionMessages(branch as never, model as never)).toThrow("Cannot recover every opaque Responses compaction");
			expect(JSON.stringify(branch)).toBe(original);
		}
	});

	test("a complete retain-none window and the next kept window recover through Pi without duplicating history", () => {
		const branch = linkBranch([
			userEntry("original", "Original question"), assistantEntry("original-answer", "Original answer"),
			{ ...compactionEntry("retain-none", [SIGNED]), firstKeptEntryId: "retain-none" },
			userEntry("middle", "Middle question"), assistantEntry("middle-answer", "Middle answer"),
			userEntry("kept", "Kept question"), compactionEntry("c1", [SIGNED]), userEntry("tail", "Next question"),
		]);
		const original = JSON.stringify(branch);
		expect(isAffinityRebuildComplete(branch as never, model as never)).toBe(true);
		expect(buildAffinityRetiredSessionMessages(branch as never, model as never)).toEqual(contextMessages(branch.filter((entry) => entry.type !== "compaction")));
		expect(JSON.stringify(branch)).toBe(original);
	});

	for (const windowCount of [2, 3]) {
		test(`consecutive v2: ${windowCount} compactions recover all transcript windows oldest-first exactly once and reset only on the next prompt`, async () => {
			const h = harness();
			const labels = windowCount === 2 ? ["oldest", "middle", "latest"] : ["oldest", "middle", "latest", "tail"];
			const branch: Array<Record<string, any>> = [userEntry("u-oldest", "oldest question")];
			const oldBlobs: string[] = [];
			for (const [index, label] of labels.entries()) {
				const call = { type: "toolCall", id: `call_${label}|fc_${label}`, name: "read", arguments: { path: `${label}.ts` } };
				branch.push(
					{ type: "message", id: `tool-call-${label}`, message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", content: [call], timestamp: 2 } },
					{ type: "message", id: `tool-result-${label}`, message: { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, content: [{ type: "text", text: `${label} file body` }], timestamp: 3 } },
					assistantEntry(`answer-${label}`, `${label} assistant answer`),
				);
				if (index < windowCount) {
					const nextLabel = labels[index + 1]!;
					const blob = `gAAAA-old-${label}`;
					oldBlobs.push(blob);
					// Each kept user overlaps the next window. Reconstruction must not replay it twice.
					branch.push(
						userEntry(`u-${nextLabel}`, `${nextLabel} question`),
						{ ...compactionEntry(`c${index}`, [{ role: "user", content: [{ type: "input_text", text: `${nextLabel} question` }] }, { ...SIGNED, id: `cmp_${index}`, encrypted_content: blob }]), firstKeptEntryId: `u-${nextLabel}` },
					);
				}
			}
			// Independent oracle: Pi's real context for the original, uncompacted transcript.
			const expectedInput = serializeMessagesToResponsesInput(model as never, contextMessages(branch.filter((entry) => entry.type !== "compaction")) as never);
			const first = await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
			expect(JSON.stringify(first)).toContain(oldBlobs.at(-1)!);
			branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
			const boundary = (await h.call("turn_end", turnEnd(AFFINITY_409), branch)) as { entries: Array<Record<string, any>> };

			expect(h.v2Calls).toHaveLength(1);
			expect(h.v1Calls).toHaveLength(0);
			expect(h.v2Calls[0]).toMatchObject({ runtime: { model: model.id, baseUrl: model.baseUrl, apiKey: "sk-test" } });
			const input = h.v2Calls[0]!.request.input as Array<Record<string, any>>;
			expect(input).toEqual(expectedInput);
			// Assert values and pairing, not merely presence: no duplicate/missing/reordered history.
			expect(input.map((item) => item.type === "function_call" ? `call:${item.call_id}` : item.type === "function_call_output" ? `result:${item.call_id}:${item.output}` : `${item.role}:${item.content[0].text}`)).toEqual(
				labels.flatMap((label) => [`user:${label} question`, `call:call_${label}`, `result:call_${label}:${label} file body`, `assistant:${label} assistant answer`]),
			);
			const recompactText = JSON.stringify(input);
			expect(recompactText).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
			expect(recompactText).not.toContain("No result provided");
			expect(hasSignedItem(h.v2Calls[0]!.request)).toBe(false);
			for (const blob of oldBlobs) expect(recompactText).not.toContain(blob);
			expect(boundary.entries.filter((entry) => entry.type === "context_edit")).toEqual([{ type: "context_edit", targetId: "failed", replacement: null }]);
			expect(boundary.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(JSON.stringify(boundary.entries.find((entry) => entry.type === "compaction")!.details.compactedWindow)).toContain(FRESH.encrypted_content);
			commit(branch, boundary);
			expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
			const resend = (await h.call("before_provider_request", { payload: piPayload(branch) }, branch)) as { input: Array<Record<string, any>> };
			expect(resend.input).toEqual([{ role: "developer", content: "fresh preamble" }, ...expectedInput.filter((item) => "role" in item && item.role === "user"), FRESH]);
			const resendText = JSON.stringify(resend);
			for (const blob of oldBlobs) expect(resendText).not.toContain(blob);
			expect(resendText).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
			expect(h.aborts).toHaveLength(0);
			expect(h.toolExecutions).toHaveLength(0);

			// The fresh blob can also get a 409: the same prompt must not loop.
			branch.push({ type: "message", id: "failed-again", message: errorTurn(AFFINITY_409) });
			expect(await h.call("turn_end", { ...turnEnd(AFFINITY_409), messageEntryId: "failed-again" }, branch)).toBeUndefined();
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
			expect(h.v2Calls).toHaveLength(1);
			expect(h.notes.filter((note) => note.text.includes("already-recovered"))).toHaveLength(1);

			await h.call("before_agent_start", { prompt: "new prompt" }, branch);
			branch.push(userEntry("new-prompt", "new prompt"));
			expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
			branch.push({ type: "message", id: "failed-next", message: errorTurn(AFFINITY_409) });
			const nextBoundary = await h.call("turn_end", { ...turnEnd(AFFINITY_409), messageEntryId: "failed-next" }, branch);
			expect(h.v2Calls).toHaveLength(2);
			expect(h.v2Calls[1]!.request.input).toEqual([...expectedInput, { role: "user", content: [{ type: "input_text", text: "new prompt" }] }]);
			commit(branch, nextBoundary);
			expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
			const nextResend = (await h.call("before_provider_request", { payload: piPayload(branch) }, branch)) as { input: unknown[] };
			expect(nextResend.input).toEqual([{ role: "developer", content: "fresh preamble" }, ...expectedInput.filter((item) => "role" in item && item.role === "user"), { role: "user", content: [{ type: "input_text", text: "new prompt" }] }, FRESH]);
			expect(h.v2Calls).toHaveLength(2);
			expect(h.aborts).toHaveLength(0);
			expect(h.notes.filter((note) => note.level === "warning" && note.text.includes("compaction-affinity-recovery: "))).toHaveLength(2);
		});
	}

	for (const latestVersion of ["v2", "v1"] as const) {
		test(`consecutive ${latestVersion === "v1" ? "v2 then v1" : "v2"}: multi-window recovery preserves older assistant and tool-result replacements and omitted messages`, async () => {
			const h = harness();
			const call = { type: "toolCall", id: "call_edited|fc_edited", name: "read", arguments: { path: "older.ts" } };
			const latest = compactionEntry("c1", [RETAINED, SIGNED], latestVersion === "v1" ? "Latest plain summary cannot replace the older V2 history." : NATIVE_COMPACTION_FALLBACK_SUMMARY);
			if (latestVersion === "v1") latest.details = { ...latest.details, strategy: NATIVE_COMPACTION_STRATEGY };
			const branch: Array<Record<string, any>> = [
				userEntry("u0", "oldest question"),
				{ type: "message", id: "old-call", message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", content: [call], timestamp: 2 } },
				{ type: "message", id: "old-result", message: { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, content: [{ type: "text", text: "original obsolete tool result" }], timestamp: 3 } },
				assistantEntry("old-answer", "original obsolete assistant answer"),
				assistantEntry("omitted", "message removed from context"),
				userEntry("middle", "middle question"),
				{ ...compactionEntry("c0", [{ ...SIGNED, encrypted_content: "gAAAA-older-edited" }]), firstKeptEntryId: "middle" },
				assistantEntry("middle-answer", "middle assistant answer"),
				userEntry("kept", "kept"),
				latest,
				userEntry("latest", "latest question"),
				// Edits appended after both checkpoints still govern the reconstructed oldest window.
				{ type: "context_edit", id: "replace-answer", targetId: "old-answer", replacement: { content: [{ type: "text", text: "corrected older assistant answer" }] } },
				{ type: "context_edit", id: "replace-result", targetId: "old-result", replacement: { content: [{ type: "text", text: "corrected older tool result" }] } },
				{ type: "context_edit", id: "omit-message", targetId: "omitted", replacement: null },
			];
			const expectedInput = serializeMessagesToResponsesInput(model as never, contextMessages(branch.filter((entry) => entry.type !== "compaction")) as never);
			expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
			branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
			const boundary = (await h.call("turn_end", turnEnd(AFFINITY_409), branch)) as { entries: Array<Record<string, any>> };
			expect(h.v2Calls).toHaveLength(1);
			expect(h.v1Calls).toHaveLength(0);
			const input = h.v2Calls[0]!.request.input as Array<Record<string, any>>;
			expect(input).toEqual(expectedInput);
			expect(input.filter((item) => item.role === "assistant").map((item) => item.content[0].text)).toEqual(["corrected older assistant answer", "middle assistant answer"]);
			expect(input.filter((item) => item.type === "function_call")).toEqual([{ type: "function_call", id: "fc_edited", call_id: "call_edited", name: "read", arguments: JSON.stringify(call.arguments) }]);
			expect(input.filter((item) => item.type === "function_call_output")).toEqual([{ type: "function_call_output", call_id: "call_edited", output: "corrected older tool result" }]);
			const text = JSON.stringify(input);
			for (const absent of ["original obsolete", "message removed from context", "gAAAA-older-edited", SIGNED.encrypted_content, NATIVE_COMPACTION_FALLBACK_SUMMARY, "Latest plain summary", "No result provided"]) expect(text).not.toContain(absent);
			expect(boundary.entries.filter((entry) => entry.type === "context_edit")).toEqual([{ type: "context_edit", targetId: "failed", replacement: null }]);
			expect(boundary.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
			commit(branch, boundary);
			expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
			const resend = (await h.call("before_provider_request", { payload: piPayload(branch) }, branch)) as { input: unknown[] };
			expect(resend.input).toEqual([{ role: "developer", content: "fresh preamble" }, ...expectedInput.filter((item) => "role" in item && item.role === "user"), FRESH]);
			expect(h.v2Calls).toHaveLength(1);
			expect(h.aborts).toHaveLength(0);
		});
	}

	test("consecutive v2: a retired earlier opaque checkpoint without its original transcript fails closed before recompaction or resend", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [
			// Imported/truncated branch: neither the summarized messages nor the kept entry exist.
			{ ...compactionEntry("opaque", [{ ...SIGNED, encrypted_content: "gAAAA-opaque-retired" }]), firstKeptEntryId: "missing-original" },
			{ type: "custom", id: "retired-opaque", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "opaque" } },
			userEntry("middle", "middle question"),
			assistantEntry("middle-answer", "middle answer"),
			userEntry("kept", "kept"),
			compactionEntry("c1", [RETAINED, SIGNED]),
			userEntry("latest", "latest question"),
		];
		expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		const boundary = (await h.call("turn_end", turnEnd(AFFINITY_409), branch)) as { entries: Array<Record<string, any>> };
		expect(h.v2Calls).toHaveLength(0);
		expect(h.v1Calls).toHaveLength(0);
		expect(boundary.entries.some((entry) => entry.type === "compaction" || entry.type === "context_edit")).toBe(false);
		expect(boundary.entries).toContainEqual({ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } });
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		commit(branch, boundary);
		await h.call("before_agent_start", { prompt: "retry" }, branch);
		branch.push(userEntry("retry", "retry"));
		const blocked = (await h.call("before_provider_request", { payload: piPayload(branch) }, branch)) as { input: unknown[] };
		expect(blocked.input).toEqual([]);
		expect(h.aborts).toHaveLength(1);
		expect(JSON.stringify(blocked)).not.toContain(SIGNED.encrypted_content);
		expect(JSON.stringify(blocked)).not.toContain("gAAAA-opaque-retired");
		expect(JSON.stringify(blocked)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);
		expect(await h.call("session_before_compact", { signal: new AbortController().signal, preparation: { tokensBefore: 1, firstKeptEntryId: "retry", messagesToSummarize: [], turnPrefixMessages: [] } }, branch)).toEqual({ cancel: true });
		expect(h.v2Calls).toHaveLength(0);
		expect(h.v1Calls).toHaveLength(0);
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		const errors = h.notes.filter((note) => note.level === "error");
		expect(errors).toHaveLength(3);
		for (const error of errors) {
			expect(error.text).not.toContain("/compact");
			expect(error.text).toContain("/new");
			expect(error.text).toContain("/tree");
		}
	});

	test("consecutive v2: a 409 with an earlier window that has no recoverable transcript fails closed: no recompaction, no resend, error shown", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [
			// The earlier checkpoint was imported without its original transcript or kept entry.
			{ ...compactionEntry("c0", [RETAINED, { ...SIGNED, id: "cmp_0", encrypted_content: "gAAAA-older-signed" }]), firstKeptEntryId: "missing-original" },
			userEntry("kept", "kept"),
			userEntry("u1", "middle question"),
			assistantEntry("a1", "Middle answer: the dog is called Juniper."),
			{ ...compactionEntry("c1", [RETAINED, SIGNED]), firstKeptEntryId: "u1" },
			userEntry("u2", "next question"),
		];
		expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
		branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
		const boundary = await h.call("turn_end", turnEnd(AFFINITY_409), branch);

		// c0's original window cannot be rebuilt, so retiring c1 must not bless truncated history.
		expect(boundary).toEqual({
			entries: [{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } }],
		});
		expect(h.v2Calls).toHaveLength(0);
		expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
		const errors = h.notes.filter((note) => note.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.text).toContain("compaction-affinity-recovery: blocked");
		// /compact would compact c0's placeholder for good: point to /new or /tree instead.
		expect(errors[0]!.text).not.toContain("/compact");
		expect(errors[0]!.text).toContain("/new");
		expect(errors[0]!.text).toContain("/tree");

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

	for (const compactionVersion of ["v2", "v1"] as const) {
		test(`consecutive ${compactionVersion}: /compact after the blocked 409 is cancelled, history untouched, no /compact advice`, async () => {
			const h = harness(true, compactionVersion);
			const branch: Array<Record<string, any>> = [
				// A genuinely missing earlier window, not a recoverable native placeholder.
				{ ...compactionEntry("c0", [RETAINED, { ...SIGNED, id: "cmp_0", encrypted_content: "gAAAA-older-signed" }]), firstKeptEntryId: "missing-original" },
				userEntry("kept", "kept"),
				userEntry("u1", "middle question"),
				assistantEntry("a1", "Middle answer: the dog is called Juniper."),
				{ ...compactionEntry("c1", [RETAINED, SIGNED]), firstKeptEntryId: "u1" },
				userEntry("u2", "next question"),
			];
			await h.call("before_provider_request", { payload: piPayload(branch) }, branch);
			branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
			commit(branch, await h.call("turn_end", turnEnd(AFFINITY_409), branch));
			const before = JSON.stringify(branch);

			// c0's original transcript is absent: compacting the truncated context would lose history.
			const result = await h.call(
				"session_before_compact",
				{
					signal: new AbortController().signal,
					preparation: { tokensBefore: 1, firstKeptEntryId: "u2", messagesToSummarize: [], turnPrefixMessages: [] },
				},
				branch,
			);
			expect(result).toEqual({ cancel: true });
			expect(h.v1Calls).toHaveLength(0);
			expect(h.v2Calls).toHaveLength(0);
			expect(JSON.stringify(branch)).toBe(before);
			const errors = h.notes.filter((note) => note.level === "error");
			expect(errors).toHaveLength(2);
			expect(errors[1]!.text).toContain("compaction cancelled");
			for (const error of errors) {
				expect(error.text).not.toContain("/compact");
				expect(error.text).toContain("/new");
				expect(error.text).toContain("/tree");
			}
		});
	}

	test("a retired v2 compaction without plain text and without a recognizable preamble fails closed, never Pi's payload", async () => {
		const h = harness();
		const branch: Array<Record<string, any>> = [
			userEntry("u0", "Original question"), assistantEntry("a0", "Original answer"),
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

	for (const [label, retainedContent] of [
		["content-empty", []],
		["empty-string", [{ type: "text", text: "" }]],
		["whitespace", [{ type: "text", text: "   " }]],
	] as const) {
		test(`v2: ${label} retained user before an opaque checkpoint fails closed after the exact affinity 409`, async () => {
			const h = harness();
			const branch: Array<Record<string, any>> = [
				{
					type: "message",
					id: "kept",
					timestamp: "2026-10-06T08:00:00.000Z",
					message: { role: "user", content: retainedContent, timestamp: 1 },
				},
				// The signed item is opaque; the only apparent prefix is the empty retained user above.
				compactionEntry("c1", [SIGNED]),
				userEntry("question", "new question"),
			];
			expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
			branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });

			const boundary = (await h.call("turn_end", turnEnd(AFFINITY_409), branch)) as { entries: Array<Record<string, any>> };
			// No history-losing recovery: no recompact, failed-reply edit, fresh checkpoint, or continuation.
			expect(h.v1Calls).toHaveLength(0);
			expect(h.v2Calls).toHaveLength(0);
			expect(boundary).toEqual({
				entries: [{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } }],
			});
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();

			// The next prompt is fail-closed: abort before sending Pi's empty/truncated payload.
			commit(branch, boundary);
			await h.call("before_agent_start", { prompt: "retry" }, branch);
			branch.push(userEntry("retry", "retry"));
			const blocked = (await h.call("before_provider_request", { payload: piPayload(branch) }, branch)) as { input: unknown[] };
			expect(blocked.input).toEqual([]);
			expect(h.aborts).toHaveLength(1);
			expect(JSON.stringify(blocked)).not.toContain(SIGNED.encrypted_content);
			expect(JSON.stringify(blocked)).not.toContain(NATIVE_COMPACTION_FALLBACK_SUMMARY);

			const compact = await h.call(
				"session_before_compact",
				{
					signal: new AbortController().signal,
					preparation: { tokensBefore: 1, firstKeptEntryId: "retry", messagesToSummarize: [], turnPrefixMessages: [] },
				},
				branch,
			);
			expect(compact).toEqual({ cancel: true });
			expect(h.v1Calls).toHaveLength(0);
			expect(h.v2Calls).toHaveLength(0);
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();

			if (label === "content-empty") {
				// Counterexample in the same regression: an empty retained user is safe when
				// the recovered prefix also contains genuine non-text tool history.
				const valid = harness();
				const call = { type: "toolCall", id: "call_nontext|fc_nontext", name: "read", arguments: { path: "a.ts" } };
				const validBranch: Array<Record<string, any>> = [
					{
						type: "message",
						id: "valid-kept",
						timestamp: "2026-10-06T08:00:00.000Z",
						message: { role: "user", content: [], timestamp: 1 },
					},
					{ type: "message", id: "valid-call", message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", content: [call], timestamp: 2 } },
					{ type: "message", id: "valid-result", message: { role: "toolResult", toolCallId: call.id, toolName: "read", isError: false, content: [{ type: "text", text: "file body" }], timestamp: 3 } },
					{ ...compactionEntry("valid-c1", [SIGNED]), firstKeptEntryId: "valid-kept" },
					userEntry("valid-question", "new question"),
				];
				expect(hasSignedItem(await valid.call("before_provider_request", { payload: piPayload(validBranch) }, validBranch))).toBe(true);
				validBranch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
				const validBoundary = (await valid.call("turn_end", turnEnd(AFFINITY_409), validBranch)) as { entries: Array<Record<string, any>> };
				expect(valid.v2Calls).toHaveLength(1);
				expect((valid.v2Calls[0]!.request.input as Array<Record<string, any>>).filter((item) => item.type === "function_call")).toEqual([
					{ type: "function_call", id: "fc_nontext", call_id: "call_nontext", name: "read", arguments: JSON.stringify(call.arguments) },
				]);
				expect((valid.v2Calls[0]!.request.input as Array<Record<string, any>>).filter((item) => item.type === "function_call_output")).toEqual([
					{ type: "function_call_output", call_id: "call_nontext", output: "file body" },
				]);
				expect(validBoundary.entries.filter((entry) => entry.type === "context_edit")).toEqual([{ type: "context_edit", targetId: "failed", replacement: null }]);
				expect(validBoundary.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
				commit(validBranch, validBoundary);
				expect(await valid.call("agent_before_settle", {}, validBranch)).toEqual({ continue: true });
				const resend = JSON.stringify(await valid.call("before_provider_request", { payload: piPayload(validBranch) }, validBranch));
				expect(resend).toContain(FRESH.encrypted_content);
				expect(resend).not.toContain(SIGNED.encrypted_content);
				expect(valid.aborts).toHaveLength(0);
			}
		});
	}

	test("unsupported user/tool-result images, even beside text, fail closed after exact affinity 409; image-capable recovery preserves image data", async () => {
		const image = { type: "image", data: "YQ==", mimeType: "image/png" };
		const imageBranch = (role: "user" | "toolResult", mixed: boolean): Array<Record<string, any>> => [
			userEntry("original", "Original question with an image"),
			...(role === "toolResult" ? [{ type: "message", id: "image-call", message: { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "toolUse", content: [{ type: "toolCall", id: "image_call", name: "read", arguments: { path: "image.png" } }], timestamp: 1 } }] : []),
			{ type: "message", id: "kept", timestamp: "2026-10-06T08:00:00.000Z", message: {
				role, content: [...(mixed ? [{ type: "text", text: "image caption" }] : []), image], timestamp: 1,
				...(role === "toolResult" ? { toolCallId: "image_call", toolName: "read", isError: false } : {}),
			} },
			compactionEntry("c1", [SIGNED]), userEntry("question", "new question"),
		];
		for (const version of ["v1", "v2"] as const) {
			for (const role of ["user", "toolResult"] as const) {
				for (const mixed of [false, true]) {
					const h = harness(true, version);
					const branch = imageBranch(role, mixed);
					expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch) }, branch))).toBe(true);
					branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
					const boundary = await h.call("turn_end", turnEnd(AFFINITY_409), branch);
					expect(boundary).toEqual({ entries: [{ type: "custom", customType: COMPACTION_AFFINITY_RETIRED_ENTRY, data: { compactionEntryId: "c1" } }] });
					expect(h.v1Calls).toHaveLength(0);
					expect(h.v2Calls).toHaveLength(0);
					expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
					commit(branch, boundary);
					await h.call("before_agent_start", { prompt: "retry" }, branch);
					const blocked = await h.call("before_provider_request", { payload: piPayload(branch) }, branch) as { input: unknown[] };
					expect(blocked.input).toEqual([]);
					expect(h.aborts).toHaveLength(1);
					expect(await h.call("session_before_compact", { signal: new AbortController().signal, preparation: { tokensBefore: 1, firstKeptEntryId: "question", messagesToSummarize: [], turnPrefixMessages: [] } }, branch)).toEqual({ cancel: true });
					expect(h.v1Calls).toHaveLength(0);
					expect(h.v2Calls).toHaveLength(0);
					for (const note of h.notes.filter((note) => note.level === "error")) {
						expect(note.text).not.toContain("/compact");
						expect(note.text).toContain("/new");
					}
				}
			}
		}
		// Counterexample belongs to this base-red regression, not a separate green-on-base test.
		const imageModel = { ...model, input: ["text", "image"] };
		for (const role of ["user", "toolResult"] as const) {
			const h = harness(true, "v2", imageModel);
			const branch = imageBranch(role, false);
			expect(hasSignedItem(await h.call("before_provider_request", { payload: piPayload(branch, imageModel) }, branch))).toBe(true);
			branch.push({ type: "message", id: "failed", message: errorTurn(AFFINITY_409) });
			const boundary = await h.call("turn_end", turnEnd(AFFINITY_409), branch);
			expect(h.v2Calls).toHaveLength(1);
			expect(JSON.stringify(h.v2Calls[0]!.request.input)).toContain('"type":"input_image"');
			expect(JSON.stringify(h.v2Calls[0]!.request.input)).toContain("data:image/png;base64,YQ==");
			commit(branch, boundary);
			expect(await h.call("agent_before_settle", {}, branch)).toEqual({ continue: true });
			expect(await h.call("agent_before_settle", {}, branch)).toBeUndefined();
			const resend = JSON.stringify(await h.call("before_provider_request", { payload: piPayload(branch, imageModel) }, branch));
			expect(resend).toContain(FRESH.encrypted_content);
			expect(resend).not.toContain(SIGNED.encrypted_content);
			expect(h.aborts).toHaveLength(0);
			expect(h.v2Calls).toHaveLength(1);
		}
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
		const branch: Array<Record<string, any>> = [userEntry("u0", "Original question"), assistantEntry("a0", "Original answer"), userEntry("kept", "kept"), compactionEntry("c1", [SIGNED]), userEntry("u2", "next")];
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
