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
	// A summary (even a nonempty one) describes history; it is not the transcript
	// that an opaque window replaced. Convert only genuine transcript messages.
	const llmMessages = convertToLlm(messages.filter((message) =>
		message.role !== "compactionSummary" && message.role !== "branchSummary",
	));
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

/** Never let the serializer manufacture a missing tool result or replay an orphan. */
function hasCompleteToolPairs(messages: AgentMessage[]): boolean {
	const calls = new Map<string, string>();
	const pending = new Set<string>();
	for (const message of convertToLlm(messages)) {
		if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId) || calls.get(message.toolCallId) !== message.toolName) return false;
		} else {
			// Responses inserts synthetic results if another message interrupts the
			// tool batch. A later result does not make that exchange recoverable.
			if (pending.size > 0) return false;
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (message.stopReason === "error" || message.stopReason === "aborted" || !block.id || calls.has(block.id)) return false;
				calls.set(block.id, block.name);
				pending.add(block.id);
			}
		}
	}
	return pending.size === 0;
}

/**
 * Validate original parent links BEFORE chainBranch can repair them. Pi's next
 * compaction window starts at the previous firstKeptEntryId (or session root),
 * not at the previous checkpoint. Include the kept suffix up to the checkpoint:
 * native Responses compaction also replaces assistant answers/tools in that suffix.
 */
function hasCoveredTranscriptWindow(
	entries: readonly SessionEntry[],
	index: number,
	previousCompactionIndex: number | undefined,
	positions: ReadonlyMap<string, number>,
	model?: Pick<Model<Api>, "input">,
): boolean {
	const entry = entries[index] as CompactionEntry;
	const boundary = positions.get(entry.firstKeptEntryId);
	if (boundary === undefined || boundary > index) return false;
	let start = 0;
	if (previousCompactionIndex !== undefined) {
		const previous = entries[previousCompactionIndex] as CompactionEntry;
		const previousBoundary = positions.get(previous.firstKeptEntryId);
		if (previousBoundary === undefined || previousBoundary > previousCompactionIndex) return false;
		// Pi's retain-none sentinel is the checkpoint's own ID.
		start = previousBoundary === previousCompactionIndex ? previousCompactionIndex + 1 : previousBoundary;
	}
	if (boundary < start || start >= index) return false;
	if (previousCompactionIndex === undefined) {
		if (entries[start]!.parentId !== null) return false;
	} else if (start === previousCompactionIndex + 1 && entries[start]!.parentId !== entries[previousCompactionIndex]!.id) {
		return false;
	}
	// The previous kept entry is the trusted start anchor; everything after
	// it, including this checkpoint's parent, must be the original chain.
	for (let at = start + 1; at <= index; at++) {
		if (entries[at]!.parentId !== entries[at - 1]!.id) return false;
	}
	const transcript = entries.slice(start, index).filter((candidate) =>
		candidate.type !== "compaction" && candidate.type !== "branch_summary",
	);
	// Check the stored exchange too: an edit cannot conceal a lost tool result.
	const rawMessages = buildSessionContext(chainBranch(transcript.filter((candidate) => candidate.type !== "context_edit"))).messages;
	if (!hasCompleteToolPairs(rawMessages)) return false;
	const messages = buildSessionContext(chainBranch(transcript)).messages;
	if (!hasRecoverableTranscript(messages, model)) return false;
	// The retained boundary's existence/content is not evidence of replaced
	// history. Require genuine transcript elsewhere in this particular window.
	return hasRecoverableTranscript(buildSessionContext(chainBranch(transcript.filter((candidate) => candidate.id !== entry.firstKeptEntryId))).messages, model);
}

/**
 * Expand Responses checkpoints oldest-first, using Pi's projector, not the opaque
 * retained items (which cannot recover assistant answers or tool results).
 * Only the pre-existing single-window plain-summary shortcut may skip reconstruction.
 * Every other Responses checkpoint needs covered transcript, regardless of summary,
 * retirement markers or later summaries: none proves that its transcript exists.
 */
function rebuildAffinityBranch(entries: readonly SessionEntry[], model?: Pick<Model<Api>, "input">): SessionEntry[] | undefined {
	const rebuilt: SessionEntry[] = [];
	const positions = new Map<string, number>();
	let previousCompactionIndex: number | undefined;
	let expanded = false;
	for (const [index, entry] of entries.entries()) {
		if (!entry.id || positions.has(entry.id)) return undefined;
		positions.set(entry.id, index);
		if (isResponsesNativeCompaction(entry)) {
			// A single plain checkpoint needs no reconstruction, even when an import
			// retains only its kept window. Keep its summary for later /compact too.
			const usePlainSummary = canUseAffinityPlainSummary(entries, entry);
			// Outside that legacy shortcut, a summary can never override failed coverage.
			if (!usePlainSummary && !hasCoveredTranscriptWindow(entries, index, previousCompactionIndex, positions, model)) return undefined;
			if (!usePlainSummary) {
				expanded = true;
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
		if (entry.type === "compaction") previousCompactionIndex = index;
	}
	const branch = chainBranch(rebuilt);
	if (expanded) {
		// Apply all later context edits/nonnative summaries through Pi once, then
		// ensure the actual serialized transcript still has complete exchanges.
		const messages = buildSessionContext(branch).messages;
		if (!hasCompleteToolPairs(messages) || !hasRecoverableTranscript(messages, model)) return undefined;
	}
	return branch;
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
