import { describe, expect, test } from "bun:test";
import { describeUnreadableCheckpoint, registerExtensionRuntime } from "./extension-runtime";
import {
	ANTHROPIC_COMPACTION_STRATEGY,
	createNativeCompactionDetails,
	DEFAULT_EXTENSION_CONFIG,
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	NATIVE_COMPACTION_STRATEGY,
	NATIVE_COMPACTION_STRATEGY_V2,
} from "./types";

const sol = { provider: "openai-proxy", api: "openai-responses", id: "gpt-6.1-sol", baseUrl: "https://relay.example/v1" };
const luna = { ...sol, id: "gpt-6-luna" };
const opus = { provider: "anthropic-proxy", api: "anthropic-messages", id: "claude-opus-5-5", baseUrl: "http://127.0.0.1:8317" };

function compaction(
	id: string,
	model: typeof sol,
	summary = NATIVE_COMPACTION_FALLBACK_SUMMARY,
	strategy: Parameters<typeof createNativeCompactionDetails>[1] = NATIVE_COMPACTION_STRATEGY_V2,
) {
	return {
		type: "compaction",
		id,
		timestamp: "2026-10-03T08:00:00.000Z",
		summary,
		firstKeptEntryId: "kept",
		tokensBefore: 300_000,
		details: createNativeCompactionDetails(
			{
				provider: model.provider,
				api: model.api,
				model: model.id,
				baseUrl: model.baseUrl,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
			},
			strategy,
		),
	};
}

const piCompaction = {
	type: "compaction",
	id: "pi",
	timestamp: "2026-10-03T09:00:00.000Z",
	summary: "## Goal\nreal summary",
	firstKeptEntryId: "kept",
	tokensBefore: 300_000,
	details: { readFiles: [], modifiedFiles: [] },
};

describe("describeUnreadableCheckpoint", () => {
	test("warns when another model meets an opaque OpenAI checkpoint", () => {
		const warning = describeUnreadableCheckpoint([compaction("c1", sol)] as never, opus);
		expect(warning?.key).toBe("c1|anthropic-proxy/claude-opus-5-5");
		expect(warning?.message).toContain("openai-proxy/gpt-6.1-sol");
		expect(warning?.message).toContain("/tree");
		expect(warning?.message).toContain("retained messages");
	});

	test("also warns for another model of the same provider", () => {
		expect(describeUnreadableCheckpoint([compaction("c1", sol)] as never, luna)).toBeDefined();
	});

	test("stays quiet for the checkpoint's own model, including an OAuth endpoint override", () => {
		expect(describeUnreadableCheckpoint([compaction("c1", sol)] as never, sol)).toBeUndefined();
		const oauthModel = { ...sol, baseUrl: "https://oauth.example/v1" };
		expect(describeUnreadableCheckpoint([compaction("c1", sol)] as never, oauthModel)).toBeUndefined();
	});

	test("warns when the same provider/model now uses a different API", () => {
		expect(describeUnreadableCheckpoint([compaction("c1", sol)] as never, {
			...sol, api: "openai-completions",
		})).toBeDefined();
	});

	test("also warns for a V1 checkpoint without an extracted summary", () => {
		expect(describeUnreadableCheckpoint([
			compaction("c1", sol, NATIVE_COMPACTION_FALLBACK_SUMMARY, NATIVE_COMPACTION_STRATEGY),
		] as never, opus)).toBeDefined();
	});

	test("stays quiet when the checkpoint carries a readable summary", () => {
		const withText = compaction("c1", sol, "Extracted summary text");
		expect(describeUnreadableCheckpoint([withText] as never, opus)).toBeUndefined();
		const anthropic = compaction("c2", opus as never, "Signed block content", ANTHROPIC_COMPACTION_STRATEGY);
		expect(describeUnreadableCheckpoint([anthropic] as never, sol)).toBeUndefined();
		const anthropicPlaceholder = compaction("c3", opus, NATIVE_COMPACTION_FALLBACK_SUMMARY, ANTHROPIC_COMPACTION_STRATEGY);
		expect(describeUnreadableCheckpoint([anthropicPlaceholder] as never, sol)).toBeUndefined();
	});

	test("recovery advice accounts for earlier opaque checkpoints", () => {
		const warning = describeUnreadableCheckpoint([compaction("c1", sol), compaction("c2", sol)] as never, opus);
		expect(warning?.message).toContain("before the first incompatible compaction");
		expect(warning?.message).not.toContain("full history");
	});

	test("only the latest compaction counts", () => {
		expect(describeUnreadableCheckpoint([compaction("c1", sol), piCompaction] as never, opus)).toBeUndefined();
		expect(describeUnreadableCheckpoint([compaction("c1", sol), compaction("c2", luna)] as never, luna)).toBeUndefined();
		expect(describeUnreadableCheckpoint([] as never, opus)).toBeUndefined();
		expect(describeUnreadableCheckpoint([compaction("c1", sol)] as never, undefined)).toBeUndefined();
	});
});

describe("model_select", () => {
	function harness(branch: unknown[], options: { hasUI?: boolean; enabled?: boolean } = {}) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerExtensionRuntime(
			{ on: (name: string, handler: never) => handlers.set(name, handler) } as never,
			{
				loadExtensionConfig: () => ({
					config: { ...DEFAULT_EXTENSION_CONFIG, enabled: options.enabled ?? true },
					warnings: [],
				}),
			} as never,
		);
		const notes: Array<{ message: string; level: string }> = [];
		const ctx = {
			model: sol,
			hasUI: options.hasUI ?? true,
			ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
			sessionManager: { getBranch: () => branch },
		};
		const select = (model: typeof sol) => {
			const previousModel = ctx.model;
			ctx.model = model;
			return handlers.get("model_select")!({ type: "model_select", model, previousModel, source: "set" }, ctx);
		};
		const navigate = (nextBranch: unknown[]) => { branch = nextBranch; };
		return { select, navigate, notes };
	}

	test("notifies once per checkpoint and model", () => {
		const h = harness([compaction("c1", sol)]);
		h.select(opus);
		h.select(sol);
		h.select(opus);
		expect(h.notes).toHaveLength(1);
		expect(h.notes[0]!.level).toBe("warning");
		h.select(luna);
		expect(h.notes).toHaveLength(2);
	});

	test("fresh session runtimes do not inherit deduplication for the same checkpoint ID", () => {
		const original = harness([compaction("c1", sol)]);
		original.select(opus);
		// Pi recreates the runtime on resume/fork, whose entries may share IDs.
		const resumed = harness([compaction("c1", sol)]);
		resumed.select(opus);
		expect(original.notes).toHaveLength(1);
		expect(resumed.notes).toHaveLength(1);
	});

	test("model selection follows tree navigation and still deduplicates within the session", () => {
		const h = harness([]);
		h.select(opus);
		expect(h.notes).toHaveLength(0);
		h.navigate([compaction("c1", sol)]);
		h.select(sol);
		h.select(opus);
		expect(h.notes).toHaveLength(1);
		h.navigate([]);
		h.select(luna);
		h.navigate([compaction("c1", sol)]);
		h.select(opus);
		expect(h.notes).toHaveLength(1);
		h.navigate([compaction("c2", sol)]);
		h.select(sol);
		h.select(opus);
		expect(h.notes).toHaveLength(2);
		h.navigate([compaction("c2", sol), piCompaction]);
		h.select(luna);
		expect(h.notes).toHaveLength(2);
	});

	test("is silent without UI or when the extension is disabled", () => {
		const noUi = harness([compaction("c1", sol)], { hasUI: false });
		noUi.select(opus);
		noUi.navigate([compaction("c2", sol)]);
		expect(noUi.notes).toHaveLength(0);
		const disabled = harness([compaction("c1", sol)], { enabled: false });
		disabled.select(opus);
		disabled.navigate([compaction("c2", sol)]);
		expect(disabled.notes).toHaveLength(0);
	});
});
