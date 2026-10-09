import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, type CompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	resolveLatestNativeCompactionEntry,
	type LatestNativeCompactionResolution,
	type NativeCompactionEntryMatch,
} from "./details-store";
import { extractFreshAuthoritativePreamble } from "./payload-rewrite";
import type { ResponsesCompatibleRequestPayload } from "./runtime";
import { serializeMessagesToResponsesInput } from "./serializer";
import {
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	NATIVE_COMPACTION_STRATEGY,
	NATIVE_COMPACTION_STRATEGY_V2,
	isNativeCompactionEntry,
	type NativeCompactionEntry,
} from "./types";

/**
 * Custom session entry recorded when the gateway answers 409 `compaction_affinity_missing`:
 * it cannot attribute the replayed signed `compaction` item to an account, so that
 * compaction is never replayed again (the entry survives a restart).
 */
export const COMPACTION_AFFINITY_RETIRED_ENTRY = "pi-better-compaction.compaction-affinity-missing";
const AFFINITY_CODE = "compaction_affinity_missing";

/** pi-ai's formatProviderError text for a 409 with a JSON body: "<prefix> (409): {...}" or "409: {...}". */
const STATUS_409_BODY = /^(?:[^\n]*?\(409\):|409:?)\s*(\{[\s\S]*\})\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasAffinityCode(error: unknown): boolean {
	return isRecord(error) && (error.code === AFFINITY_CODE || error.type === AFFINITY_CODE);
}

/** Exactly the gateway's 409 with code `compaction_affinity_missing` at `error.code` or `error.type`. */
export function isCompactionAffinityMissing(message: AgentMessage): boolean {
	if (message.role !== "assistant" || message.stopReason !== "error") return false;
	const match = STATUS_409_BODY.exec(message.errorMessage ?? "");
	if (!match) return false;
	let body: unknown;
	try {
		body = JSON.parse(match[1]!);
	} catch {
		return false;
	}
	// The openai SDK exposes the inner error object; a raw body keeps the `error` envelope.
	return hasAffinityCode(body) || (isRecord(body) && hasAffinityCode(body.error));
}

export function isAffinityRetired(entries: readonly SessionEntry[], compactionEntryId: string): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === COMPACTION_AFFINITY_RETIRED_ENTRY &&
			isRecord(entry.data) &&
			entry.data.compactionEntryId === compactionEntryId,
	);
}

export function hasPlainSummary(entry: NativeCompactionEntry): boolean {
	const summary = entry.summary?.trim();
	return !!summary && summary !== NATIVE_COMPACTION_FALLBACK_SUMMARY;
}

/** Only Responses checkpoints belong to the gateway's account-affinity recovery. */
function isResponsesNativeCompaction(entry: SessionEntry): entry is NativeCompactionEntry {
	return isNativeCompactionEntry(entry) &&
		(entry.details.strategy === NATIVE_COMPACTION_STRATEGY || entry.details.strategy === NATIVE_COMPACTION_STRATEGY_V2);
}

/** Preserve the existing one-window plain-summary resend without recompaction. */
export function canUseAffinityPlainSummary(entries: readonly SessionEntry[], entry: NativeCompactionEntry): boolean {
	return hasPlainSummary(entry) && entries.filter(isResponsesNativeCompaction).length === 1;
}

function chainBranch(entries: readonly SessionEntry[]): SessionEntry[] {
	// getBranch() is root-to-leaf. Removed checkpoints must not leave dangling parents.
	return entries.map((entry, index) => ({ ...entry, parentId: index > 0 ? entries[index - 1]!.id : null }));
}

/** Role presence alone does not prove that the Responses serializer can recover history. */
function hasRecoverableTranscript(messages: AgentMessage[], model?: Pick<Model<Api>, "input">): boolean {
	// Convert Pi's custom messages and summaries exactly as the serializer does,
	// but do not let the wrapper around an empty summary stand in for history.
	const meaningfulSummaries = messages.filter((message) =>
		(message.role !== "compactionSummary" && message.role !== "branchSummary") ||
			(typeof message.summary === "string" && !!message.summary.trim()),
	);
	const llmMessages = convertToLlm(meaningfulSummaries);
	// Reject partial recovery too: text beside an unsupported image cannot preserve history.
	if (model && !model.input.includes("image") && llmMessages.some((message) =>
		(message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) &&
			message.content.some((block) => block.type === "image"),
	)) return false;
	return llmMessages.some((message) => {
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return false;
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) return false;
		if (typeof message.content === "string") return !!message.content.trim();
		return Array.isArray(message.content) && message.content.some((block) => {
			if (!isRecord(block)) return false;
			if (block.type === "text") return typeof block.text === "string" && !!block.text.trim();
			if (block.type === "image") return message.role !== "assistant" &&
				typeof block.data === "string" && !!block.data.trim() && typeof block.mimeType === "string" && !!block.mimeType.trim();
			// Unsigned/unsupported thinking is discarded by Responses serialization.
			return message.role === "assistant" && block.type === "toolCall" &&
				typeof block.id === "string" && !!block.id.trim() && typeof block.name === "string" && !!block.name.trim() &&
				isRecord(block.arguments);
		});
	});
}

/**
 * Expand Responses checkpoints oldest-first, using Pi's projector, not the opaque
 * retained items (which cannot recover assistant answers or tool results).
 * Plain summaries remain usable when an imported branch has no original transcript.
 * Every opaque checkpoint is checked, even one already retired or hidden by a later
 * summary: a retirement marker is not proof that its transcript exists.
 */
function rebuildAffinityBranch(entries: readonly SessionEntry[], model?: Pick<Model<Api>, "input">): SessionEntry[] | undefined {
	const rebuilt: SessionEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.id)) return undefined;
		if (isResponsesNativeCompaction(entry)) {
			const boundaryPresent = seen.has(entry.firstKeptEntryId);
			// A single plain checkpoint needs no reconstruction, even when an import
			// retains only its kept window. Keep its summary for later /compact too.
			const transcriptPresent = !canUseAffinityPlainSummary(entries, entry) && boundaryPresent &&
				hasRecoverableTranscript(buildSessionContext(chainBranch(rebuilt)).messages, model);
			if (!transcriptPresent && !hasPlainSummary(entry)) return undefined;
			if (transcriptPresent) {
				// Keep the ID as a context-free anchor: a later nonnative summary may
				// use this checkpoint as firstKeptEntryId. No signed item or placeholder
				// reaches Pi's projector, and the original chronology remains intact.
				rebuilt.push({
					type: "custom", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
					customType: `${COMPACTION_AFFINITY_RETIRED_ENTRY}.rebuild-anchor`, data: {},
				});
			} else {
				rebuilt.push(entry);
			}
		} else {
			rebuilt.push(entry);
		}
		seen.add(entry.id);
	}
	return chainBranch(rebuilt);
}

export function isAffinityRebuildComplete(entries: readonly SessionEntry[], model?: Pick<Model<Api>, "input">): boolean {
	return rebuildAffinityBranch(entries, model) !== undefined;
}

/** Pi applies nonnative summaries and context edits to the expanded branch once. */
export function buildAffinityRetiredSessionMessages(entries: readonly SessionEntry[], model?: Pick<Model<Api>, "input">): AgentMessage[] {
	const rebuilt = rebuildAffinityBranch(entries, model);
	if (!rebuilt) throw new Error("Cannot recover every opaque Responses compaction from the branch transcript");
	return buildSessionContext(rebuilt).messages;
}

/**
 * The request to send while the latest compaction is retired. A single plain-text
 * summary means Pi's own payload is already safe: `{ ok: true }`. Otherwise the
 * history lives only in the rejected signed item, so send the full branch
 * transcript rather than a payload that silently drops it. `{ ok: false }` when
 * neither is safe (any opaque window has no recoverable transcript, or the
 * request has no recognizable prompt preamble): the caller must send nothing.
 */
export function buildAffinitySafePayload<TApi extends Api>(
	model: Model<TApi>,
	payload: ResponsesCompatibleRequestPayload,
	entries: readonly SessionEntry[],
	entry: NativeCompactionEntry,
): { ok: true; payload?: ResponsesCompatibleRequestPayload } | { ok: false } {
	if (!isAffinityRebuildComplete(entries, model)) return { ok: false };
	if (canUseAffinityPlainSummary(entries, entry)) return { ok: true };
	const preamble = extractFreshAuthoritativePreamble(payload);
	if (!preamble) return { ok: false };
	return { ok: true, payload: {
		...payload,
		...(preamble.instructions !== undefined ? { instructions: preamble.instructions } : {}),
		input: [
			...preamble.leadingInput,
			...serializeMessagesToResponsesInput(model, buildAffinityRetiredSessionMessages(entries, model)),
			...preamble.trailingInput,
		],
	} };
}

/** The latest native compaction for a compaction request, unless the gateway retired it. */
export function resolveReplayableNativeCompaction(
	entries: readonly SessionEntry[],
	match: NativeCompactionEntryMatch,
): LatestNativeCompactionResolution | { ok: false; reason: "affinity-retired"; latestCompactionIndex: number; latestCompaction: CompactionEntry } {
	const latest = resolveLatestNativeCompactionEntry(entries, match);
	return latest.ok && isAffinityRetired(entries, latest.entry.id)
		? { ok: false, reason: "affinity-retired", latestCompactionIndex: latest.index, latestCompaction: latest.entry }
		: latest;
}
